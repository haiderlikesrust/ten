// Transfers an admin makes into or out of a treasury wallet by hand: funding the Drops or Cashback wallet, or
// sweeping spare money to a multisig. Tenner's own transfers are booked as they land, so these are the only way
// money enters or leaves those wallets without the books knowing. An admin records each one by its signature in
// Admin, and this books exactly what the chain shows moved, once per signature.
import { formatUsd } from "@gemdex/core";
import { asc, balanceOf, chainTx, eq, post, treasuryMoves } from "@gemdex/db";
import { role } from "@gemdex/venues";
import type { Ctx } from "./ctx";

type Move = typeof treasuryMoves.$inferSelect;

/** A signature the chain still doesn't know after this long was most likely mistyped. */
const GIVE_UP_MS = 3_600_000;
const LABEL = { drops: "Drops", cashback: "Cashback" } as const;

async function settle(ctx: Ctx, move: Move, patch: Partial<Move>) {
  await ctx.db.update(treasuryMoves).set({ ...patch, updatedAt: new Date() }).where(eq(treasuryMoves.id, move.id));
}

async function bookOne(ctx: Ctx, move: Move, now: number) {
  const refuse = (reason: string) => settle(ctx, move, { state: "REFUSED", reason });
  if (move.wallet !== "drops" && move.wallet !== "cashback") return refuse("Only the Drops and Cashback wallets can be recorded");
  const wallet = move.wallet;

  const own = await ctx.db.select({ id: chainTx.id }).from(chainTx).where(eq(chainTx.signature, move.signature)).limit(1);
  if (own[0]) return refuse("That is one of Tenner's own transactions, which the books already have");

  const moved = await ctx.venue.chain.usdcMoved(role(wallet), move.signature);
  if (moved.status === "missing") {
    if (now - move.createdAt.getTime() > GIVE_UP_MS) return refuse("No confirmed transaction has that signature after an hour. Check it and record it again.");
    return;
  }
  if (moved.status === "failed") return refuse("That transaction failed on chain, so nothing moved");
  if (moved.amount === 0) return refuse(`That transaction moved no USDC into or out of the ${LABEL[wallet]} wallet. If it was for the other wallet, record it again for that one.`);
  if (moved.amount < 0) {
    // The Drops wallet also holds the gift pool and buyback money, which a sweep must not take.
    const pool = await balanceOf(ctx.db, wallet);
    if (pool < -moved.amount) {
      return refuse(`It took out ${formatUsd(-moved.amount)}, more than the ${formatUsd(pool)} the ${wallet === "drops" ? "Pulse pool" : "cashback pool"} holds in the books. Send the difference back, then record both.`);
    }
  }

  await ctx.db.transaction(async (tx) => {
    await post(tx, `treasury:${wallet}:${move.signature}`, moved.amount > 0 ? "treasury_deposit" : "treasury_withdrawal", [
      { account: "world", delta: -moved.amount },
      { account: wallet, delta: moved.amount },
    ]);
    await tx.update(treasuryMoves).set({ state: "BOOKED", amount: moved.amount, reason: null, updatedAt: new Date() }).where(eq(treasuryMoves.id, move.id));
  });
  ctx.log(`booked a treasury ${moved.amount > 0 ? "deposit" : "withdrawal"} of ${formatUsd(Math.abs(moved.amount))} on ${LABEL[wallet]}`);
}

export async function tickTreasuryMoves(ctx: Ctx, now = Date.now()): Promise<void> {
  const pending = await ctx.db.select().from(treasuryMoves).where(eq(treasuryMoves.state, "PENDING")).orderBy(asc(treasuryMoves.createdAt)).limit(20);
  for (const move of pending) {
    // One unreadable transaction must not hold up the others. It is tried again next tick.
    await bookOne(ctx, move, now).catch((error: unknown) => ctx.log(`treasury move ${move.signature.slice(0, 8)} not read yet`, (error as Error)?.message));
  }
}
