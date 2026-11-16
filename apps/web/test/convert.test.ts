import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { checkConvert } from "../src/lib/convert";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const wallet = Keypair.generate().publicKey;

/** A transaction paid for by `payer`. What it does is up to the fake chain below, as in a simulation. */
function swap(payer: PublicKey): string {
  const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [ix] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

function usdcAccount(micros: bigint): Buffer {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(micros, 64);
  return data;
}

/** A chain where the wallet holds 1 SOL and $10, and the swap leaves it with `after`. */
function chain(after: { lamports: number; usdc: bigint }, err: unknown = null) {
  const asked: string[] = [];
  const connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      asked.push(...keys.map((key) => key.toBase58()));
      return [{ lamports: 1_000_000_000, data: Buffer.alloc(0) }, { lamports: 2_039_280, data: usdcAccount(10_000_000n) }];
    },
    simulateTransaction: async () => ({
      context: { slot: 1 },
      value: { err, accounts: [{ lamports: after.lamports, data: ["", "base64"] }, { lamports: 2_039_280, data: [usdcAccount(after.usdc).toString("base64"), "base64"] }] },
    }),
  } as unknown as Pick<Connection, "getMultipleAccountsInfo" | "simulateTransaction">;
  return { connection, asked };
}

// Converting 0.99 SOL, keeping 0.01, for at least $150.
const input = (transaction: string) => ({ transaction, wallet: wallet.toBase58(), lamports: 990_000_000, minUsdc: 150_000_000, usdcMint: USDC, rpcUrl: "http://unused" });

describe("converting SOL to USDC", () => {
  it("signs a swap that sells the SOL and puts the USDC into the same wallet", async () => {
    const { connection, asked } = chain({ lamports: 9_995_000, usdc: 162_000_000n });
    await expect(checkConvert(input(swap(wallet)), connection)).resolves.toBeInstanceOf(Uint8Array);
    // It read this wallet's own USDC account, so USDC sent anywhere else would not count.
    expect(asked).toEqual([wallet.toBase58(), getAssociatedTokenAddressSync(new PublicKey(USDC), wallet, true).toBase58()]);
  });

  it("refuses a swap paid for by someone else", async () => {
    const { connection } = chain({ lamports: 9_995_000, usdc: 162_000_000n });
    await expect(checkConvert(input(swap(Keypair.generate().publicKey)), connection)).rejects.toThrow(/not paid by your trading wallet/);
  });

  it("refuses a swap that sends the USDC elsewhere, or less of it than agreed", async () => {
    const elsewhere = chain({ lamports: 9_995_000, usdc: 10_000_000n });
    await expect(checkConvert(input(swap(wallet)), elsewhere.connection)).rejects.toThrow(/price moved/);
    const short = chain({ lamports: 9_995_000, usdc: 159_000_000n });
    await expect(checkConvert(input(swap(wallet)), short.connection)).rejects.toThrow(/price moved/);
  });

  it("refuses a swap that takes the fee reserve too", async () => {
    const { connection } = chain({ lamports: 0, usdc: 165_000_000n });
    await expect(checkConvert(input(swap(wallet)), connection)).rejects.toThrow(/more SOL than you are converting/);
  });

  it("refuses a swap that would fail", async () => {
    const { connection } = chain({ lamports: 9_995_000, usdc: 162_000_000n }, { InstructionError: [0, "Custom"] });
    await expect(checkConvert(input(swap(wallet)), connection)).rejects.toThrow(/would fail/);
  });
});
