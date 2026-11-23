import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { friendlySolanaError } from "../src/lib/solana";
import { buildWithdraw } from "../src/lib/withdraw";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const from = Keypair.generate().publicKey.toBase58();

/** A chain where the trading wallet holds `lamports` and the receiver may or may not have a USDC account yet. */
function chain(lamports: number, receiverHasAccount = true) {
  return {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    getBalance: async () => lamports,
    getAccountInfo: async () => (receiverHasAccount ? ({ lamports: 1 } as never) : null),
    getMinimumBalanceForRentExemption: async (size: number) => (size === 0 ? 890_880 : 2_039_280),
  } as unknown as Pick<Connection, "getLatestBlockhash" | "getBalance" | "getAccountInfo" | "getMinimumBalanceForRentExemption">;
}

describe("withdraw", () => {
  it("builds a USDC transfer to a normal wallet, paid by the trading wallet", async () => {
    const to = Keypair.generate().publicKey.toBase58();
    const bytes = await buildWithdraw({ from, to, amount: 20, usdcMint: USDC }, chain(10_000_000));
    const tx = Transaction.from(bytes);
    expect(tx.feePayer?.toBase58()).toBe(from);
    expect(tx.instructions).toHaveLength(2);
  });

  it("says what is wrong instead of failing in the wallet popup", async () => {
    const to = Keypair.generate().publicKey.toBase58();
    await expect(buildWithdraw({ from, to: "not-an-address", amount: 1, usdcMint: USDC }, chain(10_000_000))).rejects.toThrow(/valid Solana address/);
    await expect(buildWithdraw({ from, to: from, amount: 1, usdcMint: USDC }, chain(10_000_000))).rejects.toThrow(/trading wallet itself/);
    await expect(buildWithdraw({ from, to, amount: 0, usdcMint: USDC }, chain(10_000_000))).rejects.toThrow(/above zero/);
    // A program address (off the curve) can't sign for the USDC it would receive.
    const offCurve = PublicKey.findProgramAddressSync([Buffer.from("x")], Keypair.generate().publicKey)[0].toBase58();
    await expect(buildWithdraw({ from, to: offCurve, amount: 1, usdcMint: USDC }, chain(10_000_000))).rejects.toThrow(/normal wallet address/);
    // Too little SOL for the fee and the receiver's new USDC account.
    await expect(buildWithdraw({ from, to, amount: 1, usdcMint: USDC }, chain(900_000, false))).rejects.toThrow(/more SOL/);
  });
});

describe("friendlySolanaError", () => {
  const cases: Array<[unknown, RegExp]> = [
    [new Error("User rejected the request."), /cancelled/],
    [new Error("Transaction simulation failed: Attempt to debit an account but found no record of a prior credit."), /enough SOL/],
    [new Error("Simulation failed. Message: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1."), /doesn't hold that much USDC/],
    [new Error("Blockhash not found"), /moved on/],
    [new Error("429 Too Many Requests"), /busy/],
    [new TypeError("Failed to fetch"), /Couldn't reach/],
    [new Error("Sign in to Tenner first, then try again"), /session ended/],
  ];
  it.each(cases)("explains %s", (error, expected) => {
    expect(friendlySolanaError(error)).toMatch(expected);
  });

  it("keeps an unknown message, shortened", () => {
    expect(friendlySolanaError(new Error("something odd"))).toBe("something odd");
    expect(friendlySolanaError(new Error("x".repeat(500))).length).toBeLessThan(230);
  });
});
