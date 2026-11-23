// One-off fix for a Drops key swap: books USDC that left a PREVIOUS Drops wallet as withdrawn.
//
// Admin -> Treasury transfers only reads transfers in or out of the CURRENT Drops wallet. After TREASURY_KEY_DROPS
// (or PRIVY_WALLET_DROPS) changes, money that sat in the old wallet is still in the books, the new wallet holds less
// than they say, and reconciliation pauses Pulse. When that money was sent somewhere else from the old wallet, this
// books it out: every account held in the Drops wallet (drops, gifts, revenue, ...) goes to "world", the same way a
// recorded sweep does, and the transfer is listed under Treasury transfers as BOOKED.
//
// Dry run (changes nothing):
//   node --import tsx tools/book-old-drops-sweep.ts --from <old Drops address> --signature <transfer signature>
// Then, if the plan is right:
//   node --import tsx tools/book-old-drops-sweep.ts --from <old Drops address> --signature <transfer signature> --apply
//
// Reads DATABASE_URL, SOLANA_RPC_URL and GEMDEX_MODE, so run it where the worker runs (its container terminal).
// Afterwards, press "Clear reconcile hold" in Admin once Reconciliation says the books match.
import { pathToFileURL } from "node:url";
import { balances, chainTx, connect, drops, eq, inArray, post, sql, treasuryMoves, type Database } from "@gemdex/db";

/** Book accounts whose money is held in the Drops wallet. Kept equal to DROPS_WALLET_ACCOUNTS plus "drops" (a test checks). */
export const DROPS_WALLET_BOOKS = ["drops", "gifts", "gift_reserved", "revenue", "buyback_inflight"] as const;
/** Drops still holding or owed money. While any exist, the books are mid-flight and must not be zeroed. */
const OPEN_DROP_STATES = [
  "PLANNED", "PACK_PAID", "OPENING", "IN_VAULT", "LIVE", "CLAIMED", "SETTLING", "EXPIRED",
  "QUOTED", "DEBITING", "PACK_PAYING", "AWAIT_AUTO_REFUND", "REFUND_DUE",
];
const USDC = { mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", devnet: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr" } as const;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

interface TokenBalance {
  owner?: string;
  mint: string;
  uiTokenAmount: { amount: string };
}
export interface ChainTransfer {
  meta: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
}

/** Micro-USDC that left `owner` in this transaction (positive), read from its token balances like usdcMoved does. */
export function usdcSentBy(tx: ChainTransfer, owner: string, mint: string): number {
  const total = (list: TokenBalance[] | undefined) =>
    (list ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((sum, b) => sum + Number(b.uiTokenAmount.amount), 0);
  return total(tx.meta?.preTokenBalances) - total(tx.meta?.postTokenBalances);
}

export interface SweepPlan {
  /** What each Drops-wallet account holds in the books now. */
  held: Record<string, number>;
  total: number;
  /** Reasons it isn't safe to book now. Empty means it is. */
  blockers: string[];
}

export async function planSweep(database: Database, signature: string): Promise<SweepPlan> {
  const { db } = database;
  const rows = await db.select().from(balances).where(inArray(balances.account, [...DROPS_WALLET_BOOKS]));
  const held = Object.fromEntries(DROPS_WALLET_BOOKS.map((account) => [account, rows.find((r) => r.account === account)?.micros ?? 0]));
  const total = Object.values(held).reduce((sum, n) => sum + n, 0);
  const blockers: string[] = [];

  const [open, inflight, pending, done] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(drops).where(inArray(drops.state, OPEN_DROP_STATES)),
    db.select({ n: sql<number>`count(*)::int` }).from(chainTx).where(inArray(chainTx.status, ["signed", "sent"])),
    db.select({ n: sql<number>`count(*)::int` }).from(treasuryMoves).where(eq(treasuryMoves.state, "PENDING")),
    db.select({ n: sql<number>`count(*)::int` }).from(treasuryMoves).where(sql`${treasuryMoves.signature} = ${signature} and ${treasuryMoves.wallet} = 'drops'`),
  ]);
  if (open[0]!.n > 0) blockers.push(`${open[0]!.n} drop(s) are still open (live, settling or awaiting a refund). Wait until none are.`);
  if (inflight[0]!.n > 0) blockers.push(`${inflight[0]!.n} transaction(s) are still being sent. Wait for them to finish.`);
  if (pending[0]!.n > 0) blockers.push(`${pending[0]!.n} treasury transfer(s) are waiting to be read. Let the worker book or refuse them first.`);
  if (done[0]!.n > 0) blockers.push("This signature is already recorded for the Drops wallet.");
  if (held.gift_reserved! > 0) blockers.push("A gift prize is reserved for a winner who hasn't claimed it. Wait for the claim or its expiry.");
  if (held.buyback_inflight! > 0) blockers.push("A buyback is in progress. Wait for it to finish.");
  if (total <= 0) blockers.push("The books hold nothing for the Drops wallet, so there is nothing to book.");
  return { held, total, blockers };
}

