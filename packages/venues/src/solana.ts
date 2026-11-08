// The only file allowed to put a transaction on a real chain. A test enforces that.
import { createHash, createPublicKey, verify } from "node:crypto";
import { rarityFromTier, usd, type Micros, type Rarity } from "@gemdex/core";
import { getSetting, type Db } from "@gemdex/db";
import { transferV1 } from "@metaplex-foundation/mpl-core";
import { createNoopSigner, publicKey as umiKey } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { fromWeb3JsPublicKey, toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import {
  AccountLayout, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedMessage, VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { CARDS_MINT as CARDS_ADDRESS } from "./tokens";
import { CcRead, ccEndpointsFor, type CcEndpoints } from "./cc-read";
import { createSigner, type AnyTx, type Signer } from "./signers";
import {
  AddressBlocked, AmbiguousSend, CardFrozen, MachineDown, TxRefused, role, type BuybackQuote, type ChainOp, type ChainVenue, type FeeVenue, type GachaVenue,
  type GeneratedPack, type MarketVenue, type Mode, type OpenResult, type PaidPack, type Party, type PreparedTx, type Role, type TxStatus, type UsdcMoved, type Venue,
} from "./types";

export const GENESIS = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
} as const;

const USDC = { devnet: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr", mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } as const;
const CARDS_MINT = new PublicKey(CARDS_ADDRESS);
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const JUPITER = "https://api.jup.ag/swap/v2";

/** CC answers in a second or two. A hung call must not hold a worker step past its lease. */
const CC_TIMEOUT_MS = 15_000;
/** CC's submitTransaction waits for confirmation before it answers, so it gets longer. */
const SUBMIT_TIMEOUT_MS = 45_000;
const RPC_TIMEOUT_MS = 8_000;
/** One empty answer from chain history can be a lagging node, so an expiry is checked again this much later. */
const EXPIRY_RECHECK_MS = 60_000;
/** CC normally sees a paid pack within seconds. Past this it is asked to open it, at most once a minute. */
const NUDGE_AFTER_MS = 30_000;
const NUDGE_EVERY_MS = 60_000;
/** Every real CC buyback, in micros, falls inside this range (the same bounds lev uses). */
const MIN_BUYBACK = 10_000;
const MAX_BUYBACK = 280_000_000_000;
/** Most SOL a seller may spend on one sale: the network fee plus any rent CC asks for. */
const MAX_SALE_LAMPORTS = 10_000_000n;
/** CC refusing to sell from a machine right now. Nothing is charged. */
const MACHINE_UNAVAILABLE = /machine is (low|off|empty)|off balance/i;

const anchorIx = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/** How a signed transaction reaches the chain. CC co-signs its own, so those go through CC. */
interface Envelope {
  via: "rpc" | "gacha" | "market" | "jupiter";
  b64: string;
  signature: string;
  /** The transaction's own blockhash. Once it is invalid the bytes can never land. */
  blockhash?: string;
  /** Kept for envelopes saved before `blockhash` was. */
  lastValidBlockHeight?: number;
  wallet?: string;
  requestId?: string;
}

export interface SolanaConfig {
  mode: Exclude<Mode, "paper">;
  connection: Connection;
  signer: Signer;
  db: Db;
  endpoints: CcEndpoints;
  ccApiKey?: string;
  jupiterKey?: string;
  tokenMint?: PublicKey;
  /** Skips the genesis check. Only tests inject this. */
  fetchImpl?: typeof fetch;
}

/** Stops a devnet build pointing at mainnet money, and the reverse. */
export async function assertCluster(connection: Connection, mode: Exclude<Mode, "paper">): Promise<void> {
  const actual = await connection.getGenesisHash();
  if (actual !== GENESIS[mode]) throw new Error(`RPC is not ${mode}: genesis ${actual}`);
}

/** Mainnet signing needs an admin to arm it, and the arm expires. */
export async function assertArmed(db: Db, mode: Mode): Promise<void> {
  if (mode !== "mainnet") return;
  const ops = await getSetting(db, "ops");
  if (ops.killSwitch) throw new Error("kill switch is on");
  const until = ops.armedUntil ? new Date(ops.armedUntil).getTime() : 0;
  if (until <= Date.now() || ops.armedBy.length === 0) throw new Error("mainnet is not armed");
}

const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromB64 = (text: string) => Buffer.from(text, "base64");
const blank = (signature: Uint8Array | undefined) => !signature || signature.every((b) => b === 0);

function isVersioned(bytes: Buffer): boolean {
  try {
    return VersionedTransaction.deserialize(bytes).version !== "legacy";
  } catch {
    return false;
  }
}

function publicKeyOrNull(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    return null;
  }
}

/** CC's insured value, or null while it has none. A blank or zero must never read as a $0 card. */
function insuredMicros(raw: unknown): Micros | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(String(raw).replace(/[$,\s]/g, ""));
  return Number.isFinite(value) && value > 0 ? usd(value) : null;
}

const RARITIES: Rarity[] = ["common", "uncommon", "rare", "epic"];
const rarityName = (raw: unknown): Rarity | null => {
  const name = String(raw ?? "").toLowerCase() as Rarity;
  return RARITIES.includes(name) ? name : null;
};

// Pack policy -------------------------------------------------------------------

const PACK_MEMO_PROGRAMS = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
const PACK_MEMO = /^[a-zA-Z0-9_-]{1,64}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function signedBy(message: Uint8Array, signature: Uint8Array | undefined, key: PublicKey): boolean {
  if (!signature || signature.length !== 64) return false;
  const jwk = { kty: "OKP", crv: "Ed25519", x: Buffer.from(key.toBytes()).toString("base64url") };
  return verify(null, message, createPublicKey({ key: jwk, format: "jwk" }), signature);
}

export interface PackIntent {
  /** Our wallet, which pays for the pack and signs. */
  player: PublicKey;
  /** CC's payment wallet. Null where it is not known yet (devnet). */
  wallet: PublicKey | null;
  mint: PublicKey;
  amount: bigint;
  memo: string;
}

/**
 * Checks that CC's pack transaction does what was agreed and nothing else, before anything is
 * signed. Ported from lev (cc/pack-policy.ts), which runs it with real money. CC's message is never altered.
 */
