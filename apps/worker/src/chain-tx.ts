import { and, chainTx, desc, eq, type Db } from "@gemdex/db";
import { AmbiguousSend, type ChainOp } from "@gemdex/venues";
import type { Ctx } from "./ctx";

export interface SendResult {
  status: "confirmed" | "failed" | "pending";
  signature?: string;
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
 */
export async function sendOnce(
  ctx: Ctx,
  purpose: string,
  ref: string,
  build: () => Promise<ChainOp>,
  opts: { deadlineAt?: Date | null; retryFailed?: boolean } = {},
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
    if (opts.retryFailed) return fresh(ctx, purpose, ref, latest.attempt + 1, build, opts);
    return { status: "failed", signature: latest.signature };
  }

  const status = latest.status === "dead" ? "dead" : await ctx.venue.chain.status(latest.signature, latest.raw);
  if (status === "confirmed" || status === "failed") {
    await mark(ctx.db, latest.id, status);
    return { status, signature: latest.signature };
  }
  if (status === "pending") {
    await broadcast(ctx, latest.raw);
    const after = await ctx.venue.chain.status(latest.signature, latest.raw);
    if (after === "confirmed" || after === "failed") {
      await mark(ctx.db, latest.id, after);
      return { status: after, signature: latest.signature };
    }
    return { status: "pending", signature: latest.signature };
  }

  await mark(ctx.db, latest.id, "dead");
  if (opts.deadlineAt && Date.now() > opts.deadlineAt.getTime()) return { status: "failed", signature: latest.signature };
  return fresh(ctx, purpose, ref, latest.attempt + 1, build, opts);
}

async function fresh(
  ctx: Ctx,
  purpose: string,
  ref: string,
  attempt: number,
  build: () => Promise<ChainOp>,
  opts: { deadlineAt?: Date | null },
): Promise<SendResult> {
  const prepared = await ctx.venue.chain.prepare(await build());
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
