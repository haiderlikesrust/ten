import { splitSale,
  BRAND, BUYBACK_SAFETY_SEC, BUYBACK_WINDOW_SEC, MAX_PACK_PAY_ATTEMPTS, assertTransition, blendedBurn, intervalSeconds, ladderMix,
  pauseReason, pickMachine, publicDrop, pulseView, usd, type DropState, type MachineEcon, type PauseReason,
} from "@gemdex/core";
import {
  activity, and, balanceOf, ccPacks, chainTx, claims, closeHold, drops, emit, eq, getSetting, holdings, inArray, isNull, loadJson, machines,
  pausedBy, post, saveJson, sql, userAccount, users, type Drop,
} from "@gemdex/db";
import { AddressBlocked, CardFrozen, MachineDown, TxRefused, role, trader, type OpenResult, type Party } from "@gemdex/venues";
import { PACK_REVIEW_MS, REVIEW_CHECK_MS, confirmedSignature, sendOnce, type SendResult } from "./chain-tx";
import type { Ctx } from "./ctx";
import { buildPath } from "./pulse";

export { publicDrop };

type Claim = typeof claims.$inferSelect;

const DUE_STATES: DropState[] = [
  "PLANNED", "PACK_PAID", "OPENING", "IN_VAULT", "CLAIMED", "SETTLING", "EXPIRED",
  "QUOTED", "DEBITING", "PACK_PAYING", "AWAIT_AUTO_REFUND", "REFUND_DUE",
];

const RETRY_MS = 1_000;
const REFUND_CHECK_MS = 60_000;
/** Nothing is reserved or paid before a pack is generated, so an outage this long can skip a revealed drop. */
const GENERATE_GIVE_UP_MS = 10 * 60_000;
/** Each fresh sell-back offer re-checks the quote. Three failed offers stop for a person instead of looping. */
const MAX_SELLBACK_ATTEMPTS = 3;
const PACK_REVIEW = "needs review: CC has not delivered or refunded this pack after 6 hours";

export function toEcon(row: typeof machines.$inferSelect): MachineEcon {
  return {
    code: row.code,
    price: row.price,
    buybackPct: row.buybackPct,
    ev: row.ev,
    commonFloor: usd(row.tiers.common?.start ?? 0),
    open: row.isOpen,
    stock: Object.values(row.stock).reduce((sum, n) => sum + Number(n), 0),
  };
}

/** A revealed card's states before it is for sale: its pack is being bought and opened. */
const NOT_YET_LIVE: DropState[] = ["PLANNED", "PACK_PAID", "OPENING", "IN_VAULT"];

export async function announceDrop(db: Ctx["db"], d: Drop) {
  // The live feed is public. Announcing these steps told anyone listening which pack was coming, and then the card
  // and what it is worth, a moment before the people on the site could see it or buy it.
  if (d.kind === "revealed" && NOT_YET_LIVE.includes(d.state as DropState)) return;
  await emit(db, "drops", { type: "drop", drop: pulseView(d) });
}

const announce = (ctx: Ctx, d: Drop) => announceDrop(ctx.db, d);

/** Compare-and-set on state, so a stale step can never overwrite newer progress. */
async function move(ctx: Ctx, d: Drop, to: DropState, patch: Partial<typeof drops.$inferInsert> = {}): Promise<Drop | null> {
  assertTransition(d.kind, d.state as DropState, to);
  const updated = await ctx.db
    .update(drops)
    .set({ lastError: null, ...patch, state: to, updatedAt: new Date(), leaseUntil: null, nextRunAt: new Date() })
    .where(and(eq(drops.id, d.id), eq(drops.state, d.state)))
    .returning();
  const row = updated[0];
  if (row) await announce(ctx, row);
  return row ?? null;
}

async function later(ctx: Ctx, d: Drop, ms = RETRY_MS, error?: string) {
  await ctx.db
    .update(drops)
    .set({ nextRunAt: new Date(Date.now() + ms), leaseUntil: null, lastError: error ?? null, updatedAt: new Date() })
    .where(eq(drops.id, d.id));
}

async function leaseDue(ctx: Ctx, limit: number): Promise<Drop[]> {
  const leased = await ctx.sql<{ id: string }[]>`
    update drops set lease_until = now() + interval '15 seconds'
    where id in (
      select id from drops
      where state in ${ctx.sql(DUE_STATES)}
        and not (kind = 'hidden' and state = 'EXPIRED')
        and next_run_at <= now()
        and (lease_until is null or lease_until < now())
      order by next_run_at
      limit ${limit}
      for update skip locked
    )
    returning id`;
  if (leased.length === 0) return [];
  return ctx.db.select().from(drops).where(inArray(drops.id, leased.map((row) => row.id)));
}

