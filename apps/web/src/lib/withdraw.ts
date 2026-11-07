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
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash });
  tx.add(createAssociatedTokenAccountIdempotentInstruction(from, destination, to, mint));
  tx.add(createTransferCheckedInstruction(source, mint, destination, from, Math.round(input.amount * 1e6), 6));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}