export function validatePackPayment(tx: VersionedTransaction, intent: PackIntent): void {
  const { player, wallet, mint, amount, memo } = intent;
  if (amount <= 0n || amount > 5_000_000_000n || amount % 1_000_000n !== 0n || !PACK_MEMO.test(memo)) throw new TxRefused("invalid pack purchase intent");
  if (tx.message.addressTableLookups.length) throw new TxRefused("the pack uses address lookup tables");
  const message = TransactionMessage.decompile(tx.message);
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  // CC's own key. Where its payment wallet is not known, the one other signer stands in for it.
  const cc = wallet ?? signers.find((k) => !k.equals(player)) ?? null;
  const isCc = (key: PublicKey) => !!cc && key.equals(cc);
  const sponsored = isCc(message.payerKey);
  // A funded player pays the fee, but CC still co-signs the memo. No other signer is allowed.
  if (
    (!sponsored && !message.payerKey.equals(player)) || signers.length < 1 || signers.length > 2 || (sponsored && signers.length !== 2) ||
    !signers.some((k) => k.equals(player)) || signers.some((k) => !k.equals(player) && !isCc(k))
  ) {
    throw new TxRefused(`the pack asks for an unexpected signer or fee payer (fee payer ${message.payerKey.toBase58()})`);
  }
  const ccIndex = signers.findIndex(isCc);
  if (ccIndex >= 0 && !signedBy(tx.message.serialize(), tx.signatures[ccIndex], cc!)) throw new TxRefused("CC's signature on the pack is missing or invalid");

  const source = getAssociatedTokenAddressSync(mint, player, true);
  // Devnet's payment wallet is not known yet, so there, and only there, the destination goes unchecked.
  // Amount, mint, source and authority are still exact. Setting CC_PAYMENT_WALLET checks it too.
  const destination = wallet ? getAssociatedTokenAddressSync(mint, wallet, true) : null;
  let payments = 0, memos = 0, creates = 0, units = 200_000, microLamports = 0n;
  const budgets = new Set<number>();
  for (const ix of message.instructions) {
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      const checked = ix.data[0] === 12, transfer = ix.data[0] === 3;
      const keyCount = checked ? 4 : 3;
      // CC repeats the payer in the optional signer list. Only that exact duplicate is allowed.
      if (
        (!checked && !transfer) || ix.data.length !== (checked ? 10 : 9) || ix.keys.length < keyCount || ix.keys.length > keyCount + 1 ||
        ix.keys.slice(keyCount).some((k) => !k.pubkey.equals(player) || !k.isSigner)
      ) {
        throw new TxRefused("unsupported token operation in the pack");
      }
      const to = ix.keys[checked ? 2 : 1]!, authority = ix.keys[checked ? 3 : 2]!;
      if (
        !ix.keys[0]!.pubkey.equals(source) || (destination && !to.pubkey.equals(destination)) || !authority.pubkey.equals(player) || !authority.isSigner ||
        ix.data.readBigUInt64LE(1) !== amount || (checked && (!ix.keys[1]!.pubkey.equals(mint) || ix.data[9] !== 6))
      ) {
        throw new TxRefused("the pack pays the wrong asset, recipient or amount");
      }
      payments++;
    } else if (PACK_MEMO_PROGRAMS.has(ix.programId.toBase58())) {
      if (ix.data.toString("utf8") !== `${memo}:open` || ix.keys.some((k) => !k.pubkey.equals(player) && !isCc(k.pubkey))) throw new TxRefused("the pack memo does not match the reserved pack");
      memos++;
    } else if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      const op = ix.data[0]!;
      if (ix.keys.length || budgets.has(op)) throw new TxRefused("invalid compute budget in the pack");
      budgets.add(op);
      if (op === 2 && ix.data.length === 5) units = ix.data.readUInt32LE(1);
      else if (op === 3 && ix.data.length === 9) microLamports = ix.data.readBigUInt64LE(1);
      else throw new TxRefused("unsupported compute budget in the pack");
    } else if (ix.programId.equals(ATA_PROGRAM)) {
      // Only an idempotent creation of CC's USDC account is needed. A part we do not know (devnet) goes unchecked.
      const expected = [message.payerKey, destination, wallet, mint, SystemProgram.programId, TOKEN_PROGRAM_ID];
      if (ix.data.length !== 1 || ix.data[0] !== 1 || ix.keys.length !== 6 || ix.keys.some((k, i) => !!expected[i] && !k.pubkey.equals(expected[i]!))) {
        throw new TxRefused("unexpected token account creation in the pack");
      }
      creates++;
    } else throw new TxRefused(`unexpected instruction in the pack (${ix.programId.toBase58()})`);
  }
  // The priority fee is units times micro-lamports per unit: at most 0.001 SOL.
  if (payments !== 1 || memos !== 1 || creates > 1 || units < 1 || units > 400_000 || (BigInt(units) * microLamports) / 1_000_000n > 1_000_000n) {
    throw new TxRefused("the pack's shape or fee is outside policy");
  }
}

// Chain -------------------------------------------------------------------------

class SolanaChain implements ChainVenue {
  private readonly usdc: PublicKey;
  private readonly umi;
  private readonly fetcher: typeof fetch;
  /** When each signature was first seen expired and missing from history. Lost on restart, which only means waiting again. */
  private readonly expiredSeen = new Map<string, number>();

  constructor(private readonly config: SolanaConfig) {
    this.usdc = new PublicKey(USDC[config.mode]);
    this.umi = createUmi(config.connection.rpcEndpoint);
    this.fetcher = config.fetchImpl ?? fetch;
  }

  private address(party: Party) {
    return this.config.signer.addressOf(party);
  }

  private async ata(party: Party) {
    return getAssociatedTokenAddressSync(this.usdc, await this.address(party), true);
  }

  private async usdcIx(from: Party, to: Party, amount: Micros, payer: PublicKey) {
    const owner = await this.address(from);
    const destination = await this.ata(to);
    return [
      createAssociatedTokenAccountIdempotentInstruction(payer, destination, await this.address(to), this.usdc),
      createTransferCheckedInstruction(await this.ata(from), this.usdc, destination, owner, amount, 6),
    ];
  }

  private async coreIx(nft: string, from: PublicKey, to: PublicKey, payer: PublicKey, collection?: string): Promise<TransactionInstruction[]> {
    return transferV1(this.umi, {
      asset: umiKey(nft),
      collection: collection ? umiKey(collection) : undefined,
      newOwner: fromWeb3JsPublicKey(to),
      payer: createNoopSigner(fromWeb3JsPublicKey(payer)),
      authority: createNoopSigner(fromWeb3JsPublicKey(from)),
    }).getInstructions().map(toWeb3JsInstruction);
  }

  /** CC cards carry a collection, and the transfer must name it. */
  private async collectionOf(nft: string): Promise<string | undefined> {
    const account = await this.config.connection.getAccountInfo(new PublicKey(nft));
    if (!account) throw new Error(`no such asset ${nft}`);
    const { deserializeAssetV1 } = await import("@metaplex-foundation/mpl-core");
    const asset = deserializeAssetV1({
      publicKey: umiKey(nft), executable: account.executable, owner: umiKey(account.owner.toBase58()),
      lamports: { basisPoints: BigInt(account.lamports), identifier: "SOL", decimals: 9 }, rentEpoch: 0n, exists: true, data: account.data,
    } as never);
    if (asset.permanentFreezeDelegate?.frozen || asset.freezeDelegate?.frozen) throw new CardFrozen("card is frozen");
    return asset.updateAuthority.type === "Collection" ? asset.updateAuthority.address : undefined;
  }

