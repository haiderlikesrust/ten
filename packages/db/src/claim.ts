import { priceAt } from "@gemdex/core";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { emit } from "./ledger";
import { availableBalance } from "./orders";
import { claims, drops, holds, users } from "./schema";
import { getSetting } from "./settings";

export type ClaimResult =
  | { status: "won"; claimId: string; price: number; repeat: boolean }
  | { status: "lost"; reason: "taken" | "closed" }
  | { status: "rejected"; reason: "insufficient_funds" | "minimum_balance" | "cooldown" | "active_claim" | "not_found" | "drops_paused" | "price_moved"; retryInSec?: number; available?: number; price?: number };

export interface ClaimInput {
  userId: string;
  dropId: string;
  idempotencyKey: string;
  /** The most the buyer agreed to pay. The price moves every second, so it can change mid-click. */
  maxPrice?: number;
}

/**
 * Decides who gets a card. First valid click wins, at the price at that moment.
 *
 * The balance hold and the state flip share one Postgres transaction. The UPDATE takes
 * the row lock, so the first transaction to reach it wins and everyone else matches
 * zero rows and rolls back with their hold undone. Client timestamps play no part.
 */
export async function claimDrop(db: Db, input: ClaimInput): Promise<ClaimResult> {
  const [settings, ops] = await Promise.all([getSetting(db, "drops"), getSetting(db, "ops")]);
  if (ops.killSwitch) return { status: "rejected", reason: "drops_paused" };

  return db.transaction(async (tx): Promise<ClaimResult> => {
    // Locks this user only, so one person cannot race themselves across their own balance.
    const userRows = await tx.select().from(users).where(eq(users.id, input.userId)).for("update");
    const user = userRows[0];
    if (!user) return { status: "rejected", reason: "not_found" };

    const prior = await tx.select().from(claims).where(and(eq(claims.userId, input.userId), eq(claims.idempotencyKey, input.idempotencyKey)));
    if (prior[0]) return { status: "won", claimId: prior[0].id, price: prior[0].price, repeat: true };

    const dropRows = await tx.select({ price: drops.price, state: drops.state, path: drops.path, opensAt: drops.opensAt }).from(drops).where(eq(drops.id, input.dropId));
    const drop = dropRows[0];
    if (!drop || drop.price === null) return { status: "rejected", reason: "not_found" };
    if (drop.state !== "LIVE") return { status: "lost", reason: "taken" };

    const now = Date.now();
    const price = drop.path?.length && drop.opensAt ? priceAt(drop.path, drop.opensAt.getTime(), now) : drop.price;
    if (input.maxPrice !== undefined && price > input.maxPrice) return { status: "rejected", reason: "price_moved", price };

    if (settings.winCooldownSec > 0 && user.lastWinAt) {
      const left = settings.winCooldownSec - (now - user.lastWinAt.getTime()) / 1000;
      if (left > 0) return { status: "rejected", reason: "cooldown", retryInSec: Math.ceil(left) };
    }

    const active = await tx.select({ id: claims.id }).from(claims).where(and(eq(claims.userId, input.userId), eq(claims.state, "won"))).limit(1);
    if (active[0]) return { status: "rejected", reason: "active_claim" };

    const available = await availableBalance(tx, input.userId);
    if (available < settings.minPrice) return { status: "rejected", reason: "minimum_balance", available };
    if (available < price) return { status: "rejected", reason: "insufficient_funds", available };

    const hold = await tx.insert(holds).values({ userId: input.userId, amount: price, ref: `drop:${input.dropId}` }).returning({ id: holds.id });

    const claimId = crypto.randomUUID();
    const stoppedAt = new Date(now);
    const taken = await tx
      .update(drops)
      .set({ state: "CLAIMED", winnerClaimId: claimId, price, boughtBy: user.connectedWallet, stoppedAt, updatedAt: stoppedAt, nextRunAt: stoppedAt })
      .where(and(eq(drops.id, input.dropId), eq(drops.state, "LIVE"), sql`now() between ${drops.opensAt} and ${drops.expiresAt}`))
      .returning({ id: drops.id, number: drops.number });

    if (taken.length === 0) await tx.rollback();

    await tx.insert(claims).values({
      id: claimId, dropId: input.dropId, userId: input.userId, idempotencyKey: input.idempotencyKey, deliverTo: user.connectedWallet, price, holdId: hold[0]!.id,
      settleBy: new Date(now + 60_000),
    });
    await emit(tx, "drops", { type: "claimed", dropId: input.dropId, number: taken[0]!.number, by: user.connectedWallet, price, stoppedAt });
    await emit(tx, `user:${input.userId}`, { type: "claim", id: claimId, dropId: input.dropId, state: "won" });
    return { status: "won", claimId, price, repeat: false };
  }).catch((error: unknown) => {
    // tx.rollback() surfaces as an error. It only ever means the card was taken first.
    if (error instanceof Error && error.message === "Rollback") return { status: "lost", reason: "taken" } as const;
    // One active claim per user is also a unique index, so a parallel self-race lands here.
    if (error instanceof Error && /claims_one_active_idx|duplicate key/.test(`${error.message} ${(error as { cause?: Error }).cause?.message ?? ""}`)) {
      return { status: "rejected", reason: "active_claim" } as const;
    }
    throw error;
  });
}
