import { allocateFees, type FeeStage, BRAND } from "@gemdex/core";
import { and, balanceOf, chainTx, emit, eq, feeRuns, getSetting, inArray, post } from "@gemdex/db";
import { sendOnce } from "./chain-tx";
import type { Ctx } from "./ctx";

type Run = typeof feeRuns.$inferSelect;

async function advance(ctx: Ctx, run: Run, stage: FeeStage, patch: Partial<typeof feeRuns.$inferInsert> = {}) {
  await ctx.db.update(feeRuns).set({ ...patch, stage, updatedAt: new Date() }).where(eq(feeRuns.id, run.id));
}

/**
 * Creator fees: claim $CARDS, swap to USDC, split between cashback, drops, the gift pool and buyback. With the smart
 * split on, how much goes where depends on how full the Pulse and gift pools are when the swap lands.
 * Every stage resumes from saved state. Anyone can trigger collection on-chain,
 * so the input is the actual $CARDS balance, not what our own transaction collected.
 */
export async function tickFees(ctx: Ctx): Promise<void> {
  const settings = await getSetting(ctx.db, "fees");
  const open = await ctx.db.select().from(feeRuns).where(inArray(feeRuns.stage, ["PENDING", "COLLECTED", "SWAPPED"])).limit(1);
  let run = open[0];

  if (!run) {
    // pump.fun keeps creator fees in its vaults until they are claimed, so what is waiting there counts as much
    // as $CARDS someone already claimed into the Fee wallet. Counting only the wallet would wait forever.
    const [held, unclaimed] = await Promise.all([ctx.venue.fees.cardsBalance(), ctx.venue.fees.cardsUnclaimed()]);
    if ((await ctx.venue.fees.cardsValue(held + unclaimed)) < settings.minSwapUsd) return;
    const created = await ctx.db.insert(feeRuns).values({ stage: "PENDING" }).returning();
    run = created[0]!;
  }

  if (run.stage === "PENDING") {
    await ctx.venue.fees.assertNoSharingConfig();
    const result = await sendOnce(ctx, "fee_collect", run.id, async () => ({ type: "feeCollect" }), { retryFailed: true });
    if (result.status !== "confirmed") return;
    const cards = await ctx.venue.fees.cardsBalance();
    await advance(ctx, run, "COLLECTED", { cardsIn: cards });
    run = { ...run, stage: "COLLECTED", cardsIn: cards };
  }

  if (run.stage === "COLLECTED") {
    const cardsIn = run.cardsIn ?? 0;
    // Whether the fees are worth swapping is only asked before a swap exists. This stage runs again every minute,
    // and a run starts with its value right at the threshold: asked again after the swap had landed, a price a
    // few cents lower marked the run skipped, and the USDC it had just bought was never booked or shared out.
    const swapping = await ctx.db.select({ id: chainTx.id }).from(chainTx).where(and(eq(chainTx.purpose, "fee_swap"), eq(chainTx.ref, run.id))).limit(1);
    if (!swapping[0] && (await ctx.venue.fees.cardsValue(cardsIn)) < settings.minSwapUsd) return advance(ctx, run, "SKIPPED");
    const result = await sendOnce(ctx, "fee_swap", run.id, async () => {
      // A fresh quote for each attempt, so the floor follows the market rather than an old price.
      const quoted = await ctx.venue.fees.cardsValue(cardsIn);
      return { type: "swap", cardsIn, minOut: Math.floor((quoted * (10_000 - settings.maxSlippageBps)) / 10_000) };
    }, { retryFailed: true });
    if (result.status === "failed") return advance(ctx, run, "COLLECTED", { error: "swap failed, will retry next run" });
    if (result.status !== "confirmed") return;
    const usdcOut = await ctx.venue.fees.usdcReceived(result.signature!);
    await ctx.db.transaction((tx) => post(tx, `fee_in:${run!.id}`, "fee_in", [{ account: "world", delta: -usdcOut }, { account: "fee", delta: usdcOut }]));
    const flywheel = await getSetting(ctx.db, "flywheel");
    // How full the Pulse and gift pools are decides the smart split. It is read once, here, and the split saved with
    // the run, so a retry pays out exactly what was decided even if the pools have moved since.
    const [drops, gifts, reserved] = await Promise.all([balanceOf(ctx.db, "drops"), balanceOf(ctx.db, "gifts"), balanceOf(ctx.db, "gift_reserved")]);
    const split = allocateFees(usdcOut, drops + gifts + reserved, settings.cashbackBps, flywheel);
    const saved = { usdcOut, cashback: split.cashback, drops: split.drops, buyback: split.buyback };
    await advance(ctx, run, "SWAPPED", saved);
    run = { ...run, stage: "SWAPPED", ...saved };
  }

  if (run.stage === "SWAPPED") {
    const { cashback, drops, buyback } = { cashback: run.cashback ?? 0, drops: run.drops ?? 0, buyback: run.buyback ?? 0 };
    // The gift pool is whatever is left. Gifts and buyback money are held in the Drops wallet with the drops money.
    // Runs swapped before the gift pool or the smart split existed leave nothing over, so they pay out as before.
    const gifts = Math.max(0, (run.usdcOut ?? 0) - cashback - drops - buyback);
    const toDrops = drops + gifts + buyback;
    const result = await sendOnce(ctx, "fee_split", run.id, async () => ({ type: "split", cashback, drops: toDrops, memo: `${BRAND.memoPrefix}:fees:${run!.id}` }), { retryFailed: true });
    if (result.status !== "confirmed") return;
    await ctx.db.transaction(async (tx) => {
      await post(tx, `fee_split:${run!.id}`, "fee_split", [
        { account: "fee", delta: -(cashback + toDrops) },
        { account: "cashback", delta: cashback },
        { account: "drops", delta: drops },
        ...(gifts > 0 ? [{ account: "gifts", delta: gifts }] : []),
        // Waits in "revenue" with Pulse sale money for the next buyback and burn.
        ...(buyback > 0 ? [{ account: "revenue", delta: buyback }] : []),
      ]);
      await emit(tx, "status", { type: "feeRun", cashback, drops, gifts, buyback });
    });
    await advance(ctx, run, "DONE");
  }
}
