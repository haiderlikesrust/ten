import { splitFees, type FeeStage, BRAND } from "@gemdex/core";
import { emit, eq, feeRuns, getSetting, inArray, post } from "@gemdex/db";
import { sendOnce } from "./chain-tx";
import type { Ctx } from "./ctx";

type Run = typeof feeRuns.$inferSelect;

async function advance(ctx: Ctx, run: Run, stage: FeeStage, patch: Partial<typeof feeRuns.$inferInsert> = {}) {
  await ctx.db.update(feeRuns).set({ ...patch, stage, updatedAt: new Date() }).where(eq(feeRuns.id, run.id));
}

/**
 * Creator fees: collect $CARDS, swap to USDC, split 30/70.
 * Every stage resumes from saved state. Anyone can trigger collection on-chain,
 * so the input is the actual $CARDS balance, not what our own transaction collected.
 */
export async function tickFees(ctx: Ctx): Promise<void> {
  const settings = await getSetting(ctx.db, "fees");
  const open = await ctx.db.select().from(feeRuns).where(inArray(feeRuns.stage, ["PENDING", "COLLECTED", "SWAPPED"])).limit(1);
  let run = open[0];

  if (!run) {
    const cards = await ctx.venue.fees.cardsBalance();
    if ((await ctx.venue.fees.cardsValue(cards)) < settings.minSwapUsd) return;
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
    const quoted = await ctx.venue.fees.cardsValue(cardsIn);
    if (quoted < settings.minSwapUsd) return advance(ctx, run, "SKIPPED");
    const minOut = Math.floor((quoted * (10_000 - settings.maxSlippageBps)) / 10_000);
    const result = await sendOnce(ctx, "fee_swap", run.id, async () => ({ type: "swap", cardsIn, minOut }), { retryFailed: true });
    if (result.status === "failed") return advance(ctx, run, "COLLECTED", { error: "swap failed, will retry next run" });
    if (result.status !== "confirmed") return;
    const usdcOut = await ctx.venue.fees.usdcReceived(result.signature!);
    await ctx.db.transaction((tx) => post(tx, `fee_in:${run!.id}`, "fee_in", [{ account: "world", delta: -usdcOut }, { account: "fee", delta: usdcOut }]));
    const split = splitFees(usdcOut, settings.cashbackBps);
    await advance(ctx, run, "SWAPPED", { usdcOut, cashback: split.cashback, drops: split.drops });
    run = { ...run, stage: "SWAPPED", usdcOut, cashback: split.cashback, drops: split.drops };
  }

  if (run.stage === "SWAPPED") {
    const { cashback, drops } = { cashback: run.cashback ?? 0, drops: run.drops ?? 0 };
    const result = await sendOnce(ctx, "fee_split", run.id, async () => ({ type: "split", cashback, drops, memo: `${BRAND.memoPrefix}:fees:${run!.id}` }), { retryFailed: true });
    if (result.status !== "confirmed") return;
    await ctx.db.transaction(async (tx) => {
      await post(tx, `fee_split:${run!.id}`, "fee_split", [
        { account: "fee", delta: -(cashback + drops) },
        { account: "cashback", delta: cashback },
        { account: "drops", delta: drops },
      ]);
      await emit(tx, "status", { type: "feeRun", cashback, drops });
    });
    await advance(ctx, run, "DONE");
  }
}
