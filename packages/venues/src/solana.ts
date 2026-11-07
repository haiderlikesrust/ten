// The only file allowed to put a transaction on a real chain. A test enforces that.
import { createHash } from "node:crypto";
import { parseUsd, rarityFromTier, type Micros, type Rarity } from "@gemdex/core";
import { getSetting, type Db } from "@gemdex/db";
import { transferV1 } from "@metaplex-foundation/mpl-core";
import { createNoopSigner, publicKey as umiKey } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { fromWeb3JsPublicKey, toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedMessage, VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { CARDS_MINT as CARDS_ADDRESS } from "./tokens";
import { CC_DEVNET, CC_MAINNET, CcRead, type CcEndpoints } from "./cc-read";
import { createSigner, type AnyTx, type Signer } from "./signers";
import {
  AddressBlocked, AmbiguousSend, CardFrozen, MachineDown, role, type BuybackQuote, type ChainOp, type ChainVenue, type FeeVenue, type GachaVenue, type GeneratedPack,
  type MarketVenue, type Mode, type OpenResult, type Party, type PreparedTx, type Role, type TxStatus, type Venue,
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

const anchorIx = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/** How a signed transaction reaches the chain. CC co-signs its own, so those go through CC. */
interface Envelope {
  via: "rpc" | "gacha" | "market" | "jupiter";
  b64: string;
  signature: string;
  lastValidBlockHeight: number;
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

/** Mainnet signing needs two admins to arm it, and the arm expires. */
export async function assertArmed(db: Db, mode: Mode): Promise<void> {
  if (mode !== "mainnet") return;
  const ops = await getSetting(db, "ops");
  if (ops.killSwitch) throw new Error("kill switch is on");
  const until = ops.armedUntil ? new Date(ops.armedUntil).getTime() : 0;
  if (until <= Date.now() || new Set(ops.armedBy).size < 2) throw new Error("mainnet is not armed");
}

const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromB64 = (text: string) => Buffer.from(text, "base64");

function isVersioned(bytes: Buffer): boolean {
  try {
    return VersionedTransaction.deserialize(bytes).version !== "legacy";
  } catch {
    return false;
  }
}

class SolanaChain implements ChainVenue {
  private readonly usdc: PublicKey;
  private readonly umi;
  private readonly fetcher: typeof fetch;

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
    return this.envelope({ via: "rpc", b64: toB64(bytes), signature: bs58.encode(tx.signature!), lastValidBlockHeight });
  }

  /** CC builds these. The party signs and CC or its marketplace submits them. */
  private async ccBuilt(raw: string, party: Party, via: "gacha" | "market"): Promise<PreparedTx> {
    const bytes = fromB64(raw);
    const { lastValidBlockHeight } = await this.config.connection.getLatestBlockhash("confirmed");
    const wallet = (await this.address(party)).toBase58();
    let signed: AnyTx;
    if (isVersioned(bytes)) signed = await this.config.signer.sign(VersionedTransaction.deserialize(bytes), party);
    else signed = await this.config.signer.sign(Transaction.from(bytes), party);
    const serialized = signed instanceof VersionedTransaction ? signed.serialize() : signed.serialize({ requireAllSignatures: false, verifySignatures: false });
    const signature = signed instanceof VersionedTransaction ? bs58.encode(signed.signatures[0]!) : bs58.encode(signed.signature!);
    return this.envelope({ via, b64: toB64(serialized), signature, lastValidBlockHeight, wallet });
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
        return this.ccBuilt(op.raw, op.payer, "gacha");
      case "ccBuyback":
        return this.ccBuilt(op.raw, op.owner, "gacha");
      case "ccBuy":
        return this.ccBuilt(op.raw, op.buyer, "market");
      case "ccList":
        return this.ccBuilt(op.raw, op.owner, "market");
      case "feeCollect":
        return this.own(await this.collectIx(), []);
      case "swap":
        return this.swap(op.cardsIn, op.minOut);
    }
  }

  /**
   * Both instructions are permissionless. Simulation against the live programs confirms they
   * are recognized, but a real collection stays unproven until the canary. See docs/SPIKE.md.
   */
  private async collectIx(): Promise<TransactionInstruction[]> {
    const mint = this.config.tokenMint;
    if (!mint) throw new Error("GEMDEX_TOKEN_MINT is not set");
    const creator = await this.address(role("fee"));
    const payer = await this.address(role("feePayer"));
    const mintInfo = await this.config.connection.getAccountInfo(CARDS_MINT);
    const tokenProgram = mintInfo?.owner ?? TOKEN_PROGRAM_ID;
    const creatorAta = getAssociatedTokenAddressSync(CARDS_MINT, creator, true, tokenProgram);
    const pda = (seeds: Array<Buffer | Uint8Array>, program: PublicKey) => PublicKey.findProgramAddressSync(seeds as Buffer[], program)[0];

    const [vault] = [pda([Buffer.from("creator-vault"), creator.toBuffer()], PUMP)];
    const vaultAta = getAssociatedTokenAddressSync(CARDS_MINT, vault, true, tokenProgram);
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

    const ammVault = pda([Buffer.from("creator_vault"), creator.toBuffer()], PUMP_AMM);
    const ammVaultAta = getAssociatedTokenAddressSync(CARDS_MINT, ammVault, true, tokenProgram);
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

  private async swap(cardsIn: number, minOut: Micros): Promise<PreparedTx> {
    const fee = role("fee");
    const order = await this.quoteCards(cardsIn, (await this.address(fee)).toBase58());
    const out = Number(order.outAmount ?? 0);
    if (!order.transaction) throw new Error(`jupiter returned no transaction: ${String(order.errorMessage ?? "unknown")}`);
    if (out < minOut) throw new Error(`swap quote ${out} is below the minimum ${minOut}`);
    const tx = await this.config.signer.sign(VersionedTransaction.deserialize(fromB64(String(order.transaction))), fee);
    return this.envelope({
      via: "jupiter", b64: toB64(tx.serialize()), signature: bs58.encode(tx.signatures[0]!), requestId: String(order.requestId),
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
        await this.post(`${this.config.endpoints.gachaBase}/api/submitTransaction`, { signedTransaction: envelope.b64 });
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

  private async post(url: string, body: unknown): Promise<void> {
    const res = await this.fetcher(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "tenner/0.1" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  async status(signature: string, raw: string): Promise<TxStatus> {
    const connection = this.config.connection;
    const lookup = async () => (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    const first = await lookup();
    if (first?.err) return "failed";
    if (first?.confirmationStatus === "confirmed" || first?.confirmationStatus === "finalized") return "confirmed";
    const { lastValidBlockHeight } = JSON.parse(raw) as Envelope;
    const height = await connection.getBlockHeight("confirmed");
    if (height <= lastValidBlockHeight) return "pending";
    // The blockhash has expired. One more look closes the gap while a late landing propagates.
    const second = await lookup();
    if (second?.err) return "failed";
    if (second) return "confirmed";
    return "dead";
  }

  async usdcBalance(party: Party): Promise<Micros> {
    try {
      const balance = await this.config.connection.getTokenAccountBalance(await this.ata(party));
      return Number(balance.value.amount);
    } catch {
      return 0;
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
    const amount = (list: typeof tx extends null ? never : NonNullable<NonNullable<typeof tx>["meta"]>["postTokenBalances"]) =>
      Number(list?.find((b) => b.owner === owner && b.mint === this.usdc.toBase58())?.uiTokenAmount.amount ?? 0);
    return amount(tx?.meta?.postTokenBalances) - amount(tx?.meta?.preTokenBalances);
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

class CcGacha implements GachaVenue {
  private readonly cards: CcRead;

  constructor(private readonly config: SolanaConfig, private readonly chain: SolanaChain) {
    this.cards = new CcRead({ endpoints: config.endpoints, apiKey: config.ccApiKey });
  }

  private headers() {
    return { "Content-Type": "application/json", "User-Agent": "tenner/0.1", ...(this.config.ccApiKey ? { "x-api-key": this.config.ccApiKey } : {}) };
  }

  private async call(path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
    const res = await (this.config.fetchImpl ?? fetch)(`${this.config.endpoints.gachaBase}${path}`, { method: body ? "POST" : "GET", headers: this.headers(), body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  async generate(input: { machine: string; player: Party; deliverTo: string; turbo?: boolean }): Promise<GeneratedPack> {
    const playerAddress = (await this.config.signer.addressOf(input.player)).toBase58();
    const { status, json } = await this.call("/api/generatePack", { playerAddress, packType: input.machine, altPlayerAddress: input.deliverTo, turbo: !!input.turbo });
    if (status === 403) throw new AddressBlocked("address blocked");
    if (status !== 200) throw new MachineDown(String(json.details ?? json.error ?? `status ${status}`));
    return { memo: json.memo, raw: json.transaction };
  }

  async open(memo: string): Promise<OpenResult> {
    const { status, json } = await this.call("/api/openPack", { memo });
    if (status === 404 || json.code === "WAITING_FOR_WEBHOOK") return { status: "waiting" };
    if (status === 400) return { status: "dead" };
    if (status !== 200) throw new Error(`openPack ${status}`);
    const pack = await this.call(`/api/pack/status?memo=${encodeURIComponent(memo)}`);
    const send = pack.json.send ?? {};
    const insuredValue = parseUsd(send.insured_value);
    const rarity = (rarityFromTier(send.prize_tier) ?? String(json.rarity ?? "").toLowerCase() ?? null) as Rarity | null;
    if (json.code === "TURBO_MODE_BUYBACK") {
      return { status: "opened", nft: null, rarity, insuredValue, card: {}, roll: send.roll ?? null, turboBuyback: Number(json.buybackAmount) };
    }
    const nft = String(json.nft_address);
    const detail = await this.cards.card(nft).catch(() => null);
    return {
      status: "opened", nft, rarity, insuredValue, roll: json.roll ?? null, turboBuyback: null,
      card: {
        name: detail?.itemName ?? json.nftWon?.content?.metadata?.name ?? "Graded card", image: detail?.frontImage ?? null,
        grader: detail?.gradingCompany ?? null, grade: detail?.grade ?? null, rarity, memo,
      },
    };
  }

  async refunded(memo: string): Promise<boolean> {
    const { json } = await this.call(`/api/pack/status?memo=${encodeURIComponent(memo)}`);
    return json.pack?.refunded === true;
  }

  async buybackQuote(nft: string): Promise<BuybackQuote> {
    const { json } = await this.call(`/api/buyback/available?nft=${encodeURIComponent(nft)}`);
    return { available: !!json.available, amount: Number(json.amount ?? 0), expiresAt: json.buybackExpiresAt ? new Date(json.buybackExpiresAt) : null };
  }

  async buildBuyback(input: { owner: Party; nft: string; recipient?: Party }): Promise<{ raw: string; amount: Micros }> {
    const playerAddress = (await this.config.signer.addressOf(input.owner)).toBase58();
    const altRecipient = input.recipient ? (await this.config.signer.addressOf(input.recipient)).toBase58() : undefined;
    const { status, json } = await this.call("/api/buyback", { playerAddress, nftAddress: input.nft, altRecipient });
    if (status !== 200) throw new Error(`buyback ${status}: ${String(json.error ?? "")}`);
    return { raw: json.serializedTransaction, amount: Number(json.refundAmount) };
  }
}

class CcMarket implements MarketVenue {
  constructor(private readonly config: SolanaConfig) {}

  private async build(path: string, body: unknown): Promise<string> {
    const res = await (this.config.fetchImpl ?? fetch)(`${this.config.endpoints.apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "tenner/0.1", ...(this.config.ccApiKey ? { Authorization: `Bearer ${this.config.ccApiKey}` } : {}) },
      body: JSON.stringify(body),
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
}

export function buildSolanaVenue(config: SolanaConfig, addresses: Record<Role, string>): Venue {
  const chain = new SolanaChain(config);
  return {
    mode: config.mode,
    chain,
    gacha: new CcGacha(config, chain),
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
  const rpc = env.SOLANA_RPC_URL ?? (mode === "devnet" ? "https://api.devnet.solana.com" : undefined);
  if (!rpc) throw new Error("SOLANA_RPC_URL is required");
  const connection = new Connection(rpc, "confirmed");
  await assertCluster(connection, mode);
  const signer = await createSigner(mode, db, env);
  const roles: Role[] = ["drops", "vault", "cashback", "fee", "feePayer"];
  const addresses = Object.fromEntries(await Promise.all(roles.map(async (name) => [name, (await signer.addressOf(role(name))).toBase58()]))) as Record<Role, string>;
  return buildSolanaVenue(
    { mode, connection, signer, db, endpoints: mode === "devnet" ? CC_DEVNET : CC_MAINNET, ccApiKey: env.CC_API_KEY, jupiterKey: env.JUPITER_API_KEY, tokenMint: env.GEMDEX_TOKEN_MINT ? new PublicKey(env.GEMDEX_TOKEN_MINT) : undefined },
    addresses,
  );
}
