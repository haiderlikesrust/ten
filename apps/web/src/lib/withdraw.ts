import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

/** Lamports as SOL, rounded up to the next 0.001 so that sending the printed amount is always enough. */
const solUp = (lamports: number): string => (Math.ceil(lamports / 1e6) / 1e3).toFixed(3);

/** Builds a USDC withdrawal in the browser. It is only ever signed by the user. */
export async function buildWithdraw(
  input: { from: string; to: string; amount: number; usdcMint: string },
  connection: Pick<Connection, "getLatestBlockhash" | "getBalance" | "getAccountInfo" | "getMinimumBalanceForRentExemption">,
): Promise<Uint8Array> {
  let to: PublicKey;
  try {
    to = new PublicKey(input.to);
  } catch {
    throw new Error("That isn't a valid Solana address. Check it and try again.");
  }
  if (!PublicKey.isOnCurve(to.toBytes())) {
    // Sending to a program-derived address would strand the USDC where nobody can sign for it.
    throw new Error("That address can't receive USDC directly. Send to a normal wallet address, like the one in Phantom.");
  }
  if (!(input.amount > 0) || !Number.isFinite(input.amount)) throw new Error("Enter an amount above zero.");
  const from = new PublicKey(input.from);
  if (to.equals(from)) throw new Error("That's your trading wallet itself. Send to another wallet, like the one you signed in with.");
  const mint = new PublicKey(input.usdcMint);
  const source = getAssociatedTokenAddressSync(mint, from);
  const destination = getAssociatedTokenAddressSync(mint, to);
  const [{ blockhash }, lamports, receiver, rent, keep] = await Promise.all([
    connection.getLatestBlockhash(),
    connection.getBalance(from),
    connection.getAccountInfo(destination),
    connection.getMinimumBalanceForRentExemption(165),
    connection.getMinimumBalanceForRentExemption(0),
  ]);
  // The trading wallet pays the network fee, plus the rent for the receiver's USDC account if it has none yet. It
  // only ever holds USDC unless the user sends it SOL, so a withdrawal without SOL would fail in the wallet popup.
  // Solana also refuses to leave a wallet with less SOL than its own minimum, so that much has to be left over.
  const needed = 10_000 + keep + (receiver ? 0 : rent);
  if (lamports < needed) {
    throw new Error(`Your trading wallet needs ${solUp(needed - lamports)} more SOL for the network fee${receiver ? "" : " and to open the receiving USDC account"}. Send it that much, then try again.`);
  }
  const tx = new Transaction({ feePayer: from, recentBlockhash: blockhash });
  tx.add(createAssociatedTokenAccountIdempotentInstruction(from, destination, to, mint));
  tx.add(createTransferCheckedInstruction(source, mint, destination, from, Math.round(input.amount * 1e6), 6));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}