async function claimOf(ctx: Ctx, d: Drop): Promise<Claim> {
  if (!d.winnerClaimId) throw new Error(`drop ${d.id} has no winner`);
  const rows = await ctx.db.select().from(claims).where(eq(claims.id, d.winnerClaimId));
  return rows[0]!;
}

async function winnerOf(ctx: Ctx, claim: Claim) {
  const rows = await ctx.db.select().from(users).where(eq(users.id, claim.userId));
  return rows[0]!;
}

async function voidClaim(ctx: Ctx, claim: Claim, reason: string, strike: boolean) {
  await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(claims)
      .set({ state: "voided", reason })
      .where(and(eq(claims.id, claim.id), eq(claims.state, "won")))
      .returning({ id: claims.id });
    if (updated.length === 0) return;
    await closeHold(tx, claim.holdId, "released");
    if (strike) await tx.update(users).set({ strikes: sql`${users.strikes} + 1` }).where(eq(users.id, claim.userId));
    await emit(tx, `user:${claim.userId}`, { type: "claim", id: claim.id, dropId: claim.dropId, state: "voided", reason });
  });
}

/**
 * Whether preparing a winner's payment has run out of time. Nothing is signed at that point, so no deadline used
 * to apply: a trading wallet that keeps refusing to sign, or mainnet going unarmed a second after the win, left the
 * win open, the money on hold and the card off sale until someone stepped in. Past the claim's settle time the win
 * is given up instead. Nothing has moved, so that is always safe.
 */
const outOfTime = (claim: Claim): boolean => Date.now() > claim.settleBy.getTime();

/** After a failed claim the drop goes back on sale if there is still time left. */
async function reopen(ctx: Ctx, d: Drop) {
  const live = !!d.expiresAt && d.expiresAt.getTime() > Date.now();
  // A reserved hidden pack names the old winner as recipient, so it must never carry over.
  const stop = { winnerClaimId: null, boughtBy: null, stoppedAt: null };
  const clear = d.kind === "hidden" ? { ...stop, memo: null } : stop;
  if (live) await move(ctx, d, "LIVE", clear);
  else await move(ctx, d, d.kind === "hidden" ? "VOID" : "EXPIRED", clear);
}

// Revealed drops --------------------------------------------------------------

async function ensurePack(ctx: Ctx, d: Drop, deliverTo: string, userId: string | null): Promise<Drop> {
  if (d.memo) return d;
  const generated = await ctx.venue.gacha.generate({ machine: d.machineCode, price: d.packPrice, player: role("drops"), deliverTo });
  await ctx.db.insert(ccPacks).values({
    memo: generated.memo, dropId: d.id, userId, machineCode: d.machineCode, price: d.packPrice, deliverTo, turbo: generated.turbo, raw: generated.raw,
  });
  // Only one run may name the drop's pack. A slow, overlapping run's pack is never paid, so it costs nothing.
  const updated = await ctx.db.update(drops).set({ memo: generated.memo, updatedAt: new Date() }).where(and(eq(drops.id, d.id), isNull(drops.memo))).returning();
  return updated[0] ?? (await ctx.db.select().from(drops).where(eq(drops.id, d.id)))[0]!;
}

async function packOf(ctx: Ctx, memo: string) {
  const pack = (await ctx.db.select().from(ccPacks).where(eq(ccPacks.memo, memo)))[0]!;
  return { pack, overdue: Date.now() - pack.createdAt.getTime() > PACK_REVIEW_MS };
}

/**
 * Opens a paid pack, or returns null after scheduling the next look. Past the review deadline the
 * drop stays where it is, flagged for a person, and CC is asked again only now and then. No state
 * can end it safely: only CC's delivery or refund settles where the money went.
 */
