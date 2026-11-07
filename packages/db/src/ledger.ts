import { sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "./client";
import { balances, ledgerBatches, ledgerEntries, outbox } from "./schema";

export interface Leg {
  account: string;
  delta: number;
}

export const userAccount = (userId: string) => `user:${userId}`;

/**
 * Double-entry posting. Every batch sums to zero and each ref applies exactly once,
 * so a retried saga step can never move the same money twice.
 * Returns false when the ref had already been posted.
 */
export async function post(tx: Tx, ref: string, reason: string, legs: Leg[]): Promise<boolean> {
  const total = legs.reduce((sum, leg) => sum + leg.delta, 0);
  if (total !== 0) throw new Error(`unbalanced ledger batch ${ref}: ${total}`);
  for (const leg of legs) {
    if (!Number.isSafeInteger(leg.delta)) throw new RangeError(`bad delta on ${ref}`);
  }
  const inserted = await tx.insert(ledgerBatches).values({ ref, reason }).onConflictDoNothing().returning({ ref: ledgerBatches.ref });
  if (inserted.length === 0) return false;
  await tx.insert(ledgerEntries).values(legs.map((leg) => ({ ref, account: leg.account, delta: leg.delta })));
  // Sorted so two postings over the same accounts can never deadlock.
  for (const leg of [...legs].sort((a, b) => a.account.localeCompare(b.account))) {
    // Two steps on purpose: Postgres checks constraints on the row proposed by an INSERT
    // before ON CONFLICT runs, so an upsert would see every debit as a negative balance.
    await tx.insert(balances).values({ account: leg.account, micros: 0 }).onConflictDoNothing();
    await tx
      .update(balances)
      .set({ micros: sql`${balances.micros} + ${leg.delta}` })
      .where(sql`${balances.account} = ${leg.account}`);
  }
  return true;
}

export async function balanceOf(db: DbOrTx, account: string): Promise<number> {
  const rows = await db.select({ micros: balances.micros }).from(balances).where(sql`${balances.account} = ${account}`);
  return rows[0]?.micros ?? 0;
}

export async function emit(db: DbOrTx, topic: string, payload: unknown): Promise<void> {
  await db.insert(outbox).values({ topic, payload });
  await db.execute(sql`select pg_notify('outbox', ${topic})`);
}
