import { Connection } from "@solana/web3.js";
import { GATEWAY, getToken } from "./api";

export const USDC_MINT = process.env.NEXT_PUBLIC_USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEVNET_USDC = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

/**
 * The browser's Solana RPC: the gateway's /rpc route, which forwards to the server's own RPC. No RPC URL or key is
 * built into the site, so a paid key (Helius) never reaches visitors.
 */
export const RPC_URL = `${GATEWAY}/rpc`;

/**
 * Live updates (websockets) can't go through the gateway, so they use Solana's public endpoint, which needs no key.
 * The site itself confirms by asking for the signature's status, so this only serves Privy's own wallet screens.
 */
export const RPC_WS_URL = USDC_MINT === DEVNET_USDC ? "wss://api.devnet.solana.com" : "wss://api.mainnet-beta.solana.com";

/** A connection to the gateway's RPC, carrying the Tenner session, which sending a transaction needs. */
export function solanaConnection(): Connection {
  const token = getToken();
  return new Connection(RPC_URL, { commitment: "confirmed", httpHeaders: token ? { authorization: `Bearer ${token}` } : undefined });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (signature: string) => `${signature.slice(0, 6)}…${signature.slice(-6)}`;

/**
 * Thrown when a transaction was sent but its outcome isn't known, so the user checks before trying again. Pages
 * recognise it by its name, so they don't have to import this module (and all of web3.js with it).
 */
export class UnconfirmedError extends Error {
  override name = "UnconfirmedError";
  constructor(readonly signature: string) {
    super(`It was sent, but we couldn't confirm it yet (${short(signature)}). Check your balance in a minute before trying again.`);
  }
}

/**
 * Sends a signed transaction through the gateway and waits until the network confirms it. Returns its signature.
 * Errors come back in plain words (see friendlySolanaError).
 */
export async function sendAndConfirm(signed: Uint8Array, timeoutMs = 75_000): Promise<string> {
  const connection = solanaConnection();
  let signature: string;
  try {
    // Simulated first (preflight), so a transfer that would fail is refused before it costs a fee.
    signature = await connection.sendRawTransaction(signed, { preflightCommitment: "confirmed", maxRetries: 5 });
  } catch (error) {
    throw new Error(friendlySolanaError(error));
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    const status = await connection.getSignatureStatuses([signature]).then((r) => r.value[0], () => undefined);
    if (status?.err) throw new Error(`It failed on the network, so nothing moved except the small network fee (${short(signature)}).`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
  }
  throw new UnconfirmedError(signature);
}

/** Turns errors from Solana, the RPC, Privy and the browser into something a person can act on. */
export function friendlySolanaError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = `${raw} ${JSON.stringify((error as { logs?: unknown })?.logs ?? "")}`.toLowerCase();
  if (/user rejected|rejected the request|user denied|cancel|closed the modal|user exited/.test(text)) return "You cancelled it. Nothing was sent.";
  if (/sign in to tenner/.test(text)) return "Your session ended. Connect again, then retry.";
  if (/insufficient lamports|insufficient funds for rent|no record of a prior credit|insufficient funds for fee/.test(text)) {
    return "Your trading wallet doesn't have enough SOL for the network fee. Send it about 0.005 SOL, then try again.";
  }
  // SPL Token's InsufficientFunds is custom program error 0x1.
  if (/custom program error: 0x1\b|insufficient funds/.test(text)) return "Your trading wallet doesn't hold that much USDC. Lower the amount and try again.";
  if (/blockhash not found|block height exceeded|expired/.test(text)) return "The network moved on before it went through. Nothing was sent. Try again.";
  if (/429|too many requests|rate limit/.test(text)) return "The network is busy right now. Wait a few seconds and try again.";
  if (/failed to fetch|networkerror|load failed|didn't answer/.test(text)) return "Couldn't reach the network. Check your connection and try again.";
  if (/invalid public key|non-base58|invalid address/.test(text)) return "That isn't a valid Solana address.";
  return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw || "Something went wrong. Try again.";
}
