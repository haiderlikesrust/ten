import { and, balances, chainTx, eq, getSetting, gt, inArray, loadJson, reconcileRuns, saveJson, setSetting, sql, treasuryMoves, users } from "@gemdex/db";
import { role, trader, type Party } from "@gemdex/venues";
import type { Ctx } from "./ctx";

export interface Mismatch {
  account: string;
  book: number;
  chain: number;
}

const TREASURY = ["drops", "cashback", "fee"] as const;
/** Book accounts whose money is held in the Drops wallet alongside `drops`. */
export const DROPS_WALLET_ACCOUNTS = ["gifts", "gift_reserved", "revenue", "buyback_inflight"];

/** Long enough for a transfer that just landed to reach the book. */
const SETTLE_MS = 3_000;
/**
 * How long a transaction can explain a difference. One still signed or sent is settled within a couple of minutes,
 * and a confirmed one is booked on the next tick. Anything older was left behind, and must not keep the check
 * switched off for good.
 */
const IN_FLIGHT_MS = 15 * 60_000;

async function compareBooks(ctx: Ctx): Promise<Mismatch[]> {
  const rows = await ctx.db.select().from(balances).where(sql`${balances.account} like 'user:%' or ${balances.account} in ('drops', 'cashback', 'fee')`);
  // The gift pool, gifts waiting to be claimed, and Pulse sale money waiting for buyback all sit in the Drops wallet.
  const held = await ctx.db.select().from(balances).where(inArray(balances.account, DROPS_WALLET_ACCOUNTS));
  const inDropsWallet = held.reduce((sum, row) => sum + row.micros, 0);
  const seen = new Set(rows.map((row) => row.account));
  for (const name of TREASURY) if (!seen.has(name)) rows.push({ account: name, micros: 0 });

  const mismatches: Mismatch[] = [];
  for (const row of rows) {
    let party: Party;
    if (row.account.startsWith("user:")) {
      // Real user balances also move through deposits, which the indexer posts. Paper has none.
      if (ctx.venue.mode !== "paper") continue;
      const userId = row.account.slice(5);
      const found = await ctx.db.select({ wallet: users.tradingWallet }).from(users).where(eq(users.id, userId));
      if (!found[0]) continue;
      party = trader(userId, found[0].wallet);
    } else {
      party = role(row.account as (typeof TREASURY)[number]);
    }
    const chain = await ctx.venue.chain.usdcBalance(party);
    const book = row.account === "drops" ? row.micros + inDropsWallet : row.micros;
    if (chain !== book) mismatches.push({ account: row.account, book, chain });
  }
  return mismatches;
}

/**
 * Compares the book with the chain, and pauses drops on a difference that lasts.
 *
 * Money lands on chain a moment before the book records it, so a check can fall in that gap.
 * A difference therefore has to survive a second look, and then show again on the next run.
 * Paper fee runs all pay the same amount, so two separate gaps can look identical. Only the
 * second look rules that out, and an open fee run counts as money in flight.
 */
export async function reconcile(ctx: Ctx, settleMs = SETTLE_MS): Promise<{ ok: boolean; mismatches: Mismatch[] }> {
  let mismatches = await compareBooks(ctx);
  if (mismatches.length > 0 && settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    const first = mismatches;
    mismatches = (await compareBooks(ctx)).filter((m) => first.some((p) => p.account === m.account && p.chain - p.book === m.chain - m.book));
  }

  const recently = new Date(Date.now() - IN_FLIGHT_MS);
  const [openTx, openFees, openMoves] = await Promise.all([
    ctx.db.select({ id: chainTx.id }).from(chainTx).where(and(inArray(chainTx.status, ["signed", "sent"]), gt(chainTx.updatedAt, recently))).limit(1),
    // A fee run moves money in steps, and each step reaches the book a moment after its transaction lands. A run
    // that is only stuck (no SOL to swap with, say) moves nothing, and used to count as in flight for as long as it lasted.
    ctx.sql<{ id: string }[]>`
      select r.id from fee_runs r join chain_tx c on c.ref = r.id::text and c.purpose in ('fee_collect', 'fee_swap', 'fee_split')
      where r.stage in ('PENDING', 'COLLECTED', 'SWAPPED') and c.status = 'confirmed' and c.updated_at > now() - interval '15 minutes'
      limit 1`,
    // A treasury transfer an admin recorded but the worker has not booked yet is money on its way into the books.
    ctx.db.select({ id: treasuryMoves.id }).from(treasuryMoves).where(eq(treasuryMoves.state, "PENDING")).limit(1),
  ]);
  const inFlight = openTx.length > 0 || openFees.length > 0 || openMoves.length > 0;

  const previous = (await loadJson<Mismatch[]>(ctx.db, "reconcileLast")) ?? [];
  // Only a wallet holding LESS than its book pauses Pulse: that is money gone missing. A wallet holding more is
  // safe to carry on with, and is still listed for an admin to look at. Treasury addresses are public, so if a
  // surplus paused Pulse, anyone could stop it for good by sending a wallet a fraction of a cent.
  const repeated = mismatches.filter((m) => m.chain < m.book && previous.some((p) => p.account === m.account && p.book === m.book && p.chain === m.chain));
  await saveJson(ctx.db, "reconcileLast", mismatches);
  await ctx.db.insert(reconcileRuns).values({ ok: mismatches.length === 0, mismatches });

  if (repeated.length > 0 && !inFlight) {
    ctx.log("reconcile mismatch, pausing drops", repeated);
    await setSetting(ctx.db, "ops", { reconcileHold: true });
  } else if (ctx.venue.mode === "paper" && mismatches.length === 0 && (await getSetting(ctx.db, "ops")).reconcileHold) {
    // Paper has no money at risk, so it recovers on its own. Real money always waits for a person.
    ctx.log("books match again, resuming drops");
    await setSetting(ctx.db, "ops", { reconcileHold: false });
  }
  return { ok: mismatches.length === 0, mismatches };
}
