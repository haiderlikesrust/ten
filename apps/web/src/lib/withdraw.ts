import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

/** Builds a USDC withdrawal in the browser. It is only ever signed by the user. */
export async function buildWithdraw(input: { from: string; to: string; amount: number; usdcMint: string; rpcUrl: string }): Promise<Uint8Array> {
  const from = new PublicKey(input.from);
  const to = new PublicKey(input.to);
  const mint = new PublicKey(input.usdcMint);
  const connection = new Connection(input.rpcUrl, "confirmed");
  const source = getAssociatedTokenAddressSync(mint, from);
  const destination = getAssociatedTokenAddressSync(mint, to);
  const [{ blockhash }, lamports, receiver, rent] = await Promise.all([
    connection.getLatestBlockhash(),
    connection.getBalance(from),
    connection.getAccountInfo(destination),
    connection.getMinimumBalanceForRentExemption(165),
  ]);
  // The trading wallet pays the network fee, plus the rent for the receiver's USDC account if it has none yet. It
  // only ever holds USDC unless the user sends it SOL, so a withdrawal without SOL would fail in the wallet popup.
  const needed = 10_000 + (receiver ? 0 : rent);
  if (lamports < needed) {
    throw new Error(`Your trading wallet needs ${(needed / 1e9).toFixed(4)} SOL for the network fee${receiver ? "" : " and to open the receiving USDC account"}. Send that much SOL to it, then try again.`);
  }
  const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash });
  tx.add(createAssociatedTokenAccountIdempotentInstruction(from, destination, to, mint));
  tx.add(createTransferCheckedInstruction(source, mint, destination, from, Math.round(input.amount * 1e6), 6));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}