async function openPaid(ctx: Ctx, d: Drop, payer: Party): Promise<Exclude<OpenResult, { status: "waiting" }> | null> {
  const { pack, overdue } = await packOf(ctx, d.memo!);
  let opened: OpenResult;
  try {
    const signature = await confirmedSignature(ctx, "pack", pack.memo);
    opened = await ctx.venue.gacha.open({ memo: pack.memo, machine: pack.machineCode, payer, deliverTo: pack.deliverTo, turbo: pack.turbo, signature });
  } catch (error) {
    if (!overdue) throw error;
    await later(ctx, d, REVIEW_CHECK_MS, `${PACK_REVIEW}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (opened.status !== "waiting") return opened;
  await (overdue ? later(ctx, d, REVIEW_CHECK_MS, PACK_REVIEW) : later(ctx, d));
  return null;
}

/** CC refunds a pack it cannot open on its own schedule. Refunding first could pay twice. */
async function waitForRefund(ctx: Ctx, d: Drop) {
  const { overdue } = await packOf(ctx, d.memo!);
  return overdue ? later(ctx, d, REVIEW_CHECK_MS, PACK_REVIEW) : later(ctx, d, REFUND_CHECK_MS);
}

async function payPack(ctx: Ctx, d: Drop): Promise<SendResult> {
  const packs = await ctx.db.select().from(ccPacks).where(eq(ccPacks.memo, d.memo!));
  const pack = packs[0]!;
  // The Drops wallet also holds the gift pool and the buyback money, so the chain lets this payment through even
  // when the Pulse pool itself is short. The book could then never record it, and the drop sat paid for but stuck.
  // So the book is checked before anything is signed. Once a payment is on its way, it has to finish.
  const started = await ctx.db.select({ id: chainTx.id }).from(chainTx).where(and(eq(chainTx.purpose, "pack"), eq(chainTx.ref, pack.memo))).limit(1);
  if (!started[0] && (await balanceOf(ctx.db, "drops")) < pack.price) return { status: "failed", reason: "the Pulse pool can't cover this pack" };
  const result = await sendOnce(ctx, "pack", pack.memo, async () => ({
    type: "ccPack", payer: role("drops"), amount: pack.price, memo: pack.memo, raw: pack.raw,
  }));
  if (result.status === "confirmed") {
    await ctx.db.transaction(async (tx) => {
      await post(tx, `pack:${pack.memo}`, "pack", [{ account: "drops", delta: -pack.price }, { account: "cc", delta: pack.price }]);
      await tx.update(ccPacks).set({ state: "paid" }).where(eq(ccPacks.memo, pack.memo));
    });
  }
  return result;
}

async function recordOpen(ctx: Ctx, memo: string, result: Extract<OpenResult, { status: "opened" }>) {
  await ctx.db
    .update(ccPacks)
    .set({ state: "opened", nft: result.nft, rarity: result.rarity, insuredValue: result.insuredValue, roll: result.roll, buybackAmount: result.turboBuyback, openedAt: new Date() })
    .where(and(eq(ccPacks.memo, memo), inArray(ccPacks.state, ["reserved", "paid"])));
}

async function stepRevealed(ctx: Ctx, d: Drop) {
  const settings = await getSetting(ctx.db, "drops");
  switch (d.state) {
    case "PLANNED": {
      let current: Drop;
      try {
        current = await ensurePack(ctx, d, ctx.venue.address("vault"), null);
      } catch (error) {
        if (error instanceof MachineDown || error instanceof AddressBlocked) return void (await move(ctx, d, "SKIPPED", { lastError: error.message }));
        if (Date.now() - d.createdAt.getTime() > GENERATE_GIVE_UP_MS) {
          return void (await move(ctx, d, "SKIPPED", { lastError: `CC is not answering: ${error instanceof Error ? error.message : String(error)}` }));
        }
        throw error;
      }
      const result = await payPack(ctx, current);
      if (result.status === "confirmed") await move(ctx, current, "PACK_PAID");
      else if (result.status === "failed") await move(ctx, current, "SKIPPED", { lastError: `pack payment failed${result.reason ? `: ${result.reason}` : ""}` });
      else await later(ctx, current);
      return;
    }
    case "PACK_PAID":
      return void (await move(ctx, d, "OPENING"));
    case "OPENING": {
      const opened = await openPaid(ctx, d, role("drops"));
      if (!opened) return;
      if (opened.status === "refunded") return void (await move(ctx, d, "AWAIT_AUTO_REFUND"));
      await recordOpen(ctx, d.memo!, opened);
      const deadline = new Date(Date.now() + (BUYBACK_WINDOW_SEC - BUYBACK_SAFETY_SEC) * 1000);
      await move(ctx, d, "IN_VAULT", { nft: opened.nft, rarity: opened.rarity, insuredValue: opened.insuredValue, card: opened.card, buybackDeadline: deadline });
      return;
    }
    case "IN_VAULT": {
      // A card CC gives no value cannot be priced. Listing it from the pack price, or from zero, could sell
      // it for far less than it is worth, so it goes straight back to CC instead.
      if (!d.insuredValue) return sellBack(ctx, d);
      const path = buildPath(ctx, { value: d.insuredValue, min: settings.minPrice, crash: [settings.crashLo, settings.crashHi], seconds: settings.ttlSec });
      const now = new Date();
      await move(ctx, d, "LIVE", { path, price: path[0]!, opensAt: now, expiresAt: new Date(now.getTime() + (settings.ttlSec + settings.lockedHoldSec) * 1000) });
      return;
    }
    case "CLAIMED": {
      const claim = await claimOf(ctx, d);
      const winner = await winnerOf(ctx, claim);
      let prepared;
      try {
        prepared = await ctx.venue.chain.prepare({
          type: "settle", buyer: trader(winner.id, winner.tradingWallet), amount: claim.price, nft: d.nft!, deliverTo: claim.deliverTo, memo: `${BRAND.memoPrefix}:${d.id}`,
        });
      } catch (error) {
        if (error instanceof CardFrozen) {
          // Not the winner's fault and it will not fix itself, so release them and drop it from sale.
          await voidClaim(ctx, claim, "This card was frozen by Collector Crypt", false);
          return void (await move(ctx, d, "EXPIRED", { winnerClaimId: null, boughtBy: null, stoppedAt: null, lastError: error.message }));
        }
        if (!outOfTime(claim)) throw error;
        // No strike: whatever stopped this, nothing shows the winner did.
        await voidClaim(ctx, claim, "This purchase could not be completed. Nothing was charged.", false);
        return reopen(ctx, d);
      }
      // Exported keys can move funds at any moment, so the book alone cannot be trusted here.
      const check = await ctx.venue.chain.simulate(prepared.raw);
      if (!check.ok) {
        await voidClaim(ctx, claim, check.reason ?? "simulation failed", true);
        return reopen(ctx, d);
      }
      return void (await move(ctx, d, "SETTLING"));
    }
    case "SETTLING": {
      const claim = await claimOf(ctx, d);
      const winner = await winnerOf(ctx, claim);
      const result = await sendOnce(ctx, "settle", claim.id, async () => ({
        type: "settle", buyer: trader(winner.id, winner.tradingWallet), amount: claim.price, nft: d.nft!, deliverTo: claim.deliverTo, memo: `${BRAND.memoPrefix}:${d.id}`,
      }), { deadlineAt: claim.settleBy });
      if (result.status === "pending") return later(ctx, d);
      if (result.status === "failed") {
        // A reason means nothing was ever signed, so nothing shows the winner did anything wrong: no strike.
        await voidClaim(ctx, claim, result.reason ? "This purchase could not be completed. Nothing was charged." : "settlement failed", !result.reason);
        return reopen(ctx, d);
      }
      await finishWin(ctx, d, claim, "SETTLED", d.nft!, d.card ?? {}, d.insuredValue);
      return;
    }
    case "EXPIRED": {
      return sellBack(ctx, d);
    }
    case "AWAIT_AUTO_REFUND": {
      if (!(await ctx.venue.gacha.refunded(d.memo!))) return waitForRefund(ctx, d);
      await ctx.db.transaction((tx) => post(tx, `refund:${d.memo}`, "pack_refund", [{ account: "cc", delta: -d.packPrice }, { account: "drops", delta: d.packPrice }]));
      return void (await move(ctx, d, "REFUNDED"));
    }
  }
}

/** Unsold cards go back to CC, which returns most of the pack price to the treasury. */
async function sellBack(ctx: Ctx, d: Drop) {
  const result = await sendOnce(ctx, "buyback", d.id, async () => {
    // The window can close, or the card be sold, between offers, so each fresh one checks again.
    const quote = await ctx.venue.gacha.buybackQuote(d.nft!);
    if (!quote.available) throw new TxRefused("CC will not buy this card back");
    const built = await ctx.venue.gacha.buildBuyback({ owner: role("vault"), nft: d.nft!, recipient: role("drops") });
    await ctx.db.update(drops).set({ soldBackFor: built.amount }).where(eq(drops.id, d.id));
    return { type: "ccBuyback", owner: role("vault"), recipient: role("drops"), nft: d.nft!, amount: built.amount, raw: built.raw };
  }, { retryFailed: true, maxAttempts: MAX_SELLBACK_ATTEMPTS });
  if (result.status === "pending") return later(ctx, d);
  if (result.status === "failed") {
    // The card stays in the Vault, flagged for a person, and is looked at again now and then.
    if (result.reason) return later(ctx, d, REVIEW_CHECK_MS, `needs review: sell-back stopped (${result.reason})`);
    return later(ctx, d, 30_000, "buyback failed, will retry");
  }
  const saved = await ctx.db.select({ amount: drops.soldBackFor }).from(drops).where(eq(drops.id, d.id));
  const amount = saved[0]?.amount ?? 0;
  await ctx.db.transaction((tx) => post(tx, `buyback:${d.id}`, "buyback", [{ account: "cc", delta: -amount }, { account: "drops", delta: amount }]));
  await move(ctx, d, "BOUGHT_BACK");
}

async function finishWin(ctx: Ctx, d: Drop, claim: Claim, state: "SETTLED" | "DELIVERED", nft: string, card: Record<string, unknown>, insuredValue: number | null) {
  const quote = await ctx.venue.gacha.buybackQuote(nft).catch(() => null);
  const sale = splitSale(claim.price, (await getSetting(ctx.db, "flywheel")).saleBuybackBps);
  const done = await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(drops)
      .set({ state, nft, card, insuredValue, updatedAt: new Date(), leaseUntil: null })
      .where(and(eq(drops.id, d.id), eq(drops.state, d.state)))
      .returning();
    if (updated.length === 0) return null;
    // Part of every Pulse sale buys and burns $TENR; the rest refills the drops pool (docs/FLYWHEEL.md).
    await post(tx, `settle:${claim.id}`, "snipe", [
      { account: userAccount(claim.userId), delta: -claim.price },
      { account: "revenue", delta: sale.buyback },
      { account: "drops", delta: sale.drops },
    ].filter((leg) => leg.delta !== 0));
    await closeHold(tx, claim.holdId, "captured");
    await tx.update(claims).set({ state: "settled" }).where(eq(claims.id, claim.id));
    await tx.update(users).set({ lastWinAt: new Date() }).where(eq(users.id, claim.userId));
    await tx.insert(holdings).values({
      userId: claim.userId, nft, wallet: "connected", card, source: "drop", cost: claim.price, insuredValue,
      buybackUntil: quote?.expiresAt ?? null, buybackAmount: quote?.amount ?? null,
    });
    await tx.insert(activity).values({ userId: claim.userId, kind: "snipe", title: `Sniped ${String(card.name ?? "a card")}`, delta: -claim.price, ref: d.id });
    await emit(tx, `user:${claim.userId}`, { type: "claim", id: claim.id, dropId: d.id, state: "settled", drop: pulseView(updated[0]!) });
    return updated[0]!;
  });
  if (done) {
    await announce(ctx, done);
    await emit(ctx.db, "wins", { type: "win", dropId: d.id, number: d.number, kind: d.kind, price: claim.price, insuredValue, card, machineCode: d.machineCode, at: new Date() });
  }
}

// Hidden drops ----------------------------------------------------------------

async function stepHidden(ctx: Ctx, d: Drop) {
  const claim = await claimOf(ctx, d);
  const winner = await winnerOf(ctx, claim);
  const buyer = trader(winner.id, winner.tradingWallet);

  switch (d.state) {
    case "CLAIMED":
    case "QUOTED": {
      // Reserving the pack first proves the machine is up before any user money moves.
      let current: Drop;
      try {
        current = await ensurePack(ctx, d, claim.deliverTo, claim.userId);
      } catch (error) {
        if (error instanceof MachineDown || error instanceof AddressBlocked) {
          // The winner already paid for a pack that burned. Voiding now would keep their money, so refund them.
          if (d.packPayAttempts > 0) return void (await move(ctx, d, "REFUND_DUE", { lastError: error.message }));
          await voidClaim(ctx, claim, error.message, false);
          return void (await move(ctx, d, "VOID", { lastError: error.message }));
        }
        throw error;
      }
      if (d.state === "CLAIMED") return void (await move(ctx, current, "QUOTED"));
      // A retry after a burned pack: the winner has already paid, so skip straight past the checks.
      if (d.packPayAttempts > 0) return void (await move(ctx, current, "DEBITING"));

      let prepared;
      try {
        prepared = await ctx.venue.chain.prepare({ type: "usdc", from: buyer, to: role("drops"), amount: claim.price, memo: `${BRAND.memoPrefix}:${d.id}` });
      } catch (error) {
        if (!outOfTime(claim)) throw error;
        await voidClaim(ctx, claim, "This purchase could not be completed. Nothing was charged.", false);
        return reopen(ctx, current);
      }
      const check = await ctx.venue.chain.simulate(prepared.raw);
      if (!check.ok) {
        // Nothing has moved yet, so the drop simply goes back on sale.
        await voidClaim(ctx, claim, check.reason ?? "simulation failed", true);
        return reopen(ctx, current);
      }
      return void (await move(ctx, current, "DEBITING"));
    }
    case "DEBITING": {
      const result = await sendOnce(ctx, "debit", claim.id, async () => ({
        type: "usdc", from: buyer, to: role("drops"), amount: claim.price, memo: `${BRAND.memoPrefix}:${d.id}`,
      }), { deadlineAt: claim.settleBy });
      if (result.status === "pending") return later(ctx, d);
      if (result.status === "failed") {
        await voidClaim(ctx, claim, result.reason ? "This purchase could not be completed. Nothing was charged." : "payment failed", !result.reason);
        return reopen(ctx, d);
      }
      await ctx.db.transaction(async (tx) => {
        await post(tx, `settle:${claim.id}`, "snipe", [{ account: userAccount(claim.userId), delta: -claim.price }, { account: "drops", delta: claim.price }]);
        await closeHold(tx, claim.holdId, "captured");
      });
      return void (await move(ctx, d, "PACK_PAYING"));
    }
    case "PACK_PAYING": {
      const result = await payPack(ctx, d);
      if (result.status === "confirmed") return void (await move(ctx, d, "OPENING"));
      if (result.status === "pending") return later(ctx, d);
      // The reserved pack is burned. Try a fresh one a few times, then refund the winner.
      const attempts = d.packPayAttempts + 1;
      if (attempts >= MAX_PACK_PAY_ATTEMPTS) return void (await move(ctx, d, "REFUND_DUE", { packPayAttempts: attempts }));
      return void (await move(ctx, d, "QUOTED", { memo: null, packPayAttempts: attempts }));
    }
    case "OPENING": {
      const opened = await openPaid(ctx, d, role("drops"));
      if (!opened) return;
      if (opened.status === "refunded") return void (await move(ctx, d, "AWAIT_AUTO_REFUND"));
      await recordOpen(ctx, d.memo!, opened);
      // Drop money was already debited above, so only the delivery is recorded here.
      await deliverHidden(ctx, d, claim, opened);
      return;
    }
    case "AWAIT_AUTO_REFUND": {
      // Refunding before CC does could leave the winner with both a card and their money.
      if (!(await ctx.venue.gacha.refunded(d.memo!))) return waitForRefund(ctx, d);
      await ctx.db.transaction((tx) => post(tx, `refund:${d.memo}`, "pack_refund", [{ account: "cc", delta: -d.packPrice }, { account: "drops", delta: d.packPrice }]));
      return void (await move(ctx, d, "REFUND_DUE"));
    }
    case "REFUND_DUE": {
      const result = await sendOnce(ctx, "refund", claim.id, async () => ({
        type: "usdc", from: role("drops"), to: buyer, amount: claim.price, memo: `${BRAND.memoPrefix}:refund:${d.id}`,
      }), { retryFailed: true });
      if (result.status === "pending") return later(ctx, d);
      if (result.status === "failed") return later(ctx, d, 30_000, "refund failed, will retry");
      await ctx.db.transaction(async (tx) => {
        await post(tx, `snipe_refund:${claim.id}`, "snipe_refund", [{ account: "drops", delta: -claim.price }, { account: userAccount(claim.userId), delta: claim.price }]);
        await tx.update(claims).set({ state: "refunded" }).where(eq(claims.id, claim.id));
        await tx.insert(activity).values({ userId: claim.userId, kind: "refund", title: `Refunded drop #${d.number}`, delta: claim.price, ref: d.id });
        await emit(tx, `user:${claim.userId}`, { type: "claim", id: claim.id, dropId: d.id, state: "refunded" });
      });
      return void (await move(ctx, d, "REFUNDED"));
    }
  }
}

