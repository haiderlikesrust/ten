// Asks CC devnet to build a pack transaction and decodes it offline. Spends nothing.
import { Keypair, VersionedTransaction, Transaction } from "@solana/web3.js";

const BASE = "https://dev-gacha.collectorcrypt.com";
const buyer = Keypair.generate();
const recipient = Keypair.generate();

const res = await fetch(`${BASE}/api/generatePack`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "User-Agent": "gemdex-spike/0.1" },
  body: JSON.stringify({
    playerAddress: buyer.publicKey.toBase58(),
    packType: "pokemon_25",
    altPlayerAddress: recipient.publicKey.toBase58(),
  }),
});
const text = await res.text();
console.log("status", res.status, "body", text.slice(0, 220));
if (!res.ok) process.exit(0);
const { memo, transaction } = JSON.parse(text) as { memo: string; transaction: string };
const raw = Buffer.from(transaction, "base64");
console.log("memo", memo, "bytes", raw.length);

const versioned = (raw[0]! & 0x80) !== 0 || false;
let tx: VersionedTransaction | null = null;
try {
  tx = VersionedTransaction.deserialize(raw);
} catch {
  tx = null;
}
if (tx) {
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  console.log("version", msg.version, "looksVersioned", versioned);
  console.log("lookups", msg.addressTableLookups.length);
  console.log("requiredSignatures", msg.header.numRequiredSignatures);
  console.log("feePayer", keys[0]);
  console.log("signers", keys.slice(0, msg.header.numRequiredSignatures));
  console.log("signed", tx.signatures.map((s) => s.some((b) => b !== 0)));
  msg.compiledInstructions.forEach((ix, i) => {
    console.log(`ix${i}`, keys[ix.programIdIndex], "accounts", ix.accountKeyIndexes.map((a) => keys[a]), "data", Buffer.from(ix.data).toString("hex").slice(0, 80), "text", Buffer.from(ix.data).toString("utf8").slice(0, 80));
  });
} else {
  const legacy = Transaction.from(raw);
  console.log("legacy feePayer", legacy.feePayer?.toBase58(), "ixs", legacy.instructions.length);
  legacy.instructions.forEach((ix, i) => console.log(`ix${i}`, ix.programId.toBase58(), ix.keys.map((k) => k.pubkey.toBase58()), ix.data.toString("hex").slice(0, 80), ix.data.toString("utf8").slice(0, 80)));
  console.log("signatures", legacy.signatures.map((s) => ({ key: s.publicKey.toBase58(), signed: !!s.signature })));
}
console.log("buyer", buyer.publicKey.toBase58(), "recipient", recipient.publicKey.toBase58());