/**
 * Books the plan: every Drops-wallet account to "world", under the same ledger ref a recorded sweep would use, so it
 * can never be booked twice (not even later through Admin). Re-checks inside the transaction.
 */
export async function applySweep(database: Database, input: { signature: string; from: string; moved: number }): Promise<{ total: number }> {
  return database.db.transaction(async (tx) => {
    // Locks the Drops-wallet balances, so nothing moves them between the check and the booking.
    const rows = await tx.select().from(balances).where(inArray(balances.account, [...DROPS_WALLET_BOOKS])).for("update");
    const legs = rows.filter((r) => r.micros > 0).map((r) => ({ account: r.account, delta: -r.micros }));
    const total = -legs.reduce((sum, leg) => sum + leg.delta, 0);
    if (total <= 0) throw new Error("Nothing to book");
    if (input.moved < total) throw new Error(`The transfer moved ${input.moved} micro-USDC, less than the ${total} the books hold`);
    const posted = await post(tx, `treasury:drops:${input.signature}`, "treasury_withdrawal", [...legs, { account: "world", delta: total }]);
    if (!posted) throw new Error("This signature was already booked");
    await tx.insert(treasuryMoves).values({
      signature: input.signature, wallet: "drops", state: "BOOKED", amount: -total,
      reason: `Sent from the previous Drops wallet ${input.from}, booked by tools/book-old-drops-sweep.ts`,
    });
    return { total };
  });
}

async function readTransfer(rpcUrl: string, signature: string): Promise<ChainTransfer | null> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }] }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { result?: ChainTransfer | null; error?: { message?: string } };
  if (json.error) throw new Error(`RPC: ${json.error.message}`);
  return json.result ?? null;
}

const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const from = flag("from")?.trim() ?? "";
  const signature = flag("signature")?.trim() ?? "";
  const apply = args.includes("--apply");
  if (!ADDRESS.test(from) || !SIGNATURE.test(signature)) {
    console.error("Usage: node --import tsx tools/book-old-drops-sweep.ts --from <old Drops address> --signature <transfer signature> [--apply]");
    process.exit(2);
  }
  const mode = process.env.GEMDEX_MODE;
  if (mode !== "mainnet" && mode !== "devnet") throw new Error(`GEMDEX_MODE is ${mode ?? "unset"}. Run this where the worker runs.`);
  const rpcUrl = process.env.SOLANA_RPC_URL || (mode === "devnet" ? "https://api.devnet.solana.com" : "");
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL is not set");

  const transfer = await readTransfer(rpcUrl, signature);
  if (!transfer?.meta) throw new Error("No confirmed transaction has that signature. Check it and try again.");
  if (transfer.meta.err) throw new Error("That transaction failed on chain, so nothing moved.");
  const moved = usdcSentBy(transfer, from, USDC[mode]);
  if (moved <= 0) throw new Error(`That transaction sent no USDC from ${from}. Check the address is the OLD Drops wallet.`);

  const database = connect(process.env.DATABASE_URL, { max: 2 });
  try {
    const plan = await planSweep(database, signature);
    console.log(`\nTransfer ${signature.slice(0, 12)}… sent ${usd(moved)} from ${from}.`);
    console.log("The books hold, for the Drops wallet:");
    for (const [account, micros] of Object.entries(plan.held)) if (micros) console.log(`  ${account.padEnd(16)} ${usd(micros)}`);
    console.log(`  ${"total".padEnd(16)} ${usd(plan.total)}`);
    if (moved < plan.total) plan.blockers.push(`The transfer moved ${usd(moved)}, less than the ${usd(plan.total)} the books hold. Book the rest by moving it into the new Drops wallet instead.`);
    if (plan.blockers.length > 0) {
      console.log("\nNot booked:");
      for (const reason of plan.blockers) console.log(`  - ${reason}`);
      process.exitCode = 1;
      return;
    }
    if (moved > plan.total) console.log(`\nThe transfer moved ${usd(moved - plan.total)} more than the books hold. That extra was never booked, so it is ignored.`);
    if (!apply) {
      console.log(`\nDry run: nothing changed. Run again with --apply to book ${usd(plan.total)} as withdrawn.`);
      return;
    }
    const { total } = await applySweep(database, { signature, from, moved });
    console.log(`\nBooked ${usd(total)} as withdrawn from the Drops wallet. Check Admin -> Reconciliation says the books match, then press "Clear reconcile hold".`);
  } finally {
    await database.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