async function deliverHidden(ctx: Ctx, d: Drop, claim: Claim, opened: Extract<OpenResult, { status: "opened" }>) {
  const quote = opened.nft ? await ctx.venue.gacha.buybackQuote(opened.nft).catch(() => null) : null;
  const sale = splitSale(claim.price, (await getSetting(ctx.db, "flywheel")).saleBuybackBps);
  const done = await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(drops)
      .set({ state: "DELIVERED", nft: opened.nft, card: opened.card, rarity: opened.rarity, insuredValue: opened.insuredValue, updatedAt: new Date(), leaseUntil: null })
      .where(and(eq(drops.id, d.id), eq(drops.state, "OPENING")))
      .returning();
    if (updated.length === 0) return null;
    await tx.update(claims).set({ state: "settled" }).where(eq(claims.id, claim.id));
    await tx.update(users).set({ lastWinAt: new Date() }).where(eq(users.id, claim.userId));
    await tx.insert(holdings).values({
      userId: claim.userId, nft: opened.nft ?? `sealed-${d.id}`, wallet: "connected", card: opened.card, source: "drop", cost: claim.price,
      insuredValue: opened.insuredValue, buybackUntil: quote?.expiresAt ?? null, buybackAmount: quote?.amount ?? null,
    });
    await tx.insert(activity).values({ userId: claim.userId, kind: "snipe", title: `Sniped ${String(opened.card.name ?? "a hidden pack")}`, delta: -claim.price, ref: d.id });
    // Delivered, so the sale is final: the buyback share moves from drops to buyback and burn.
    if (sale.buyback > 0) await post(tx, `revenue:${claim.id}`, "pulse_sale", [{ account: "drops", delta: -sale.buyback }, { account: "revenue", delta: sale.buyback }]);
    await emit(tx, `user:${claim.userId}`, { type: "claim", id: claim.id, dropId: d.id, state: "settled", drop: pulseView(updated[0]!) });
    return updated[0]!;
  });
  if (done) {
    await announce(ctx, done);
    await emit(ctx.db, "wins", { type: "win", dropId: d.id, number: d.number, kind: d.kind, price: claim.price, insuredValue: opened.insuredValue, card: opened.card, machineCode: d.machineCode, at: new Date() });
  }
}

