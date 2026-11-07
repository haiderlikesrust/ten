// READ-ONLY. Shows exactly how the live pump programs respond to our fee instructions.
// Uses simulateTransaction with sigVerify=false, so nothing is signed, sent, or spent.
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CARDS = new PublicKey("CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp");
const PAYER = new PublicKey("GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3");
const ix = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const pda = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const creator = Keypair.generate().publicKey;
const mintInfo = await connection.getAccountInfo(CARDS);
const tokenProgram = mintInfo?.owner ?? TOKEN_PROGRAM_ID;
console.log("$CARDS token program", tokenProgram.toBase58());
const creatorAta = getAssociatedTokenAddressSync(CARDS, creator, true, tokenProgram);

const vault = pda([Buffer.from("creator-vault"), creator.toBuffer()], PUMP);
const curve = new TransactionInstruction({
  programId: PUMP, data: Buffer.from(ix("collect_creator_fee_v2")),
  keys: [
    { pubkey: creator, isSigner: false, isWritable: true },
    { pubkey: creatorAta, isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(CARDS, vault, true, tokenProgram), isSigner: false, isWritable: true },
    { pubkey: CARDS, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: ATA, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: pda([Buffer.from("__event_authority")], PUMP), isSigner: false, isWritable: false },
    { pubkey: PUMP, isSigner: false, isWritable: false },
  ],
});

const ammVault = pda([Buffer.from("creator_vault"), creator.toBuffer()], AMM);
const amm = new TransactionInstruction({
  programId: AMM, data: Buffer.from(ix("collect_coin_creator_fee")),
  keys: [
    { pubkey: CARDS, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: creator, isSigner: false, isWritable: false },
    { pubkey: ammVault, isSigner: false, isWritable: false },
    { pubkey: getAssociatedTokenAddressSync(CARDS, ammVault, true, tokenProgram), isSigner: false, isWritable: true },
    { pubkey: creatorAta, isSigner: false, isWritable: true },
    { pubkey: pda([Buffer.from("__event_authority")], AMM), isSigner: false, isWritable: false },
    { pubkey: AMM, isSigner: false, isWritable: false },
  ],
});

async function run(label: string, target: TransactionInstruction) {
  const tx = new Transaction({ feePayer: PAYER, blockhash: (await connection.getLatestBlockhash()).blockhash, lastValidBlockHeight: 0 });
  tx.add(createAssociatedTokenAccountIdempotentInstruction(PAYER, creatorAta, creator, CARDS, tokenProgram), target);
  const sim = await connection.simulateTransaction(new VersionedTransaction(VersionedMessage.deserialize(tx.compileMessage().serialize())), { sigVerify: false, replaceRecentBlockhash: true });
  console.log(`\n=== ${label}`);
  console.log("err", JSON.stringify(sim.value.err));
  console.log((sim.value.logs ?? []).filter((line) => /invoke \[1\]|Instruction:|AnchorError|failed|success|Program log/.test(line)).slice(-9).join("\n"));
}

await run("collect_creator_fee_v2 (curve)", curve);
await run("collect_coin_creator_fee (amm)", amm);
