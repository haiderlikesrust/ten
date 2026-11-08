import { cashbackAmount, cashbackCapBps, holderBalance, tierFor, BRAND } from "@gemdex/core";
import {
  activity, and, balanceOf, cashbackAccruals, chainTx, emit, eq, getSetting, gte, holderSnapshots, machines, post, sql, userAccount, users,
} from "@gemdex/db";
import { role, trader } from "@gemdex/venues";
import { sendOnce } from "./chain-tx";
import type { Ctx } from "./ctx";
import { toEcon } from "./drops";

type User = typeof users.$inferSelect;
type Machine = typeof machines.$inferSelect;

/** Tier comes from the lowest balance in 24h, so buying just before opening earns nothing. */
export async function holderTierOf(ctx: Ctx, user: Pick<User, "holderWallet">) {
  const settings = await getSetting(ctx.db, "cashback");
  if (!user.holderWallet) return { tier: null, balance: 0, settings };
  const since = new Date(Date.now() - 86_400_000);
  const rows = await ctx.db
    .select({ balance: holderSnapshots.balance })
    .from(holderSnapshots)
    .where(and(eq(holderSnapshots.wallet, user.holderWallet), gte(holderSnapshots.takenAt, since)));
  const balance = holderBalance(rows.map((row) => row.balance));
  return { tier: tierFor(balance, settings.tiers), balance, settings };
}

export async function accrueCashback(ctx: Ctx, user: User, memo: string, machine: Machine): Promise<void> {
  const { tier, settings } = await holderTierOf(ctx, user);
  if (!tier) return;
  const capBps = cashbackCapBps(toEcon(machine), settings);
  const start = new Date(new Date().toISOString().slice(0, 10));
  const paid = await ctx.db
    .select({ total: sql<string>`coalesce(sum(${cashbackAccruals.amount}), 0)` })
    .from(cashbackAccruals)
    .where(and(eq(cashbackAccruals.userId, user.id), gte(cashbackAccruals.createdAt, start), sql`${cashbackAccruals.status} <> 'skipped'`));
  const amount = cashbackAmount({
    packPrice: machine.price,
    tierBps: tier.rateBps,
    machineCapBps: capBps,
    paidToday: Number(paid[0]?.total ?? 0),
    dailyCap: settings.dailyCapPerUser,
    // Payouts already promised but not sent yet come out of the same pool.
    poolBalance: Math.max(0, (await balanceOf(ctx.db, "cashback")) - (await owedCashback(ctx))),
  });
  await ctx.db
    .insert(cashbackAccruals)
    .values({
      userId: user.id, memo, machineCode: machine.code, packPrice: machine.price,
      rateBps: Math.min(tier.rateBps, capBps), amount, status: amount > 0 ? "accrued" : "skipped",
    })
    .onConflictDoNothing();
}

async function owedCashback(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.select({ total: sql<string>`coalesce(sum(${cashbackAccruals.amount}), 0)` }).from(cashbackAccruals).where(eq(cashbackAccruals.status, "accrued"));
  return Number(rows[0]?.total ?? 0);
}

export async function tickCashback(ctx: Ctx): Promise<void> {
  const due = await ctx.db.select().from(cashbackAccruals).where(eq(cashbackAccruals.status, "accrued")).limit(25);
  for (const accrual of due) {
    const rows = await ctx.db.select().from(users).where(eq(users.id, accrual.userId));
    const user = rows[0]!;
    // Two packs opened together can promise more than the pool holds. Sending anyway would fail on chain, cost a fee
    // every retry, and hold up that user's deposit sync, so a payout the pool can't cover is skipped. Unless one is
    // already on its way, which still has to finish.
    const started = await ctx.db.select({ id: chainTx.id }).from(chainTx).where(and(eq(chainTx.purpose, "cashback"), eq(chainTx.ref, accrual.id))).limit(1);
    if (!started[0] && (await balanceOf(ctx.db, "cashback")) < accrual.amount) {
      await ctx.db.update(cashbackAccruals).set({ status: "skipped" }).where(eq(cashbackAccruals.id, accrual.id));
      continue;
    }
    const result = await sendOnce(ctx, "cashback", accrual.id, async () => ({
      type: "usdc", from: role("cashback"), to: trader(user.id, user.tradingWallet), amount: accrual.amount, memo: `${BRAND.memoPrefix}:cashback:${accrual.id}`,
    }), { retryFailed: true });
    if (result.status !== "confirmed") continue;
    await ctx.db.transaction(async (tx) => {
      await post(tx, `cashback:${accrual.id}`, "cashback", [{ account: "cashback", delta: -accrual.amount }, { account: userAccount(user.id), delta: accrual.amount }]);
      await tx.update(cashbackAccruals).set({ status: "paid", paidAt: new Date() }).where(eq(cashbackAccruals.id, accrual.id));
      await tx.insert(activity).values({ userId: user.id, kind: "cashback", title: "Holder cashback", delta: accrual.amount, ref: accrual.memo });
      await emit(tx, `user:${user.id}`, { type: "cashback", amount: accrual.amount });
    });
  }
}

/** Snapshots at random times within each period, so they cannot be gamed by timing. */
export async function tickHolderSnapshots(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.select({ wallet: users.holderWallet }).from(users).where(sql`${users.holderWallet} is not null`);
  for (const { wallet } of rows) {
    if (!wallet) continue;
    const balance = await ctx.venue.chain.tokenBalance(wallet);
    await ctx.db.insert(holderSnapshots).values({ wallet, balance });
  }
}