// Scheduler and runner ---------------------------------------------------------

export interface DropsStatus {
  nextDropAt: string | null;
  pausedFor: PauseReason | "no_budget" | "no_machines" | null;
  intervalSec: number | null;
  burnPerDrop: number;
  budgetPerDay: number;
  dropsBalance: number;
  spent24h: number;
}

async function rolling24h(ctx: Ctx) {
  // Money an admin moves in or out by hand is not Pulse spending: a sweep must not trip the daily cap for a day,
  // and a top-up must not hide what Pulse really spent.
  const rows = await ctx.sql<{ spent: string; income: string }[]>`
    select
      coalesce(sum(case when b.reason not in ('fee_split', 'seed', 'treasury_deposit', 'treasury_withdrawal') then -e.delta else 0 end), 0) as spent,
      coalesce(sum(case when b.reason = 'fee_split' then e.delta else 0 end), 0) as income
    from ledger_entries e join ledger_batches b on b.ref = e.ref
    where e.account = 'drops' and e.created_at > now() - interval '24 hours'`;
  return { spent: Math.max(0, Number(rows[0]?.spent ?? 0)), income: Number(rows[0]?.income ?? 0) };
}

/**
 * Money the Drops pool has promised but not paid out yet, so it can't be spent twice:
 * - a revealed drop's pack, until it is paid;
 * - a sealed drop's pack, bought when someone wins it;
 * - the buyback share of a sealed sale, which leaves the pool when the card is delivered;
 * - a winner's refund, while a sealed drop is being refunded.
 * Leaving out the last two let the scheduler open one more pack with dollars the pool already owed. The delivery
 * or refund then could not be booked, and the winner's claim stayed open.
 */
