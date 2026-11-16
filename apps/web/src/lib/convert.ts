import { AccountLayout, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";

/** What the swap may cost in SOL on top of what it sells: the network fee, and opening a USDC account if there is none. */
const MAX_EXTRA_LAMPORTS = 3_000_000;

/**
 * Checks a SOL to USDC swap before the user signs it, by simulating it against the chain. The trading wallet must be
 * one of its signers, and the swap may take no more SOL than the amount being converted plus fees, and must put at
 * least the agreed USDC into that same wallet. The swap comes from Jupiter by way of our server, and this check is
 * what makes signing it safe even if either of them sent something else.
 *
 * Who pays the network fee doesn't matter here. Jupiter often fills small swaps through a market maker that pays it
 * and signs last, when Jupiter sends the swap: the simulation still shows exactly what leaves and reaches the wallet.
 */
export async function checkConvert(
  input: { transaction: string; wallet: string; lamports: number; minUsdc: number; usdcMint: string; rpcUrl: string },
  connection: Pick<Connection, "getMultipleAccountsInfo" | "simulateTransaction"> = new Connection(input.rpcUrl, "confirmed"),
): Promise<Uint8Array> {
  const bytes = Uint8Array.from(atob(input.transaction), (c) => c.charCodeAt(0));
  const tx = VersionedTransaction.deserialize(bytes);
  const wallet = new PublicKey(input.wallet);
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  if (!signers.some((key) => key.equals(wallet))) throw new Error("This swap is not for your trading wallet, so it was not signed. Try again.");

  const usdcAccount = getAssociatedTokenAddressSync(new PublicKey(input.usdcMint), wallet, true);
  const addresses = [wallet, usdcAccount];
  const [before, simulation] = await Promise.all([
    connection.getMultipleAccountsInfo(addresses, "confirmed"),
    connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: addresses.map((a) => a.toBase58()) } }),
  ]);
  if (simulation.value.err) throw new Error("The swap would fail right now. Try again in a moment.");
  const after = simulation.value.accounts;
  if (!after || after.length !== 2) throw new Error("Couldn't check the swap. Try again in a moment.");
  const usdc = (data: Uint8Array | null | undefined) => (data && data.length >= 165 ? Number(AccountLayout.decode(data).amount) : 0);
  const afterUsdc = after[1]?.data?.[0] ? Uint8Array.from(atob(after[1].data[0]), (c) => c.charCodeAt(0)) : null;
  const spent = (before[0]?.lamports ?? 0) - (after[0]?.lamports ?? 0);
  if (spent > input.lamports + MAX_EXTRA_LAMPORTS) throw new Error("This swap would take more SOL than you are converting, so it was not signed.");
  if (usdc(afterUsdc) - usdc(before[1]?.data) < input.minUsdc) throw new Error("The price moved while checking. Try again for a fresh price.");
  return bytes;
}
