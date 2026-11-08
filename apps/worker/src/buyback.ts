// Buyback and burn (docs/FLYWHEEL.md): every dollar a winner pays on Pulse buys $TENR at market, then
// that $TENR is burned. Nothing from Pulse sales stays in the wallet.
import { BRAND } from "@gemdex/core";
import { asc, balanceOf, buybacks, desc, emit, eq, getSetting, inArray, post } from "@gemdex/db";
import { role } from "@gemdex/venues";
import { sendOnce } from "./chain-tx";
import type { Ctx } from "./ctx";

type Run = typeof buybacks.$inferSelect;

/** A swap that can't go through for this long gives its money back to wait for the next run. */
const GIVE_UP_MS = 6 * 3_600_000;

async function update(ctx: Ctx, run: Run, patch: Partial<Run>) {
  await ctx.db.update(buybacks).set({ ...patch, updatedAt: new Date() }).where(eq(buybacks.id, run.id));
}

/** Gives a stuck run's money back to `revenue`, so the next run buys with it. */
async function giveUp(ctx: Ctx, run: Run, reason: string) {
  await ctx.db.transaction(async (tx) => {
    await post(tx, `buyback:${run.id}:return`, "buyback_return", [{ account: "buyback_inflight", delta: -run.usdcIn }, { account: "revenue", delta: run.usdcIn }]);
    await tx.update(buybacks).set({ stage: "SKIPPED", error: reason, updatedAt: new Date() }).where(eq(buybacks.id, run.id));
  });
}

export async function tickBuyback(ctx: Ctx, now = Date.now()) {
  const settings = await getSetting(ctx.db, "flywheel");
  // An unfinished run finishes first, even if buybacks were turned off midway: its money is already set aside.
  let run: Run | undefined = (await ctx.db.select().from(buybacks).where(inArray(buybacks.stage, ["PENDING", "SWAPPED"])).orderBy(asc(buybacks.createdAt)).limit(1))[0];

  if (!run) {
    if (!settings.buybackEnabled) return;
    const last = (await ctx.db.select({ at: buybacks.createdAt }).from(buybacks).orderBy(desc(buybacks.createdAt)).limit(1))[0];
    if (last && now - last.at.getTime() < settings.buybackEveryMin * 60_000) return;
    const revenue = await balanceOf(ctx.db, "revenue");
    if (revenue < settings.buybackMinUsd) return;
    // No market to buy from yet (no $TENR mint, or no route): leave the money where it is.
    const quote = await ctx.venue.fees.tenrQuote(revenue).catch(() => 0);
    if (!(quote > 0)) return;
    run = await ctx.db.transaction(async (tx) => {
      const [row] = await tx.insert(buybacks).values({ usdcIn: revenue }).returning();
      // Set aside now, so sales that land during the swap wait for the next run.
      await post(tx, `buyback:${row!.id}:start`, "buyback_start", [{ account: "revenue", delta: -revenue }, { account: "buyback_inflight", delta: revenue }]);
      return row!;
    });
  }

  if (run.stage === "PENDING") {
    if (now - run.createdAt.getTime() > GIVE_UP_MS) return giveUp(ctx, run, "The swap didn't go through in 6 hours, so the money waits for the next run");
    const usdcIn = run.usdcIn;
    const result = await sendOnce(ctx, "buyback_swap", run.id, async () => {
      // A fresh quote each attempt; the swap fails rather than fill worse than the slippage limit.
      const quote = await ctx.venue.fees.tenrQuote(usdcIn);
      return { type: "buyTenr", from: role("drops"), usdcIn, minOut: (quote * (10_000 - settings.buybackMaxSlippageBps)) / 10_000 };
    }, { retryFailed: true });
    if (result.status === "pending") return;
    if (result.status === "failed") return update(ctx, run, { error: "Swap failed, trying again next run" });
    const tenrOut = await ctx.venue.fees.tenrReceived(result.signature!);
    const id = run.id;
    await ctx.db.transaction(async (tx) => {
      // The USDC has left for the market.
      await post(tx, `buyback:${id}:swap`, "buyback_swap", [{ account: "buyback_inflight", delta: -usdcIn }, { account: "world", delta: usdcIn }]);
      await tx.update(buybacks).set({ stage: "SWAPPED", tenrOut, swapSig: result.signature ?? null, error: null, updatedAt: new Date() }).where(eq(buybacks.id, id));
    });
    run = { ...run, stage: "SWAPPED", tenrOut, swapSig: result.signature ?? null };
  }

  if (run.stage === "SWAPPED") {
    const id = run.id;
    const result = await sendOnce(ctx, "buyback_burn", id, async () => ({ type: "burnTenr", owner: role("drops"), memo: `${BRAND.memoPrefix}:burn:${id}` }), { retryFailed: true });
    if (result.status === "failed") {
      // Nothing left to burn means a burn already landed.
      if ((await ctx.venue.fees.tenrHeld()) <= 0) return update(ctx, run, { stage: "DONE" });
      return update(ctx, run, { error: "Burn failed, trying again next run" });
    }
    if (result.status !== "confirmed") return;
    await update(ctx, run, { stage: "DONE", burnSig: result.signature ?? null, error: null });
    await emit(ctx.db, "gifts", { type: "burn", id, usdcIn: run.usdcIn, tenrOut: run.tenrOut });
  }
}
