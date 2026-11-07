import { generatePath, priceAt, type Micros, type PathInput } from "@gemdex/core";
import { and, claimDrop, dropLimits, drops, emit, eq, inArray, paperChain, post, sql, type Drop } from "@gemdex/db";
import type { PaperVenue } from "@gemdex/venues";
import type { Ctx } from "./ctx";

const WALLET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function fakeWallet(rng: () => number): string {
  return Array.from({ length: 44 }, () => WALLET[Math.floor(rng() * WALLET.length)]).join("");
}

export function buildPath(ctx: Ctx, input: Omit<PathInput, "rng">) {
  return generatePath({ ...input, rng: ctx.rng });
}

const nowPrice = (d: Drop, at: number): Micros => (d.path?.length && d.opensAt ? priceAt(d.path, d.opensAt.getTime(), at) : d.price ?? 0);

const LIMIT_WAITS = new Set<string>(["cooldown", "active_claim", "price_moved", "drops_paused"]);

/** Auto-buy orders: a user asks to buy if the price falls to their number. */
async function runLimits(ctx: Ctx, live: Drop[], at: number) {
  if (live.length === 0) return;
  const limits = await ctx.db.select().from(dropLimits).where(and(eq(dropLimits.state, "open"), inArray(dropLimits.dropId, live.map((d) => d.id))));
  for (const limit of limits) {
    const drop = live.find((d) => d.id === limit.dropId);
    if (!drop || nowPrice(drop, at) > limit.maxPrice) continue;
    const result = await claimDrop(ctx.db, { userId: limit.userId, dropId: limit.dropId, idempotencyKey: `limit:${limit.id}`, maxPrice: limit.maxPrice });
    // These pass on their own, so the order stays open and tries again next tick.
    if (result.status === "rejected" && LIMIT_WAITS.has(result.reason)) continue;
    const state = result.status === "won" ? "filled" : "failed";
    await ctx.db.update(dropLimits).set({ state }).where(eq(dropLimits.id, limit.id));
    await emit(ctx.db, `user:${limit.userId}`, { type: "autoBuy", dropId: limit.dropId, state });
  }
}

/**
 * Paper only: stand-in buyers, so cards sell with nobody else online.
 * This must never run with real money. A fake buyer on a real listing is fraud.
 */
async function simulateBuyers(ctx: Ctx, live: Drop[], at: number) {
  const paper = ctx.venue as PaperVenue;
  for (const drop of live) {
    if (drop.kind !== "revealed" || !drop.insuredValue || !drop.opensAt) continue;
    const price = nowPrice(drop, at);
    const age = (at - drop.opensAt.getTime()) / 1000;
    const share = price / drop.insuredValue;
    const chance = age < 8 ? 0 : share < 0.4 ? 0.025 : share < 0.7 ? 0.012 : share < 1 ? 0.003 : 0.0004;
    if (ctx.rng() >= chance) continue;
    const buyer = fakeWallet(ctx.rng);
    const bought = await ctx.db.transaction(async (tx) => {
      const rows = await tx
        .update(drops)
        .set({ state: "SETTLED", price, boughtBy: buyer, stoppedAt: new Date(at), simBuyer: true, updatedAt: new Date(at) })
        .where(and(eq(drops.id, drop.id), eq(drops.state, "LIVE")))
        .returning();
      if (rows.length === 0) return null;
      await post(tx, `sim_sale:${drop.id}`, "sim_sale", [{ account: "world", delta: -price }, { account: "drops", delta: price }]);
      await tx
        .insert(paperChain)
        .values({ account: "drops", micros: price })
        .onConflictDoUpdate({ target: paperChain.account, set: { micros: sql`${paperChain.micros} + ${price}` } });
      return rows[0]!;
    });
    if (bought) await ctx.announce(bought);
    void paper;
  }
}

export async function tickPulse(ctx: Ctx): Promise<void> {
  const at = Date.now();
  const live = await ctx.db.select().from(drops).where(eq(drops.state, "LIVE"));
  await runLimits(ctx, live, at);
  if (ctx.venue.mode === "paper") await simulateBuyers(ctx, live, at);
  const rows = await ctx.db.select().from(drops).where(eq(drops.state, "LIVE"));
  const items = rows.filter((d) => d.path?.length && d.opensAt && at - d.opensAt.getTime() <= d.path.length * 1000 + 2000).map((d) => ({ id: d.id, p: nowPrice(d, at) }));
  if (items.length > 0) await emit(ctx.db, "drops", { type: "prices", items, at: new Date(at) });
}
