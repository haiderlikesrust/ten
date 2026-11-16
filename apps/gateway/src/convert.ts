// SOL sent to a trading wallet, turned into USDC at the user's request. The gateway only asks Jupiter for a swap and
// passes the user's signed answer back: it never signs, and the user's browser checks the swap before approving it.
// The trading wallet keeps a little SOL for its own network fees.
import type { Database } from "@gemdex/db";
import type { FastifyInstance } from "fastify";
import { loadUser, requireUser, userIdFrom } from "./auth";

const JUPITER = "https://api.jup.ag/swap/v2";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = { devnet: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr", mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } as const;

/** SOL left in the wallet: its own minimum balance, a few withdrawals, and sell-back fees if those need it. */
export const SOL_RESERVE = 10_000_000;
/** Below this there is nothing worth converting: the swap's own fee would eat a noticeable share. */
export const SOL_MIN_CONVERT = 15_000_000;
/** The least a conversion may pay out against its quote. */
const SLIPPAGE_BPS = 100;
/** Smallest conversion, in micro-USDC. */
const MIN_USDC = 1_000_000;

export interface ConvertDeps {
  database: Database;
  mode: "paper" | "devnet" | "mainnet";
}

export function convertRoutes(app: FastifyInstance, { database, mode }: ConvertDeps) {
  const { db } = database;
  const rpcUrl = process.env.SOLANA_RPC_URL || (mode === "devnet" ? "https://api.devnet.solana.com" : "");

  async function solBalance(address: string): Promise<number> {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address, { commitment: "confirmed" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { result?: { value?: number }; error?: { message?: string } };
    if (!res.ok || typeof json.result?.value !== "number") throw new Error(json.error?.message ?? `RPC ${res.status}`);
    return json.result.value;
  }

  async function jupiter(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.JUPITER_API_KEY) headers["x-api-key"] = process.env.JUPITER_API_KEY;
    const res = await fetch(`${JUPITER}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Jupiter ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    return (await res.json()) as Record<string, unknown>;
  }

  /** The signed-in user's trading wallet, or a reply already sent saying why not. */
  async function walletOf(request: Parameters<typeof userIdFrom>[0], reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply as never, userId)) return null;
    if (mode === "paper" || !rpcUrl) {
      reply.code(404).send({ error: "Converting SOL is not available here" });
      return null;
    }
    const user = await loadUser(db, userId);
    if (!user) {
      reply.code(401).send({ error: "Session expired" });
      return null;
    }
    return user.tradingWallet;
  }

  /** How much SOL the trading wallet holds, and how much of it could become USDC. */
  app.get("/wallet/sol", async (request, reply) => {
    const wallet = await walletOf(request, reply);
    if (!wallet) return;
    try {
      const lamports = await solBalance(wallet);
      const convertible = Math.max(0, lamports - SOL_RESERVE);
      return { lamports, reserve: SOL_RESERVE, convertible: convertible >= SOL_MIN_CONVERT ? convertible : 0 };
    } catch {
      return reply.code(503).send({ error: "Couldn't read your SOL balance. Try again in a moment." });
    }
  });

  /**
   * A fresh swap of everything above the reserve, for the user to check and sign. Jupiter builds it with the trading
   * wallet as the one that pays its fee. The browser checks it before signing, so a wrong answer here can't move money.
   */
  app.post("/wallet/sol/order", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const wallet = await walletOf(request, reply);
    if (!wallet) return;
    let lamports: number;
    try {
      lamports = await solBalance(wallet);
    } catch {
      return reply.code(503).send({ error: "Couldn't read your SOL balance. Try again in a moment." });
    }
    const amount = lamports - SOL_RESERVE;
    if (amount < SOL_MIN_CONVERT) return reply.code(400).send({ error: "There is not enough SOL above the reserve to convert" });
    const params = new URLSearchParams({ inputMint: SOL_MINT, outputMint: USDC_MINT[mode as "devnet" | "mainnet"], amount: String(amount), taker: wallet, slippageBps: String(SLIPPAGE_BPS) });
    let order: Record<string, unknown>;
    try {
      order = await jupiter(`/order?${params}`);
    } catch {
      return reply.code(503).send({ error: "Couldn't get a price for your SOL right now. Try again in a moment." });
    }
    const quoted = Number(order.outAmount ?? 0);
    if (typeof order.transaction !== "string" || !order.transaction || typeof order.requestId !== "string") {
      return reply.code(503).send({ error: String(order.errorMessage ?? "Jupiter could not build the swap right now. Try again in a moment.") });
    }
    if (!(quoted >= MIN_USDC)) return reply.code(400).send({ error: "That much SOL is worth less than $1, so it is not worth converting" });
    // The least the user accepts. Their browser holds the swap to it before signing.
    const minUsdc = Math.floor((quoted * (10_000 - SLIPPAGE_BPS)) / 10_000);
    return { transaction: order.transaction, requestId: order.requestId, lamports: amount, usdc: quoted, minUsdc };
  });

  /** Sends the swap the user signed. Jupiter submits it and reports how it went. */
  app.post("/wallet/sol/execute", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const wallet = await walletOf(request, reply);
    if (!wallet) return;
    const { signedTransaction, requestId } = (request.body ?? {}) as { signedTransaction?: unknown; requestId?: unknown };
    if (typeof signedTransaction !== "string" || !signedTransaction || typeof requestId !== "string" || !requestId) {
      return reply.code(400).send({ error: "Bad transaction" });
    }
    let result: Record<string, unknown>;
    try {
      result = await jupiter("/execute", { method: "POST", body: JSON.stringify({ signedTransaction, requestId }) });
    } catch {
      // It may still have reached the network, so the user checks before trying again.
      return reply.code(504).send({ error: "We could not confirm the conversion. Check your balance before trying again." });
    }
    if (result.status !== "Success") return reply.code(400).send({ error: "The conversion did not go through. Nothing was swapped." });
    return { signature: result.signature ?? null, usdc: Number(result.outputAmountResult ?? 0) || null };
  });
}
