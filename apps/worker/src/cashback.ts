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
  await ctx.db.transaction(async (tx) => {
    // Packs opened together are finished in parallel. Each one read today's total and the pool before any had
    // written, so ten packs could be promised ten times the daily cap, or more than the pool held. One at a time
    // here, so every accrual sees the ones before it.
    await tx.execute(sql`select pg_advisory_xact_lock(7270021)`);
    const paid = await tx
      .select({ total: sql<string>`coalesce(sum(${cashbackAccruals.amount}), 0)` })
      .from(cashbackAccruals)
      .where(and(eq(cashbackAccruals.userId, user.id), gte(cashbackAccruals.createdAt, start), sql`${cashbackAccruals.status} <> 'skipped'`));
    const owed = await tx.select({ total: sql<string>`coalesce(sum(${cashbackAccruals.amount}), 0)` }).from(cashbackAccruals).where(eq(cashbackAccruals.status, "accrued"));
    const amount = cashbackAmount({
      packPrice: machine.price,
      tierBps: tier.rateBps,
      machineCapBps: capBps,
      paidToday: Number(paid[0]?.total ?? 0),
      dailyCap: settings.dailyCapPerUser,
      // Payouts already promised but not sent yet come out of the same pool.
      poolBalance: Math.max(0, (await balanceOf(tx, "cashback")) - Number(owed[0]?.total ?? 0)),
    });
    await tx
      .insert(cashbackAccruals)
      .values({
        userId: user.id, memo, machineCode: machine.code, packPrice: machine.price,
        rateBps: Math.min(tier.rateBps, capBps), amount, status: amount > 0 ? "accrued" : "skipped",
      })
      .onConflictDoNothing();
  });
}

export async function tickCashback(ctx: Ctx): Promise<void> {
  const due = await ctx.db.select().from(cashbackAccruals).where(eq(cashbackAccruals.status, "accrued")).limit(25);
  // A payout is on its way while a transfer for it is signed or sent, or has landed and is about to be booked.
  // One whose only transfers failed or expired is not: it is free to be skipped.
  const onItsWay = new Set<string>();
  for (const accrual of due) {
    const sends = await ctx.db.select({ status: chainTx.status }).from(chainTx).where(and(eq(chainTx.purpose, "cashback"), eq(chainTx.ref, accrual.id)));
    if (sends.some((send) => send.status === "signed" || send.status === "sent" || send.status === "confirmed")) onItsWay.add(accrual.id);
  }
  // What the pool can still cover, after every payout already on its way. The book only falls when a payout is
  // booked, so without this several payouts could each pass the check against the same dollars.
  let room = (await balanceOf(ctx.db, "cashback")) - due.filter((a) => onItsWay.has(a.id)).reduce((sum, a) => sum + a.amount, 0);
  for (const accrual of due) {
    const rows = await ctx.db.select().from(users).where(eq(users.id, accrual.userId));
    const user = rows[0]!;
    // A payout the pool can't cover would fail on chain, cost a fee on every retry, and hold up that user's deposit
    // sync for as long as it kept trying. So it is skipped, even after a first send failed. One on its way must finish.
    if (!onItsWay.has(accrual.id)) {
      if (room < accrual.amount) {
        await ctx.db.update(cashbackAccruals).set({ status: "skipped" }).where(eq(cashbackAccruals.id, accrual.id));
        continue;
      }
      room -= accrual.amount;
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
