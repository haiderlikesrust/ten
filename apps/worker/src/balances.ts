import { activity, and, balanceOf, cashbackAccruals, claims, emit, eq, holds, inArray, orders, post, userAccount, users } from "@gemdex/db";
import { trader } from "@gemdex/venues";
import type { Ctx } from "./ctx";

/**
 * Brings each trading wallet's book balance in line with the chain, which is how
 * deposits and direct withdrawals enter the ledger.
 *
 * Every money movement has an open marker from before it lands until after it is booked.
 * A wallet with any marker is skipped, so a transaction that has landed but is not yet
 * booked can never be counted here as well. That would double the amount.
 */
export async function tickBalances(ctx: Ctx): Promise<number> {
  if (ctx.venue.mode === "paper") return 0;
  const rows = await ctx.db.select({ id: users.id, wallet: users.tradingWallet }).from(users);
  let changed = 0;
  for (const user of rows) {
    if (await hasOpenWork(ctx, user.id)) continue;
    const chain = await ctx.venue.chain.usdcBalance(trader(user.id, user.wallet));
    const book = await balanceOf(ctx.db, userAccount(user.id));
    const diff = chain - book;
    if (diff === 0) continue;
    await ctx.db.transaction(async (tx) => {
      await post(tx, `sync:${user.id}:${Date.now()}`, diff > 0 ? "deposit" : "withdrawal", [
        { account: "world", delta: -diff },
        { account: userAccount(user.id), delta: diff },
      ]);
      await tx.insert(activity).values({ userId: user.id, kind: diff > 0 ? "deposit" : "withdrawal", title: diff > 0 ? "Deposit" : "Withdrawal", delta: diff });
      await emit(tx, `user:${user.id}`, { type: "balance" });
    });
    changed++;
  }
  return changed;
}

async function hasOpenWork(ctx: Ctx, userId: string): Promise<boolean> {
  const [hold, order, accrual, claim] = await Promise.all([
    ctx.db.select({ id: holds.id }).from(holds).where(and(eq(holds.userId, userId), eq(holds.status, "active"))).limit(1),
    ctx.db.select({ id: orders.id }).from(orders).where(and(eq(orders.userId, userId), inArray(orders.state, ["queued", "running"]))).limit(1),
    ctx.db.select({ id: cashbackAccruals.id }).from(cashbackAccruals).where(and(eq(cashbackAccruals.userId, userId), eq(cashbackAccruals.status, "accrued"))).limit(1),
    ctx.db.select({ id: claims.id }).from(claims).where(and(eq(claims.userId, userId), eq(claims.state, "won"))).limit(1),
  ]);
  return !!(hold[0] ?? order[0] ?? accrual[0] ?? claim[0]);
}
