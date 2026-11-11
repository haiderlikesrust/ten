import { and, chainTx, desc, eq, type Db } from "@gemdex/db";
import { AmbiguousSend, TxRefused, type ChainOp } from "@gemdex/venues";
import type { Ctx } from "./ctx";

export interface SendResult {
  status: "confirmed" | "failed" | "pending";
  signature?: string;
  /** Set when nothing more will be tried: the venue refused to sign, or every attempt is used up. */
  reason?: string;
}

export interface SendOptions {
  deadlineAt?: Date | null;
  retryFailed?: boolean;
  /** Most signed versions to try before giving up. Unlimited when unset. */
  maxAttempts?: number;
}

async function mark(db: Db, id: string, status: "sent" | "confirmed" | "failed" | "dead") {
  await db.update(chainTx).set({ status, updatedAt: new Date() }).where(eq(chainTx.id, id));
}

/**
 * The only way this app sends a transaction.
 *
 * Signed bytes are saved before the first send. A crash or timeout can then only ever
 * rebroadcast the identical transaction, which can land at most once. A new signature
 * is created only after the old one is proven dead, so two versions can never both land.
 * Bytes someone else built (CC) cannot be rebuilt: once they are dead the venue refuses to
 * sign them again, and the send ends failed.
 */
export async function sendOnce(
  ctx: Ctx,
  purpose: string,
  ref: string,
  build: () => Promise<ChainOp>,
  opts: SendOptions = {},
): Promise<SendResult> {
  const rows = await ctx.db
    .select()
    .from(chainTx)
    .where(and(eq(chainTx.purpose, purpose), eq(chainTx.ref, ref)))
    .orderBy(desc(chainTx.attempt))
    .limit(1);
  const latest = rows[0];

  if (!latest) return fresh(ctx, purpose, ref, 1, build, opts);
  if (latest.status === "confirmed") return { status: "confirmed", signature: latest.signature };
  if (latest.status === "failed") {
    // A failed transaction moved nothing, so work that has to finish can safely send a new one.
    if (opts.retryFailed) return fresh(ctx, purpose, ref, latest.attempt + 1, build, opts, latest.signature);
    return { status: "failed", signature: latest.signature };
  }

  let status = latest.status === "dead" ? "dead" : await ctx.venue.chain.status(latest.signature, latest.raw);
  if (status === "pending") {
    await broadcast(ctx, latest.raw);
    // The second look can also come back "dead". The venue only says that once, so it must be acted on here:
    // dropping it restarted the venue's one-minute wait, and an expired payment could sit pending for minutes more.
    status = await ctx.venue.chain.status(latest.signature, latest.raw);
    if (status === "pending") return { status: "pending", signature: latest.signature };
  }
  if (status === "confirmed" || status === "failed") {
    await mark(ctx.db, latest.id, status);
    return { status, signature: latest.signature };
  }

  await mark(ctx.db, latest.id, "dead");
  if (opts.deadlineAt && Date.now() > opts.deadlineAt.getTime()) return { status: "failed", signature: latest.signature };
  return fresh(ctx, purpose, ref, latest.attempt + 1, build, opts, latest.signature);
}

async function fresh(
  ctx: Ctx,
  purpose: string,
  ref: string,
  attempt: number,
  build: () => Promise<ChainOp>,
  opts: SendOptions,
  previous?: string,
): Promise<SendResult> {
  if (opts.maxAttempts && attempt > opts.maxAttempts) return { status: "failed", signature: previous, reason: `failed ${opts.maxAttempts} times` };
  let prepared;
  try {
    prepared = await ctx.venue.chain.prepare(await build());
  } catch (error) {
    // Nothing was signed. Asking again would only get the same answer.
    if (error instanceof TxRefused) return { status: "failed", signature: previous, reason: error.message };
    // Nothing was signed, and nothing sent earlier can still land. Past its deadline the send ends here: a signer
    // that keeps refusing would otherwise be asked for ever, with the user's money on hold the whole time. The same
    // goes for a pause (the kill switch, or mainnet no longer armed): it may last hours, and ending costs nothing.
    if (opts.deadlineAt && Date.now() > opts.deadlineAt.getTime()) {
      return { status: "failed", signature: previous, reason: `could not be signed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) };
    }
    throw error;
  }
  const inserted = await ctx.db
    .insert(chainTx)
    .values({ purpose, ref, attempt, signature: prepared.signature, raw: prepared.raw, deadlineAt: opts.deadlineAt ?? null })
    .onConflictDoNothing()
    .returning({ id: chainTx.id });
  const row = inserted[0];
  if (!row) return { status: "pending" };
  if (await broadcast(ctx, prepared.raw)) await mark(ctx.db, row.id, "sent");

  const status = await ctx.venue.chain.status(prepared.signature, prepared.raw);
  if (status === "confirmed" || status === "failed") {
    await mark(ctx.db, row.id, status);
    return { status, signature: prepared.signature };
  }
  return { status: "pending", signature: prepared.signature };
}

async function broadcast(ctx: Ctx, raw: string): Promise<boolean> {
  try {
    await ctx.venue.chain.send(raw);
    return true;
  } catch (error) {
    if (error instanceof AmbiguousSend) return false;
    throw error;
  }
}

/** The landed payment for a send, which CC's record of a pack must name. */
export async function confirmedSignature(ctx: Ctx, purpose: string, ref: string): Promise<string> {
  const rows = await ctx.db
    .select({ signature: chainTx.signature })
    .from(chainTx)
    .where(and(eq(chainTx.purpose, purpose), eq(chainTx.ref, ref), eq(chainTx.status, "confirmed")))
    .limit(1);
  if (!rows[0]) throw new Error(`no confirmed ${purpose} for ${ref}`);
  return rows[0].signature;
}

/**
 * CC opens a paid pack within a minute, and refunds one it cannot open in about 2h10m. A pack
 * still unsettled after this needs a person, so the work stops hammering CC and says so.
 */
export const PACK_REVIEW_MS = 6 * 3600_000;
/** How often something flagged for review is looked at again, in case it settles by itself. */
export const REVIEW_CHECK_MS = 10 * 60_000;
