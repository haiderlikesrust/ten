// READ-ONLY. Simulates the Wild Drop settlement transaction against real CC Core cards.
// Uses simulateTransaction with sigVerify=false, so nothing is signed, sent, or spent.
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { createTransferCheckedInstruction } from "@solana/spl-token";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createNoopSigner, publicKey as umiPk } from "@metaplex-foundation/umi";
import { fromWeb3JsPublicKey, toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { deserializeAssetV1, transferV1 } from "@metaplex-foundation/mpl-core";

const CLUSTERS = {
  mainnet: { rpc: "https://api.mainnet-beta.solana.com", gacha: "https://gacha.collectorcrypt.com", usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", usdcSource: "D9CEogjHA6CpS12F8St9zpSco7pQKJB5uR1RqDsuzQZk", payer: "GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3" },
  devnet: { rpc: "https://api.devnet.solana.com", gacha: "https://dev-gacha.collectorcrypt.com", usdc: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr", usdcSource: "9ZSgA3PMjeAU8K6CWzgJ8oDnhZwwSgHZu6KP3X95t7Jq", payer: "A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv" },
} as const;
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

type W = { nft_address: string; insuredValue: number; pack_type: string };

async function run(name: keyof typeof CLUSTERS) {
  const c = CLUSTERS[name];
  const conn = new Connection(c.rpc, "confirmed");
  const umi = createUmi(c.rpc);
  console.log(`\n===== ${name} =====`);
  const res = await fetch(`${c.gacha}/api/getAllWinners?count=40`, { headers: { "User-Agent": "gemdex-spike/0.1" } });
  const { data } = (await res.json()) as { data: W[] };
  const srcInfo = await conn.getParsedAccountInfo(new PublicKey(c.usdcSource));
  const src: any = srcInfo.value?.data;
  const usdcOwner = new PublicKey(src?.parsed?.info?.owner);
  console.log("usdc source owner", usdcOwner.toBase58(), "balance", src?.parsed?.info?.tokenAmount?.uiAmountString);

  let tested = 0;
  const seen: Record<string, number> = {};
  for (const w of data ?? []) {
    if (tested >= 6) break;
    const acct = await conn.getAccountInfo(new PublicKey(w.nft_address));
    if (!acct) continue;
    if (acct.owner.toBase58() !== CORE) { seen[acct.owner.toBase58()] = (seen[acct.owner.toBase58()] ?? 0) + 1; continue; }
    const asset = deserializeAssetV1({ publicKey: umiPk(w.nft_address), executable: acct.executable, owner: umiPk(acct.owner.toBase58()), lamports: { basisPoints: BigInt(acct.lamports), identifier: "SOL", decimals: 9 } as any, rentEpoch: 0n as any, exists: true, data: acct.data } as any);
    tested++;
    const collection = asset.updateAuthority.type === "Collection" ? asset.updateAuthority.address : undefined;
    const pluginKeys = Object.keys(asset).filter((k) => !["publicKey","header","key","owner","updateAuthority","name","uri","seq"].includes(k) && (asset as any)[k]);
    const owner = new PublicKey(asset.owner);
    const newOwner = Keypair.generate().publicKey;
    const payer = new PublicKey(c.payer);

    const coreIxs = transferV1(umi, {
      asset: umiPk(w.nft_address),
      collection,
      newOwner: fromWeb3JsPublicKey(newOwner),
      payer: createNoopSigner(fromWeb3JsPublicKey(payer)),
      authority: createNoopSigner(fromWeb3JsPublicKey(owner)),
    }).getInstructions().map(toWeb3JsInstruction);

    const usdc = new PublicKey(c.usdc);
    const tx = new Transaction();
    tx.feePayer = payer;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }));
    tx.add(createTransferCheckedInstruction(new PublicKey(c.usdcSource), usdc, new PublicKey(c.usdcSource), usdcOwner, 1, 6));
    tx.add(...coreIxs);
    tx.add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("gemdex:drop:spike") }));

    const message = tx.compileMessage();
    const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    const sim = await conn.simulateTransaction(new VersionedTransaction(VersionedMessage.deserialize(message.serialize())), { sigVerify: false, replaceRecentBlockhash: true });
    console.log(JSON.stringify({ card: w.nft_address.slice(0, 8), iv: w.insuredValue, collection: collection?.slice(0, 8), plugins: pluginKeys, royaltyRule: (asset as any).royalties?.ruleSet?.type, frozen: (asset as any).freezeDelegate?.frozen, owner: owner.toBase58().slice(0, 8), txBytes: size, signers: message.header.numRequiredSignatures, ok: sim.value.err === null, err: sim.value.err, cu: sim.value.unitsConsumed }));
    if (sim.value.err) console.log((sim.value.logs ?? []).slice(-6).join("\n"));
  }
  console.log("tested core cards", tested, "non-core owners", seen);
}
await run("mainnet");
await run("devnet");
