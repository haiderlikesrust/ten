import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "./client";
import { balanceOf, emit, userAccount } from "./ledger";
import { balances, holds, orders, users } from "./schema";

/**
 * Spendable balance: what the book says, minus money already reserved. Both are read in one statement, so they
 * come from the same moment. Read apart, a payment that landed in between (balance down, its hold closed) showed
 * up in only one of them, and for that instant the user looked richer than they were.
 */
export async function availableBalance(db: DbOrTx, userId: string): Promise<number> {
  const rows = await db
    .select({
      balance: balances.micros,
      held: sql<string>`(select coalesce(sum(${holds.amount}), 0) from ${holds} where ${holds.userId} = ${userId} and ${holds.status} = 'active')`,
    })
    .from(users)
    .leftJoin(balances, eq(balances.account, userAccount(userId)))
    .where(eq(users.id, userId));
  return Number(rows[0]?.balance ?? 0) - Number(rows[0]?.held ?? 0);
}

export async function closeHold(tx: DbOrTx, holdId: string, status: "captured" | "released"): Promise<void> {
  await tx.update(holds).set({ status }).where(and(eq(holds.id, holdId), eq(holds.status, "active")));
}

export type OrderKind = (typeof orders.$inferInsert)["kind"];

export interface NewOrder {
  userId: string;
  kind: OrderKind;
  params: Record<string, unknown>;
  /** Money to reserve now. 0 for actions that cost nothing. */
  holdAmount: number;
  idempotencyKey: string;
}

export type PlaceResult =
  | { ok: true; orderId: string; duplicate: boolean }
  | { ok: false; reason: "insufficient_funds"; available: number };

/** Serialized per user, so two parallel orders can never spend the same dollar. */
export async function placeOrder(tx: Tx, input: NewOrder): Promise<PlaceResult> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("update");

  const existing = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.userId, input.userId), eq(orders.idempotencyKey, input.idempotencyKey)));
  if (existing[0]) return { ok: true, orderId: existing[0].id, duplicate: true };

  let holdId: string | null = null;
  if (input.holdAmount > 0) {
    const available = await availableBalance(tx, input.userId);
    if (available < input.holdAmount) return { ok: false, reason: "insufficient_funds", available };
    const hold = await tx
      .insert(holds)
      .values({ userId: input.userId, amount: input.holdAmount, ref: `order:${input.idempotencyKey}` })
      .returning({ id: holds.id });
    holdId = hold[0]!.id;
  }
  const row = await tx
    .insert(orders)
    .values({ userId: input.userId, kind: input.kind, params: input.params, holdId, idempotencyKey: input.idempotencyKey })
    .returning({ id: orders.id });
  await emit(tx, `user:${input.userId}`, { type: "order", id: row[0]!.id, state: "queued", kind: input.kind });
  return { ok: true, orderId: row[0]!.id, duplicate: false };
}
