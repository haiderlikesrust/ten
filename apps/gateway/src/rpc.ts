// The browser's Solana RPC. The site used to call an RPC URL built into its scripts, which put any paid key (Helius)
// in every visitor's hands. It now calls this route, which forwards to the server's own SOLANA_RPC_URL, so the key
// stays on the server. Only the calls the site needs are forwarded, reads are rate-limited per visitor, and sending
// a transaction needs a signed-in user, so the route can't be used as a free general-purpose RPC.
import type { FastifyInstance, FastifyReply } from "fastify";
import { userIdFrom } from "./auth";

/** Reads the site and Privy's wallet UI make: balances, accounts, blockhashes, fees, simulations, confirmations. */
const READ_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTransaction",
  "getVersion",
  "isBlockhashValid",
  "simulateTransaction",
]);
/** Calls that put something on chain. They need a session. */
const SEND_METHODS = new Set(["sendTransaction"]);
/** web3.js and @solana/kit send one call at a time; a few per batch is plenty and keeps one request cheap. */
const MAX_BATCH = 10;

interface RpcCall {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
}

/** A JSON-RPC error in the shape web3.js and @solana/kit expect, so they surface its message instead of a parse failure. */
function rpcError(reply: FastifyReply, status: number, id: unknown, message: string) {
  return reply.code(status).send({ jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message } });
}

export function rpcRoutes(app: FastifyInstance, { mode }: { mode: "paper" | "devnet" | "mainnet" }) {
  const upstream = process.env.SOLANA_RPC_URL || (mode === "devnet" ? "https://api.devnet.solana.com" : "");

  app.post("/rpc", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = request.body as RpcCall | RpcCall[] | undefined;
    const calls = Array.isArray(body) ? body : [body];
    const firstId = calls[0]?.id;
    if (!upstream) return rpcError(reply, 503, firstId, "This server has no Solana RPC configured");
    if (calls.length === 0 || calls.length > MAX_BATCH) return rpcError(reply, 400, null, `Send between 1 and ${MAX_BATCH} calls at once`);

    let sends = false;
    for (const call of calls) {
      if (!call || typeof call !== "object" || typeof call.method !== "string") return rpcError(reply, 400, call?.id, "Bad RPC call");
      if (SEND_METHODS.has(call.method)) sends = true;
      else if (!READ_METHODS.has(call.method)) return rpcError(reply, 403, call.id, `${call.method} is not available through this RPC`);
    }
    if (sends && !(await userIdFrom(request))) return rpcError(reply, 401, firstId, "Sign in to Tenner first, then try again");

    let res: Response;
    try {
      res = await fetch(upstream, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(sends ? 30_000 : 15_000),
      });
    } catch {
      return rpcError(reply, 504, firstId, "The Solana network didn't answer in time. Try again in a moment.");
    }
    // Passed through as is, errors included: the caller reads Solana's own error, such as a failed simulation.
    const text = await res.text();
    return reply.code(res.status).header("cache-control", "no-store").type("application/json").send(text);
  });
}