export async function promisedToPacks(ctx: Ctx): Promise<number> {
  const { saleBuybackBps } = await getSetting(ctx.db, "flywheel");
  const rows = await ctx.sql<{ total: string }[]>`
    select coalesce(sum(case
      when kind = 'revealed' and state = 'PLANNED' then pack_price
      when kind = 'hidden' and state = 'LIVE' then pack_price
      when kind = 'hidden' and state in ('CLAIMED', 'QUOTED', 'DEBITING', 'PACK_PAYING') then pack_price + floor(coalesce(price, 0) * ${saleBuybackBps}::numeric / 10000)
      when kind = 'hidden' and state = 'OPENING' then floor(coalesce(price, 0) * ${saleBuybackBps}::numeric / 10000)
      when kind = 'hidden' and state in ('AWAIT_AUTO_REFUND', 'REFUND_DUE') then coalesce(price, 0)
      else 0 end), 0) as total
    from drops
    where state in ('PLANNED', 'LIVE', 'CLAIMED', 'QUOTED', 'DEBITING', 'PACK_PAYING', 'OPENING', 'AWAIT_AUTO_REFUND', 'REFUND_DUE')`;
  return Number(rows[0]?.total ?? 0);
}

async function lastPackPrice(ctx: Ctx): Promise<number | null> {
  const rows = await ctx.db.select({ price: drops.packPrice }).from(drops).orderBy(sql`${drops.createdAt} desc`).limit(1);
  return rows[0]?.price ?? null;
}

