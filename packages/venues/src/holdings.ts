// Reads $TENR balances and supply for the access minimum (docs/FLYWHEEL.md). Read-only: nothing here
// signs or sends, so it can run in the gateway as well as the worker.
import { Connection, PublicKey } from "@solana/web3.js";
import { NO_ACCESS_CHECK, PAPER_TENR_SUPPLY, accessFrom, type Access } from "@gemdex/core";
import type { Mode } from "./types";

export interface TokenReader {
  /** $TENR held across these wallets, in whole tokens. */
  balanceOf(wallets: string[]): Promise<number>;
  /** $TENR's current supply, in whole tokens. Burns lower it. */
  supply(): Promise<number>;
}

const SUPPLY_TTL_MS = 60_000;

export function solanaTokenReader(rpcUrl: string, mint: string): TokenReader {
  const connection = new Connection(rpcUrl, "confirmed");
  const mintKey = new PublicKey(mint);
  let supply: { at: number; value: number } | null = null;
  return {
    async balanceOf(wallets) {
      const amounts = await Promise.all(
        wallets.map(async (wallet) => {
          const { value } = await connection.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: mintKey });
          return value.reduce((sum, account) => sum + Number(account.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
        }),
      );
      return amounts.reduce((a, b) => a + b, 0);
    },
    async supply() {
      if (supply && Date.now() - supply.at < SUPPLY_TTL_MS) return supply.value;
      const { value } = await connection.getTokenSupply(mintKey);
      supply = { at: Date.now(), value: Number(value.uiAmount ?? 0) };
      return supply.value;
    },
  };
}

/** Paper mode: balances from the paper chain, against a fixed 1 billion supply. */
export function paperTokenReader(tokenBalance: (wallet: string) => Promise<number>): TokenReader {
  return {
    async balanceOf(wallets) {
      const amounts = await Promise.all(wallets.map(tokenBalance));
      return amounts.reduce((a, b) => a + b, 0);
    },
    async supply() {
      return PAPER_TENR_SUPPLY;
    },
  };
}

/** The reader for this mode, or null when there's no $TENR to check yet (no mint set outside paper). */
export function tokenReaderFor(mode: Mode, env: NodeJS.ProcessEnv, paperBalance?: (wallet: string) => Promise<number>): TokenReader | null {
  if (mode === "paper") return paperBalance ? paperTokenReader(paperBalance) : null;
  const mint = env.GEMDEX_TOKEN_MINT;
  const rpc = env.SOLANA_RPC_URL || (mode === "devnet" ? "https://api.devnet.solana.com" : "");
  if (!mint || !rpc) return null;
  return solanaTokenReader(rpc, mint);
}

/** The wallets whose $TENR counts for a user: the one they connect, their trading wallet, and a linked holder wallet. */
export function walletsOf(user: { connectedWallet: string; tradingWallet: string; holderWallet?: string | null }): string[] {
  return [...new Set([user.connectedWallet, user.tradingWallet, user.holderWallet].filter((w): w is string => !!w))];
}

/** Reads the balance live. Throws if the chain can't be read, so callers decide what an outage means. */
export async function checkAccess(reader: TokenReader | null, wallets: string[], bps: number): Promise<Access> {
  if (!reader || !(bps > 0)) return { ...NO_ACCESS_CHECK, bps };
  const [held, supply] = await Promise.all([reader.balanceOf(wallets), reader.supply()]);
  return accessFrom(held, supply, bps);
}

/** Reads Solana slots and blockhashes, to seed gift draws with a value nobody knows in advance. */
export interface SlotReader {
  /** The newest finalized slot. */
  current(): Promise<number>;
  /** The first finalized block at or after a slot (slots can be skipped). Null until it exists. */
  blockhashAtOrAfter(slot: number): Promise<{ slot: number; blockhash: string } | null>;
}

export function solanaSlotReader(rpcUrl: string): SlotReader {
  const connection = new Connection(rpcUrl, "finalized");
  return {
    current: () => connection.getSlot("finalized"),
    async blockhashAtOrAfter(slot) {
      if ((await connection.getSlot("finalized")) < slot) return null;
      const [first] = await connection.getBlocks(slot, slot + 64, "finalized");
      if (first === undefined) return null;
      const block = await connection.getBlock(first, { commitment: "finalized", maxSupportedTransactionVersion: 0, transactionDetails: "none", rewards: false });
      return block ? { slot: first, blockhash: block.blockhash } : null;
    },
  };
}

/** Null in paper mode, which seeds draws on the server instead. */
export function slotReaderFor(mode: Mode, env: NodeJS.ProcessEnv): SlotReader | null {
  if (mode === "paper") return null;
  const rpc = env.SOLANA_RPC_URL || (mode === "devnet" ? "https://api.devnet.solana.com" : "");
  return rpc ? solanaSlotReader(rpc) : null;
}