  private async own(instructions: TransactionInstruction[], signers: Party[]): Promise<PreparedTx> {
    const payerParty = role("feePayer");
    const payer = await this.address(payerParty);
    const { blockhash, lastValidBlockHeight } = await this.config.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }));
    tx.add(...instructions);
    // Treasury keys sign last, so a user signing failure never produces a half-treasury transaction.
    for (const party of [payerParty, ...signers]) await this.config.signer.sign(tx, party);
    const bytes = tx.serialize({ requireAllSignatures: true, verifySignatures: false });
    return this.envelope({ via: "rpc", b64: toB64(bytes), signature: bs58.encode(tx.signature!), blockhash, lastValidBlockHeight });
  }

  /**
   * CC builds these. The party signs and CC or its marketplace submits them. `check` runs on the
   * unsigned bytes and refuses anything that is not what we agreed to. Nothing is signed after the
   * blockhash has died: those bytes could never land, and signing them again would loop forever.
   */
  private async ccBuilt(
    raw: string,
    party: Party,
    via: "gacha" | "market",
    policy: { check?: (tx: VersionedTransaction) => Promise<void> | void; simulate?: boolean } = {},
  ): Promise<PreparedTx> {
    const bytes = fromB64(raw);
    const unsigned = VersionedTransaction.deserialize(bytes);
    // web3.js cannot sign newer formats. Nothing is signed, so no money moves.
    if (unsigned.version !== 0 && unsigned.version !== "legacy") throw new TxRefused(`unsupported transaction version ${String(unsigned.version)}`);
    await policy.check?.(unsigned);
    const blockhash = unsigned.message.recentBlockhash;
    if (!(await this.config.connection.isBlockhashValid(blockhash, { commitment: "confirmed" })).value) throw new TxRefused("the transaction expired before it was signed");

    const wallet = await this.address(party);
    let signed: AnyTx;
    if (isVersioned(bytes)) signed = await this.config.signer.sign(VersionedTransaction.deserialize(bytes), party);
    else signed = await this.config.signer.sign(Transaction.from(bytes), party);
    const serialized = signed instanceof VersionedTransaction ? signed.serialize() : signed.serialize({ requireAllSignatures: false, verifySignatures: false });
    const tx = VersionedTransaction.deserialize(serialized);
    const index = tx.message.staticAccountKeys.findIndex((key) => key.equals(wallet));
    // The first signature is the transaction's id. An empty one would track nothing.
    if (blank(tx.signatures[0]) || index < 0 || blank(tx.signatures[index])) throw new Error("signing left a required signature empty");
    if (policy.simulate) {
      const simulation = await this.config.connection.simulateTransaction(tx, { sigVerify: true, commitment: "confirmed" });
      if (simulation.value.err) throw new Error(`simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }
    return this.envelope({ via, b64: toB64(serialized), signature: bs58.encode(tx.signatures[0]!), blockhash, wallet: wallet.toBase58() });
  }

  private async checkPack(tx: VersionedTransaction, op: Extract<ChainOp, { type: "ccPack" }>) {
    const wallet = this.config.endpoints.paymentWallet;
    validatePackPayment(tx, { player: await this.address(op.payer), wallet: wallet ? new PublicKey(wallet) : null, mint: this.usdc, amount: BigInt(op.amount), memo: op.memo });
  }

  /**
   * Checks CC's sale by simulating it: the seller's USDC must not fall, its SOL may only pay fees,
   * and the recipient must get at least the quote. Ported from lev (cc/sellback.ts).
   */
  private async checkSale(tx: VersionedTransaction, op: Extract<ChainOp, { type: "ccBuyback" }>) {
    // CC's submitTransaction takes v0 only.
    if (tx.version !== 0) throw new TxRefused("CC sent a sale in an unsupported transaction format");
    const seller = await this.address(op.owner);
    const recipient = await this.address(op.recipient);
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    const sellerIndex = signers.findIndex((key) => key.equals(seller));
    if (sellerIndex < 0) throw new TxRefused("the sale is not for this wallet to sign");
    // Any other required signer must be CC itself, which signs before handing the transaction over.
    if (signers.some((_, i) => i !== sellerIndex && blank(tx.signatures[i]))) throw new TxRefused("the sale asks for an unexpected signer");

    const sellerAta = getAssociatedTokenAddressSync(this.usdc, seller, true);
    const recipientAta = getAssociatedTokenAddressSync(this.usdc, recipient, true);
    const addresses = [seller, sellerAta, ...(recipientAta.equals(sellerAta) ? [] : [recipientAta])];
    const recipientAt = addresses.length - 1;
    const connection = this.config.connection;
    const before = await connection.getMultipleAccountsInfo(addresses, "confirmed");
    const simulation = await connection.simulateTransaction(tx, {
      sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: addresses.map((a) => a.toBase58()) },
    });
    if (simulation.value.err) throw new TxRefused(`the sale fails in simulation: ${JSON.stringify(simulation.value.err)}`);
    const after = simulation.value.accounts;
    if (!after || after.length !== addresses.length) throw new Error("sale simulation returned no accounts");
    const tokens = (data: Buffer | null | undefined) => (data && data.length >= 165 ? AccountLayout.decode(data).amount : 0n);
    const afterData = (i: number) => (after[i]?.data?.[0] ? Buffer.from(after[i]!.data[0]!, "base64") : null);
    if (BigInt(before[0]?.lamports ?? 0) - BigInt(after[0]?.lamports ?? 0) > MAX_SALE_LAMPORTS) throw new TxRefused("the sale costs more SOL than a network fee");
    if (tokens(afterData(1)) < tokens(before[1]?.data)) throw new TxRefused("the sale would take USDC from the seller");
    if (tokens(afterData(recipientAt)) - tokens(before[recipientAt]?.data) < BigInt(op.amount)) throw new TxRefused("the sale pays less than CC quoted");
  }

  private envelope(envelope: Envelope): PreparedTx {
    return { signature: envelope.signature, raw: JSON.stringify(envelope), validUntil: new Date(Date.now() + 60_000) };
  }

  private memo(text: string) {
    return new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(text) });
  }

  async prepare(op: ChainOp): Promise<PreparedTx> {
    await assertArmed(this.config.db, this.config.mode);
    const payer = await this.address(role("feePayer"));
    switch (op.type) {
      case "usdc":
        return this.own([...(await this.usdcIx(op.from, op.to, op.amount, payer)), this.memo(op.memo)], [op.from]);
      case "split": {
        const legs = [
          ...(await this.usdcIx(role("fee"), role("cashback"), op.cashback, payer)),
          ...(await this.usdcIx(role("fee"), role("drops"), op.drops, payer)),
        ];
        return this.own([...legs, this.memo(op.memo)], [role("fee")]);
      }
      case "settle": {
        const vault = await this.address(role("vault"));
        const collection = await this.collectionOf(op.nft);
        const legs = [
          ...(await this.usdcIx(op.buyer, role("drops"), op.amount, payer)),
          ...(await this.coreIx(op.nft, vault, new PublicKey(op.deliverTo), payer, collection)),
        ];
        return this.own([...legs, this.memo(op.memo)], [op.buyer, role("vault")]);
      }
      case "core": {
        const from = await this.address(op.from);
        const collection = await this.collectionOf(op.nft);
        return this.own([...(await this.coreIx(op.nft, from, new PublicKey(op.to), payer, collection)), this.memo(op.memo)], [op.from]);
      }
      case "ccPack":
        return this.ccBuilt(op.raw, op.payer, "gacha", { check: (tx) => this.checkPack(tx, op), simulate: true });
      case "ccBuyback":
        return this.ccBuilt(op.raw, op.owner, "gacha", { check: (tx) => this.checkSale(tx, op) });
      case "ccBuy":
        return this.ccBuilt(op.raw, op.buyer, "market");
      case "ccList":
        return this.ccBuilt(op.raw, op.owner, "market");
      case "feeCollect":
        return this.own(await this.collectIx(), []);
      case "swap":
        return this.swap(op.cardsIn, op.minOut);
      case "buyTenr":
        return this.buyTenr(op.from, op.usdcIn, op.minOut);
      case "burnTenr":
        return this.burnTenr(op.owner, op.memo);
    }
  }

  // Buyback and burn (docs/FLYWHEEL.md) ------------------------------------------

  private tenrMint(): PublicKey {
    if (!this.config.tokenMint) throw new Error("GEMDEX_TOKEN_MINT is not set");
    return this.config.tokenMint;
  }

  /** $TENR's decimals and token program. pump.fun mints can be classic SPL Token or Token-2022. */
  async tenrInfo(): Promise<{ decimals: number; program: PublicKey }> {
    const mint = this.tenrMint();
    const account = await this.config.connection.getParsedAccountInfo(mint);
    if (!account.value) throw new Error("the $TENR mint was not found");
    const data = account.value.data as { parsed?: { info?: { decimals?: number } } };
    return { decimals: Number(data.parsed?.info?.decimals ?? 6), program: account.value.owner };
  }

  async quoteTenr(usdcIn: Micros, taker?: string) {
    const params = new URLSearchParams({ inputMint: this.usdc.toBase58(), outputMint: this.tenrMint().toBase58(), amount: String(usdcIn) });
    if (taker) params.set("taker", taker);
    return this.jupiter(`/order?${params}`);
  }

  private async buyTenr(from: Party, usdcIn: Micros, minOut: number): Promise<PreparedTx> {
    const { decimals } = await this.tenrInfo();
    const order = await this.quoteTenr(usdcIn, (await this.address(from)).toBase58());
    const out = Number(order.outAmount ?? 0) / 10 ** decimals;
    if (!order.transaction) throw new Error(`jupiter returned no transaction: ${String(order.errorMessage ?? "unknown")}`);
    if (out < minOut) throw new Error(`buyback quote ${out} $TENR is below the minimum ${minOut}`);
    const tx = await this.config.signer.sign(VersionedTransaction.deserialize(fromB64(String(order.transaction))), from);
    await this.assertPaysOwnFee(tx, from);
    return this.envelope({
      via: "jupiter", b64: toB64(tx.serialize()), signature: bs58.encode(tx.signatures[0]!), requestId: String(order.requestId), blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: Number(order.lastValidBlockHeight ?? (await this.config.connection.getBlockHeight()) + 150),
    });
  }

  private async burnTenr(owner: Party, memo: string): Promise<PreparedTx> {
    const mint = this.tenrMint();
    const { decimals, program } = await this.tenrInfo();
    const wallet = await this.address(owner);
    const ata = getAssociatedTokenAddressSync(mint, wallet, true, program);
    const balance = await this.config.connection.getTokenAccountBalance(ata);
    const amount = BigInt(balance.value.amount);
    if (amount === 0n) throw new TxRefused("there is no $TENR to burn");
    return this.own([createBurnCheckedInstruction(ata, mint, wallet, amount, decimals, [], program), this.memo(memo)], [owner]);
  }

  /** Whole $TENR a party holds. */
  async tenrHeldBy(party: Party): Promise<number> {
    return this.tokenBalance((await this.address(party)).toBase58());
  }

  /** Whole $TENR that arrived for a party in a transaction, read from its balances rather than the quote. */
  async tenrReceivedBy(party: Party, signature: string): Promise<number> {
    const owner = (await this.address(party)).toBase58();
    const mint = this.tenrMint().toBase58();
    const tx = await this.config.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta) throw new Error(`transaction ${signature.slice(0, 8)} is not readable yet`);
    const amount = (list: typeof tx extends null ? never : NonNullable<NonNullable<typeof tx>["meta"]>["postTokenBalances"]) =>
      Number(list?.find((b) => b.owner === owner && b.mint === mint)?.uiTokenAmount.uiAmountString ?? 0);
    return amount(tx?.meta?.postTokenBalances) - amount(tx?.meta?.preTokenBalances);
  }

  /**
   * Where pump.fun keeps the Fee wallet's creator fees until they are claimed: one vault for the bonding curve
   * and one for PumpSwap after graduation, each holding $CARDS.
   */
  private async creatorVaults() {
    const creator = await this.address(role("fee"));
    const mintInfo = await this.config.connection.getAccountInfo(CARDS_MINT);
    const tokenProgram = mintInfo?.owner ?? TOKEN_PROGRAM_ID;
    const pda = (seeds: Array<Buffer | Uint8Array>, program: PublicKey) => PublicKey.findProgramAddressSync(seeds as Buffer[], program)[0];
    const vault = pda([Buffer.from("creator-vault"), creator.toBuffer()], PUMP);
    const ammVault = pda([Buffer.from("creator_vault"), creator.toBuffer()], PUMP_AMM);
    return {
      creator,
      tokenProgram,
      pda,
      creatorAta: getAssociatedTokenAddressSync(CARDS_MINT, creator, true, tokenProgram),
      vault,
      vaultAta: getAssociatedTokenAddressSync(CARDS_MINT, vault, true, tokenProgram),
      ammVault,
      ammVaultAta: getAssociatedTokenAddressSync(CARDS_MINT, ammVault, true, tokenProgram),
    };
  }

  /**
   * $CARDS earned as creator fees that nobody has claimed yet. Nothing counts before $TENR exists, because the
   * worker cannot claim without its mint.
   */
  async cardsUnclaimed(): Promise<number> {
    if (!this.config.tokenMint) return 0;
    const { vaultAta, ammVaultAta } = await this.creatorVaults();
    // A vault only exists once fees have reached it.
    const balance = (account: PublicKey) =>
      this.config.connection.getTokenAccountBalance(account).then((b) => Number(b.value.uiAmount ?? 0), () => 0);
    const [curve, pool] = await Promise.all([balance(vaultAta), balance(ammVaultAta)]);
    return curve + pool;
  }

  /**
   * Both instructions are permissionless. Simulation against the live programs confirms they
   * are recognized, but a real collection stays unproven until the canary. See docs/SPIKE.md.
   */
  private async collectIx(): Promise<TransactionInstruction[]> {
    const mint = this.config.tokenMint;
    if (!mint) throw new Error("GEMDEX_TOKEN_MINT is not set");
    const payer = await this.address(role("feePayer"));
    const { creator, tokenProgram, pda, creatorAta, vault, vaultAta, ammVault, ammVaultAta } = await this.creatorVaults();
    const curve: TransactionInstruction = new TransactionInstruction({
      programId: PUMP,
      data: Buffer.from(anchorIx("collect_creator_fee_v2")),
      keys: [
        { pubkey: creator, isSigner: false, isWritable: true },
        { pubkey: creatorAta, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: CARDS_MINT, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
        { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: pda([Buffer.from("__event_authority")], PUMP), isSigner: false, isWritable: false },
        { pubkey: PUMP, isSigner: false, isWritable: false },
      ],
    });

    const amm = new TransactionInstruction({
      programId: PUMP_AMM,
      data: Buffer.from(anchorIx("collect_coin_creator_fee")),
      keys: [
        { pubkey: CARDS_MINT, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
        { pubkey: creator, isSigner: false, isWritable: false },
        { pubkey: ammVault, isSigner: false, isWritable: false },
        { pubkey: ammVaultAta, isSigner: false, isWritable: true },
        { pubkey: creatorAta, isSigner: false, isWritable: true },
        { pubkey: pda([Buffer.from("__event_authority")], PUMP_AMM), isSigner: false, isWritable: false },
        { pubkey: PUMP_AMM, isSigner: false, isWritable: false },
      ],
    });

    // Each program fails if its vault does not exist yet, and one failure would sink the whole
    // transaction. A vault only appears once fees have accrued there, so skip the empty side.
    const [curveVault, poolVault] = await this.config.connection.getMultipleAccountsInfo([vaultAta, ammVaultAta]);
    return [
      createAssociatedTokenAccountIdempotentInstruction(payer, creatorAta, creator, CARDS_MINT, tokenProgram),
      ...(curveVault ? [curve] : []),
      ...(poolVault ? [amm] : []),
    ];
  }

  private async jupiter(path: string, init?: RequestInit) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.jupiterKey) headers["x-api-key"] = this.config.jupiterKey;
    const res = await this.fetcher(`${JUPITER}${path}`, { ...init, headers });
    return (await res.json()) as Record<string, unknown>;
  }

  async quoteCards(cards: number, taker?: string) {
    const params = new URLSearchParams({ inputMint: CARDS_MINT.toBase58(), outputMint: this.usdc.toBase58(), amount: String(Math.floor(cards * 1e6)) });
    if (taker) params.set("taker", taker);
    return this.jupiter(`/order?${params}`);
  }

  /**
   * A Jupiter swap must be paid by the wallet doing it. A gasless one is paid and signed by Jupiter only at /execute,
   * so the signature we would track isn't the transaction's real id: it would look lost, and a resend would swap the
   * same money twice. Refused before anything is sent; the swap goes ahead once the wallet holds a little SOL.
   */
  private async assertPaysOwnFee(tx: VersionedTransaction, party: Party) {
    const payer = tx.message.staticAccountKeys[0];
    if (!payer?.equals(await this.address(party)) || blank(tx.signatures[0])) {
      throw new TxRefused("Jupiter offered a swap paid by someone else. Send a little SOL to this wallet so it pays its own fee.");
    }
  }

  private async swap(cardsIn: number, minOut: Micros): Promise<PreparedTx> {
    const fee = role("fee");
    const order = await this.quoteCards(cardsIn, (await this.address(fee)).toBase58());
    const out = Number(order.outAmount ?? 0);
    if (!order.transaction) throw new Error(`jupiter returned no transaction: ${String(order.errorMessage ?? "unknown")}`);
    if (out < minOut) throw new Error(`swap quote ${out} is below the minimum ${minOut}`);
    const tx = await this.config.signer.sign(VersionedTransaction.deserialize(fromB64(String(order.transaction))), fee);
    await this.assertPaysOwnFee(tx, fee);
    return this.envelope({
      via: "jupiter", b64: toB64(tx.serialize()), signature: bs58.encode(tx.signatures[0]!), requestId: String(order.requestId), blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: Number(order.lastValidBlockHeight ?? (await this.config.connection.getBlockHeight()) + 150),
    });
  }

  async simulate(raw: string): Promise<{ ok: boolean; reason?: string }> {
    const envelope = JSON.parse(raw) as Envelope;
    const bytes = fromB64(envelope.b64);
    const tx = isVersioned(bytes) ? VersionedTransaction.deserialize(bytes) : new VersionedTransaction(VersionedMessage.deserialize(Transaction.from(bytes).compileMessage().serialize()));
    const sim = await this.config.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    return sim.value.err ? { ok: false, reason: `simulation failed: ${JSON.stringify(sim.value.err)}` } : { ok: true };
  }

  async send(raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as Envelope;
    await assertArmed(this.config.db, this.config.mode);
    try {
      if (envelope.via === "rpc") {
        await this.config.connection.sendRawTransaction(fromB64(envelope.b64), { skipPreflight: true, maxRetries: 0 });
      } else if (envelope.via === "gacha") {
        await this.submitToGacha(envelope);
      } else if (envelope.via === "market") {
        await this.post(`${this.config.endpoints.apiBase}/marketplace/broadcast`, { wallet: envelope.wallet, signedTransaction: envelope.b64 });
      } else {
        await this.jupiter("/execute", { method: "POST", body: JSON.stringify({ signedTransaction: envelope.b64, requestId: envelope.requestId }) });
      }
    } catch (error) {
      // A rejected request might still have reached the network, so the signature decides.
      throw new AmbiguousSend(error instanceof Error ? error.message : "send failed");
    }
  }

  /**
   * Through CC first, so it registers the payment or sale (its indexer often misses raw sends).
   * Anything short of CC accepting it falls back to a plain RPC send of the same bytes.
   */
  private async submitToGacha(envelope: Envelope) {
    const connection = this.config.connection;
    // The network already has it: submitting again would only wait on it again.
    if ((await connection.getSignatureStatuses([envelope.signature])).value[0]) return;
    let accepted = false;
    try {
      const reply = await this.post(`${this.config.endpoints.gachaBase}/api/submitTransaction`, { signedTransaction: envelope.b64 }, SUBMIT_TIMEOUT_MS);
      // CC's confirmationStatus is not trusted for money: the chain status decides that on the next check.
      accepted = reply.success === true && typeof reply.signature === "string";
    } catch {
      accepted = false;
    }
    if (!accepted) await connection.sendRawTransaction(fromB64(envelope.b64), { skipPreflight: false, maxRetries: 2 });
  }

  private async post(url: string, body: unknown, timeoutMs = CC_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "tenner/0.1" };
    if (this.config.ccApiKey && url.startsWith(this.config.endpoints.gachaBase)) headers["x-api-key"] = this.config.ccApiKey;
    const res = await this.fetcher(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  /**
   * Only a confirmed result is final: a "processed" one can still land on another fork, or vanish.
   * "dead" means the blockhash has expired and chain history, asked twice a minute apart, has nothing.
   */
  async status(signature: string, raw: string): Promise<TxStatus> {
    const connection = this.config.connection;
    const found = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (found?.confirmationStatus === "confirmed" || found?.confirmationStatus === "finalized") {
      this.expiredSeen.delete(signature);
      return found.err ? "failed" : "confirmed";
    }
    if (found) return "pending";
    if (await this.stillValid(JSON.parse(raw) as Envelope)) return "pending";
    // The blockhash is dead, so the bytes can never land from now on. Chain history decides what happened.
    const landed = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (landed && !landed.meta) return "pending";
    if (landed) {
      this.expiredSeen.delete(signature);
      return landed.meta!.err ? "failed" : "confirmed";
    }
    const seen = this.expiredSeen.get(signature);
    if (seen === undefined) {
      this.expiredSeen.set(signature, Date.now());
      return "pending";
    }
    if (Date.now() - seen < EXPIRY_RECHECK_MS) return "pending";
    this.expiredSeen.delete(signature);
    return "dead";
  }

  private async stillValid(envelope: Envelope): Promise<boolean> {
    const connection = this.config.connection;
    if (envelope.blockhash) return (await connection.isBlockhashValid(envelope.blockhash, { commitment: "confirmed" })).value;
    return (await connection.getBlockHeight("confirmed")) <= (envelope.lastValidBlockHeight ?? 0);
  }

  async usdcBalance(party: Party): Promise<Micros> {
    try {
      const balance = await this.config.connection.getTokenAccountBalance(await this.ata(party));
      return Number(balance.value.amount);
    } catch (error) {
      // A wallet that never held USDC has no token account: that is a real zero. A timeout or rate limit is not,
      // and reading it as zero would book a fake withdrawal.
      if (/could not find account/i.test(error instanceof Error ? error.message : String(error))) return 0;
      throw error;
    }
  }

  async tokenBalance(wallet: string): Promise<number> {
    const mint = this.config.tokenMint;
    if (!mint) return 0;
    const accounts = await this.config.connection.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint });
    return accounts.value.reduce((sum, account) => sum + Number(account.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
  }

  async cardsBalance(): Promise<number> {
    const fee = await this.address(role("fee"));
    const mintInfo = await this.config.connection.getAccountInfo(CARDS_MINT);
    try {
      const ata = getAssociatedTokenAddressSync(CARDS_MINT, fee, true, mintInfo?.owner ?? TOKEN_PROGRAM_ID);
      const balance = await this.config.connection.getTokenAccountBalance(ata);
      return Number(balance.value.uiAmount ?? 0);
    } catch {
      return 0;
    }
  }

  /** What actually arrived, read from the confirmed transaction rather than the quote. */
  async usdcReceivedBy(party: Party, signature: string): Promise<Micros> {
    const owner = (await this.address(party)).toBase58();
    const tx = await this.config.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    // RPCs can briefly return nothing for a transaction that just confirmed. Reading that as zero would book the
    // swap as worth nothing, so it is an error and the caller reads again next run.
    if (!tx?.meta) throw new Error(`transaction ${signature.slice(0, 8)} is not readable yet`);
    const amount = (list: typeof tx extends null ? never : NonNullable<NonNullable<typeof tx>["meta"]>["postTokenBalances"]) =>
      Number(list?.find((b) => b.owner === owner && b.mint === this.usdc.toBase58())?.uiTokenAmount.amount ?? 0);
    return amount(tx?.meta?.postTokenBalances) - amount(tx?.meta?.preTokenBalances);
  }

  /**
   * What a confirmed transaction moved into or out of this party's USDC, read from the chain's own before and after
   * balances. Used for transfers made outside Tenner, such as an admin funding a treasury wallet.
   */
  async usdcMoved(party: Party, signature: string): Promise<UsdcMoved> {
    const tx = await this.config.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta) return { status: "missing" };
    if (tx.meta.err) return { status: "failed" };
    const owner = (await this.address(party)).toBase58();
    const usdc = this.usdc.toBase58();
    const total = (list: typeof tx.meta.postTokenBalances) =>
      (list ?? []).filter((b) => b.owner === owner && b.mint === usdc).reduce((sum, b) => sum + Number(b.uiTokenAmount.amount), 0);
    return { status: "ok", amount: total(tx.meta.postTokenBalances) - total(tx.meta.preTokenBalances) };
  }

  /** A sharing config replaces the creator with a Pump Fees account, which breaks collection. */
  async assertNoSharing(): Promise<void> {
    const mint = this.config.tokenMint;
    if (!mint) throw new Error("GEMDEX_TOKEN_MINT is not set");
    const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP);
    const account = await this.config.connection.getAccountInfo(curve);
    if (!account) throw new Error("no bonding curve found for the token");
    const creator = new PublicKey(account.data.subarray(49, 81));
    const owner = await this.config.connection.getAccountInfo(creator);
    if (owner && !owner.owner.equals(SystemProgram.programId)) throw new Error("fee sharing is enabled, which breaks fee collection");
  }
}

// Collector Crypt gacha ------------------------------------------------------------

/** CC's own reason for a refusal, e.g. "Machine is low". It decides between retrying and moving on. */
const ccReason = (json: Record<string, unknown>) => [json.error, json.details, json.message].filter((x) => typeof x === "string" && x).join(" · ").slice(0, 160);

class CcGacha implements GachaVenue {
  private readonly cards: CcRead;
  /** When each pack was first seen waiting, and when CC was last asked to open it. Lost on restart, which only delays a nudge. */
  private readonly waits = new Map<string, { since: number; nudgedAt: number }>();

  constructor(private readonly config: SolanaConfig) {
    this.cards = new CcRead({ endpoints: config.endpoints, apiKey: config.ccApiKey, fetchImpl: config.fetchImpl });
  }

  private headers() {
    return { "Content-Type": "application/json", "User-Agent": "tenner/0.1", ...(this.config.ccApiKey ? { "x-api-key": this.config.ccApiKey } : {}) };
  }

  private async call(path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
    const res = await (this.config.fetchImpl ?? fetch)(`${this.config.endpoints.gachaBase}${path}`, {
      method: body ? "POST" : "GET", headers: this.headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(CC_TIMEOUT_MS),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  /** CC's record of a pack. A 404 is a pack CC has not registered yet. */
  private async packStatus(memo: string): Promise<Record<string, any>> {
    const { status, json } = await this.call(`/api/pack/status?memo=${encodeURIComponent(memo)}`);
    if (status === 404) return {};
    if (status !== 200) throw new Error(`pack status ${status}: ${ccReason(json)}`);
    return json;
  }

  async generate(input: { machine: string; price: Micros; player: Party; deliverTo: string; turbo?: boolean }): Promise<GeneratedPack> {
    const playerAddress = (await this.config.signer.addressOf(input.player)).toBase58();
    // We charge the price in our catalog, so CC must be selling at exactly that price right now.
    const catalog = await this.call("/api/machines");
    if (catalog.status !== 200) throw new Error(`machines ${catalog.status}: ${ccReason(catalog.json)}`);
    const listed = (Array.isArray(catalog.json.machines) ? catalog.json.machines : []).find((m: { code?: unknown }) => m?.code === input.machine);
    if (!listed) throw new MachineDown("This machine is not in Collector Crypt's catalog");
    const price = Number(listed.price);
    if (!Number.isFinite(price) || usd(price) !== input.price) throw new MachineDown(`Collector Crypt's price for this machine is now ${String(listed.price)}`);

    // Turbo stays off until a real Turbo pull has been seen end to end.
    const { status, json } = await this.call("/api/generatePack", { playerAddress, packType: input.machine, altPlayerAddress: input.deliverTo, turbo: false });
    if (status === 403) throw new AddressBlocked("address blocked");
    if (status !== 200) {
      const reason = ccReason(json);
      if (MACHINE_UNAVAILABLE.test(reason)) throw new MachineDown(reason);
      // A rate limit, an outage or a reason we do not know. Nothing happened, so the caller tries again.
      throw new Error(`generatePack ${status}${reason ? `: ${reason}` : ""}`);
    }
    if (typeof json.memo !== "string" || typeof json.transaction !== "string") throw new Error("Collector Crypt sent an invalid pack order");
    return { memo: json.memo, raw: json.transaction, turbo: false };
  }

  /**
   * Ported from lev (cc/purchase.ts). CC's record of the pack is read first and must match the
   * payment we made. Only CC saying `refunded` means refunded, and only a confirmed delivery to the
   * agreed wallet means opened. Anything else waits, or throws for a person to look at.
   */
  async open(paid: PaidPack): Promise<OpenResult> {
    const { memo } = paid;
    const status = await this.packStatus(memo);
    if (status.pack?.refunded === true) return this.settled(memo, { status: "refunded" });
    if (status.pack?.status !== "confirmed") return this.nudge(memo);

    const payer = (await this.config.signer.addressOf(paid.payer)).toBase58();
    // CC sends the card to the delivery wallet, and may record either wallet as the pack's. Both are ours.
    const wallets = [payer, paid.deliverTo];
    if (status.pack.transaction_signature !== paid.signature || !wallets.includes(status.pack.wallet) || status.pack.pack_type !== paid.machine) {
      throw new Error(`CC's record of pack ${memo} does not match the payment`);
    }

    const opened = await this.call("/api/openPack", { memo });
    if (opened.status !== 200) throw new Error(`openPack ${opened.status}: ${ccReason(opened.json)}`);
    const code = opened.json.code;
    if (code === "WAITING_FOR_WEBHOOK" || code === "SEND_PENDING") return { status: "waiting" };
    if (code === "TURBO_MODE_BUYBACK") {
      if (!paid.turbo) throw new Error(`pack ${memo} came back sold through Turbo, which was not asked for`);
      const buyback = Number(opened.json.buybackAmount);
      if (!Number.isSafeInteger(buyback) || buyback <= 0) throw new Error(`pack ${memo} came back sold with no valid amount`);
      return this.settled(memo, {
        status: "opened", nft: null, rarity: rarityFromTier(status.send?.prize_tier) ?? rarityName(opened.json.rarity), insuredValue: insuredMicros(status.send?.insured_value),
        card: {}, roll: Number.isSafeInteger(Number(opened.json.roll)) ? Number(opened.json.roll) : null, turboBuyback: buyback,
      });
    }
    const nft = publicKeyOrNull(opened.json.nft_address);
    if (!nft) throw new Error(`openPack for ${memo} named no valid card`);

    const delivered = await this.packStatus(memo);
    if (delivered.pack?.refunded === true) return this.settled(memo, { status: "refunded" });
    const send = delivered.send;
    if (send?.status !== "confirmed") return { status: "waiting" };
    if (send.nft_address !== nft || send.to_wallet !== paid.deliverTo) throw new Error(`CC's delivery of pack ${memo} does not match the card or wallet`);

    // Everything below is read only after delivery is confirmed.
    const won = opened.json.nftWon ?? {};
    const metadata = won.content?.metadata ?? won.metadata ?? {};
    const attributes: Array<{ trait_type?: unknown; value?: unknown }> = Array.isArray(metadata.attributes) ? metadata.attributes : [];
    const insuredValue = insuredMicros(send.insured_value) ?? insuredMicros(attributes.find((a) => /insured.?value/i.test(String(a?.trait_type ?? "")))?.value);
    const rarity = rarityFromTier(send.prize_tier) ?? rarityName(opened.json.rarity);
    const roll = Number(opened.json.roll ?? send.roll);
    const detail = await this.cards.card(nft).catch(() => null);
    return this.settled(memo, {
      status: "opened", nft, rarity, insuredValue, roll: Number.isSafeInteger(roll) ? roll : null, turboBuyback: null,
      card: {
        // The on-chain name is cut at 32 characters; json_name is the full one.
        name: detail?.itemName ?? metadata.json_name ?? metadata.name ?? "Graded card", image: detail?.frontImage ?? null,
        grader: detail?.gradingCompany ?? null, grade: detail?.grade ?? null, rarity, memo,
      },
    });
  }

  /** Asks CC to open a pack it has not registered yet, as its own site does. openPack never buys. */
  private async nudge(memo: string): Promise<OpenResult> {
    const now = Date.now();
    const wait = this.waits.get(memo) ?? { since: now, nudgedAt: 0 };
    this.waits.set(memo, wait);
    if (now - wait.since >= NUDGE_AFTER_MS && now - wait.nudgedAt >= NUDGE_EVERY_MS) {
      wait.nudgedAt = now;
      await this.call("/api/openPack", { memo }).catch(() => null);
    }
    return { status: "waiting" };
  }

  private settled(memo: string, result: OpenResult): OpenResult {
    this.waits.delete(memo);
    return result;
  }

  async refunded(memo: string): Promise<boolean> {
    return (await this.packStatus(memo)).pack?.refunded === true;
  }

  async buybackQuote(nft: string): Promise<BuybackQuote> {
    const mint = publicKeyOrNull(nft);
    if (!mint) throw new Error(`not a card address: ${nft}`);
    const { status, json } = await this.call(`/api/buyback/available?nft=${encodeURIComponent(mint)}`);
    if (status !== 200) throw new Error(`buyback quote ${status}: ${ccReason(json)}`);
    if (json.available === false) return { available: false, amount: 0, expiresAt: null };
    const amount = Number(json.amount);
    if (json.available !== true || !Number.isSafeInteger(amount) || amount < MIN_BUYBACK || amount > MAX_BUYBACK) throw new Error("Collector Crypt sent an invalid buyback quote");
    const expires = Date.parse(String(json.buybackExpiresAt ?? ""));
    return { available: true, amount, expiresAt: Number.isFinite(expires) ? new Date(expires) : null };
  }

  async buildBuyback(input: { owner: Party; nft: string; recipient?: Party }): Promise<{ raw: string; amount: Micros }> {
    const playerAddress = (await this.config.signer.addressOf(input.owner)).toBase58();
    const altRecipient = input.recipient ? (await this.config.signer.addressOf(input.recipient)).toBase58() : undefined;
    const { status, json } = await this.call("/api/buyback", { playerAddress, nftAddress: input.nft, altRecipient });
    if (status !== 200) throw new Error(`buyback ${status}: ${ccReason(json)}`);
    const amount = Number(json.refundAmount);
    if (typeof json.serializedTransaction !== "string" || !Number.isSafeInteger(amount) || amount < MIN_BUYBACK || amount > MAX_BUYBACK) throw new Error("Collector Crypt did not return a sell offer");
    return { raw: json.serializedTransaction, amount };
  }
}

class CcMarket implements MarketVenue {
  constructor(private readonly config: SolanaConfig) {}

  private async build(path: string, body: unknown): Promise<string> {
    const res = await (this.config.fetchImpl ?? fetch)(`${this.config.endpoints.apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "tenner/0.1", ...(this.config.ccApiKey ? { Authorization: `Bearer ${this.config.ccApiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CC_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
    return text.replace(/^"|"$/g, "");
  }

  async buildBuy(input: { buyer: Party; nft: string; price: Micros }) {
    const wallet = (await this.config.signer.addressOf(input.buyer)).toBase58();
    return { raw: await this.build("/marketplace/buy", { wallet, nftAddress: input.nft, price: input.price / 1e6, isV2Listing: true, tokenStandard: "CoreNft" }) };
  }

  async buildList(input: { owner: Party; nft: string; price: Micros }) {
    const wallet = (await this.config.signer.addressOf(input.owner)).toBase58();
    return { raw: await this.build("/marketplace/list", { wallet, nftAddress: input.nft, price: input.price / 1e6, tokenStandard: "CoreNft" }) };
  }
}

class SolanaFees implements FeeVenue {
  constructor(private readonly chain: SolanaChain) {}

  cardsBalance() {
    return this.chain.cardsBalance();
  }

  cardsUnclaimed() {
    return this.chain.cardsUnclaimed();
  }

  async cardsValue(cards: number): Promise<Micros> {
    if (cards <= 0) return 0;
    const order = await this.chain.quoteCards(cards);
    return Number(order.outAmount ?? 0);
  }

  assertNoSharingConfig() {
    return this.chain.assertNoSharing();
  }

  usdcReceived(signature: string) {
    return this.chain.usdcReceivedBy(role("fee"), signature);
  }

  async tenrQuote(usdcIn: Micros): Promise<number> {
    if (usdcIn <= 0) return 0;
    const [{ decimals }, order] = await Promise.all([this.chain.tenrInfo(), this.chain.quoteTenr(usdcIn)]);
    return Number(order.outAmount ?? 0) / 10 ** decimals;
  }

  tenrReceived(signature: string) {
    return this.chain.tenrReceivedBy(role("drops"), signature);
  }

  tenrHeld(): Promise<number> {
    return this.chain.tenrHeldBy(role("drops"));
  }
}

export function buildSolanaVenue(config: SolanaConfig, addresses: Record<Role, string>): Venue {
  const chain = new SolanaChain(config);
  return {
    mode: config.mode,
    chain,
    gacha: new CcGacha(config),
    market: new CcMarket(config),
    fees: new SolanaFees(chain),
    address: (name) => addresses[name],
  };
}

export async function createSolanaVenue(mode: Mode, db: Db, env: NodeJS.ProcessEnv = process.env): Promise<Venue> {
  if (mode === "paper") throw new Error("use the paper venue");
  if (mode === "mainnet" && env.ALLOW_MAINNET !== "I_UNDERSTAND_THIS_MOVES_REAL_MONEY") {
    throw new Error("mainnet is locked. Set ALLOW_MAINNET after reading docs/LAUNCH.md");
  }
  const rpc = env.SOLANA_RPC_URL || (mode === "devnet" ? "https://api.devnet.solana.com" : undefined);
  if (!rpc) throw new Error("SOLANA_RPC_URL is required");
  // A hung RPC call must not hold a worker step past its lease.
  const connection = new Connection(rpc, {
    commitment: "confirmed",
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(RPC_TIMEOUT_MS)]) }),
  });
  await assertCluster(connection, mode);
  const signer = await createSigner(mode, db, env);
  const roles: Role[] = ["drops", "vault", "cashback", "fee", "feePayer"];
  const addresses = Object.fromEntries(await Promise.all(roles.map(async (name) => [name, (await signer.addressOf(role(name))).toBase58()]))) as Record<Role, string>;
  // Addresses and how each signs, never the keys. Lets you check the setup in the worker's logs.
  const how = { privy: "Privy", key: "private key", seed: "dev seed" } as const;
  console.log(`[venue] treasury wallets on ${mode}: ${roles.map((name) => `${name} ${addresses[name]} (${how[signer.custodyOf?.(name) ?? "privy"]})`).join(", ")}`);
  const endpoints = { ...ccEndpointsFor(mode), ...(env.CC_PAYMENT_WALLET ? { paymentWallet: new PublicKey(env.CC_PAYMENT_WALLET).toBase58() } : {}) };
  return buildSolanaVenue(
    { mode, connection, signer, db, endpoints, ccApiKey: env.CC_API_KEY, jupiterKey: env.JUPITER_API_KEY, tokenMint: env.GEMDEX_TOKEN_MINT ? new PublicKey(env.GEMDEX_TOKEN_MINT) : undefined },
    addresses,
  );
}