export async function tickScheduler(ctx: Ctx): Promise<DropsStatus> {
  const [settings, ops, rows, saved] = await Promise.all([
    getSetting(ctx.db, "drops"),
    getSetting(ctx.db, "ops"),
    ctx.db.select().from(machines),
    loadJson<DropsStatus>(ctx.db, "dropsStatus"),
  ]);
  const econ = rows.map(toEcon);
  const [{ spent, income }, dropsBalance, promised, lastPrice] = await Promise.all([rolling24h(ctx), balanceOf(ctx.db, "drops"), promisedToPacks(ctx), lastPackPrice(ctx)]);
  // On mainnet nothing can be signed outside an armed window. A card dropped then could not be paid for or bought:
  // shown cards queued up unpaid, and sealed ones went live with nobody able to buy them.
  const notArmed = pausedBy(ops, ctx.venue.mode) === "not_armed";
  const paused = pauseReason({ enabled: settings.enabled, killSwitch: ops.killSwitch, notArmed, reconcileHold: ops.reconcileHold, dropsBalance, spent24h: spent, settings });

  // Only free money decides which sizes can open, so packs already promised can't be paid for twice and the pool
  // never goes under the floor. A bigger pool unlocks bigger sizes, mixed in by weight. A size also has to fit in
  // what is left of today's spend cap, so one big pack can't carry the day far past it.
  const free = dropsBalance - settings.walletFloor - promised;
  const room = settings.dailySpendCap - spent;
  const mix = ladderMix(settings.ladder, econ, free, lastPrice, room);

  // Rolling income starts at zero, so a small first fee run must not stretch the gap to days.
  // The fallback sets the minimum pace, and the ladder and daily cap still bound spend.
  const budgetPerDay = Math.max(income, settings.budgetPerDayFallback);
  const burnPerDrop = blendedBurn(mix, econ, settings);
  const interval = intervalSeconds(burnPerDrop, budgetPerDay, settings.intervalFloorSec);
  const status: DropsStatus = {
    nextDropAt: saved?.nextDropAt ?? null,
    pausedFor: paused,
    intervalSec: Number.isFinite(interval) ? interval : null,
    burnPerDrop,
    budgetPerDay,
    dropsBalance,
    spent24h: spent,
  };

  if (!Number.isFinite(interval)) status.pausedFor = "no_budget";
  // A bigger budget should take effect now, not after the old, longer wait runs out.
  const soonest = Date.now() + interval * 1000;
  if (status.nextDropAt && Number.isFinite(soonest) && new Date(status.nextDropAt).getTime() > soonest) status.nextDropAt = new Date(soonest).toISOString();
  const due = !status.nextDropAt || new Date(status.nextDropAt).getTime() <= Date.now();
  if (!status.pausedFor && mix.length === 0) {
    // Nothing fits: today's cap has no room left for any size the pool could open, or the pool can't cover the
    // smallest open size yet, or no size has a machine that can sell.
    status.pausedFor = ladderMix(settings.ladder, econ, free, null).length > 0 ? "daily_cap"
      : ladderMix(settings.ladder, econ, Number.MAX_SAFE_INTEGER, null).length > 0 ? "wallet_floor" : "no_machines";
  }
  if (!status.pausedFor && due) {
    const machine = pickMachine(mix, econ, ctx.rng());
    if (!machine) status.pausedFor = "no_machines";
    else {
      await createDrop(ctx, machine, settings);
      status.nextDropAt = new Date(Date.now() + interval * 1000).toISOString();
    }
  }
  await saveJson(ctx.db, "dropsStatus", status);
  await emit(ctx.db, "status", { type: "dropsStatus", status });
  return status;
}

export async function createDrop(ctx: Ctx, machine: MachineEcon, settings: Awaited<ReturnType<typeof getSetting<"drops">>>) {
  // A sealed pack promises less than any card it could hold, so its price stays under the machine's lowest value.
  // Its price also can't pass maxPrice, so a pack that costs more is always shown: sealed, it would lose the difference.
  const hiddenCap = Math.min(settings.maxPrice, machine.commonFloor - settings.ivMargin);
  const hidden = machine.price <= settings.maxPrice && ctx.rng() < settings.hiddenShare && hiddenCap >= settings.minPrice;
  const base = { machineCode: machine.code, packPrice: machine.price, commonFloor: machine.commonFloor };
  if (hidden) {
    const now = new Date();
    // Opens under its ceiling, so it has room to run like any other card.
    const path = buildPath(ctx, { value: Math.round(hiddenCap * 0.8), min: settings.minPrice, max: hiddenCap, crash: [settings.crashLo, settings.crashHi], seconds: settings.ttlSec });
    const created = await ctx.db
      .insert(drops)
      .values({ ...base, kind: "hidden", state: "LIVE", path, price: path[0]!, opensAt: now, expiresAt: new Date(now.getTime() + (settings.ttlSec + settings.lockedHoldSec) * 1000) })
      .returning();
    await announce(ctx, created[0]!);
    return created[0]!;
  }
  const created = await ctx.db.insert(drops).values({ ...base, kind: "revealed", state: "PLANNED" }).returning();
  return created[0]!;
}

/** Expiry only ever touches LIVE, so it can never race a settlement already in flight. */
export async function expireLive(ctx: Ctx): Promise<void> {
  const expired = await ctx.db
    .update(drops)
    .set({ state: "EXPIRED", updatedAt: new Date(), nextRunAt: new Date() })
    .where(and(eq(drops.state, "LIVE"), sql`${drops.expiresAt} < now()`))
    .returning();
  for (const d of expired) await announce(ctx, d);
}

export async function tickDrops(ctx: Ctx): Promise<number> {
  await expireLive(ctx);
  const due = await leaseDue(ctx, 25);
  await Promise.all(
    due.map(async (d) => {
      try {
        if (d.kind === "revealed") await stepRevealed(ctx, d);
        else await stepHidden(ctx, d);
      } catch (error) {
        ctx.log(`drop ${d.number} ${d.state} failed`, error instanceof Error ? error.message : error);
        await later(ctx, d, 2_000, error instanceof Error ? error.message : String(error));
      }
    }),
  );
  return due.length;
}
