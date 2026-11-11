import { execSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setSetting } from "@gemdex/db";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { createSigner, LocalSigner, type AnyTx, type Signer } from "../src/signers";
import { assertArmed, assertCluster, buildSolanaVenue, createSolanaVenue, GENESIS } from "../src/solana";
import { CC_DEVNET, role, trader, type Party } from "../src/index";
import { createTestDb, type TestDb } from "../../../tools/testdb";

let t: TestDb;
const ROOT = path.resolve(__dirname, "../../..");

beforeAll(async () => {
  t = await createTestDb(4);
});
afterAll(async () => {
  await t.shutdown();
});

const rpcWith = (genesis: string) => ({ rpcEndpoint: "http://127.0.0.1:1", getGenesisHash: async () => genesis }) as unknown as Connection;

describe("mainnet stays locked", () => {
  it("refuses an RPC on the wrong cluster, in both directions", async () => {
    await expect(assertCluster(rpcWith(GENESIS.devnet), "mainnet")).rejects.toThrow(/not mainnet/);
    await expect(assertCluster(rpcWith(GENESIS.mainnet), "devnet")).rejects.toThrow(/not devnet/);
    await expect(assertCluster(rpcWith(GENESIS.devnet), "devnet")).resolves.toBeUndefined();
  });

  it("will not start on mainnet without the explicit unlock", async () => {
    await expect(createSolanaVenue("mainnet", t.db, { SOLANA_RPC_URL: "http://x" } as never)).rejects.toThrow(/mainnet is locked/);
    await expect(createSolanaVenue("mainnet", t.db, { ALLOW_MAINNET: "yes", SOLANA_RPC_URL: "http://x" } as never)).rejects.toThrow(/mainnet is locked/);
  });

  it("refuses mainnet without Privy, even with treasury keys provided", async () => {
    const key = bs58.encode(Keypair.generate().secretKey);
    await expect(createSigner("mainnet", t.db, { TREASURY_KEY_DROPS: key } as never)).rejects.toThrow(/mainnet needs Privy/);
  });

  it("needs an admin's arm, unexpired, and no kill switch", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    await setSetting(t.db, "ops", { armedBy: [], armedUntil: null, killSwitch: false });
    await expect(assertArmed(t.db, "mainnet")).rejects.toThrow(/not armed/);
    await setSetting(t.db, "ops", { armedBy: [], armedUntil: future });
    await expect(assertArmed(t.db, "mainnet")).rejects.toThrow(/not armed/);
    await setSetting(t.db, "ops", { armedBy: ["a"], armedUntil: past });
    await expect(assertArmed(t.db, "mainnet")).rejects.toThrow(/not armed/);
    await setSetting(t.db, "ops", { armedBy: ["a"], armedUntil: future, killSwitch: true });
    await expect(assertArmed(t.db, "mainnet")).rejects.toThrow(/kill switch/);
    await setSetting(t.db, "ops", { armedBy: ["a"], armedUntil: future, killSwitch: false });
    await expect(assertArmed(t.db, "mainnet")).resolves.toBeUndefined();
    await setSetting(t.db, "ops", { armedBy: [], armedUntil: null });
    await expect(assertArmed(t.db, "devnet")).resolves.toBeUndefined();
  });

  it("refuses to sign anything on mainnet while unarmed", async () => {
    const venue = buildSolanaVenue(
      { mode: "mainnet", connection: rpcWith(GENESIS.mainnet), signer: new LocalSigner("t"), db: t.db, endpoints: CC_DEVNET },
      { drops: "a", vault: "b", cashback: "c", fee: "d", feePayer: "e" },
    );
    await expect(venue.chain.prepare({ type: "usdc", from: role("drops"), to: role("cashback"), amount: 1, memo: "x" })).rejects.toThrow(/not armed/);
  });
});

describe("creator fees waiting to be claimed", () => {
  const mint = Keypair.generate().publicKey;
  const balances = new Map<string, number>();
  const asked: string[] = [];
  /** Set to make every vault hold this much, to learn the vault addresses from a full claim. */
  let everyVault: number | null = null;
  let rpcDown = false;
  const connection = {
    rpcEndpoint: "http://127.0.0.1:1",
    getAccountInfo: async () => null,
    getTokenAccountBalance: async (key: PublicKey) => {
      asked.push(key.toBase58());
      if (rpcDown) throw new Error("429 Too Many Requests");
      const amount = everyVault ?? balances.get(key.toBase58());
      if (amount === undefined) throw new Error("failed to get token account balance: Invalid param: could not find account");
      return { value: { uiAmount: amount } };
    },
  } as unknown as Connection;
  const venueWith = (tokenMint?: PublicKey) =>
    buildSolanaVenue({ mode: "devnet", connection, signer: new LocalSigner("fees"), db: t.db, endpoints: CC_DEVNET, tokenMint }, { drops: "", vault: "", cashback: "", fee: "", feePayer: "" });
  const claim = () => (venueWith(mint).chain as unknown as { collectIx(): Promise<TransactionInstruction[]> }).collectIx();
  const vaultsTheClaimEmpties = async () => {
    everyVault = 1;
    const [, curve, pool] = await claim().finally(() => (everyVault = null));
    return { curve: curve!.keys[3]!.pubkey.toBase58(), pool: pool!.keys[4]!.pubkey.toBase58() };
  };

  it("counts both pump.fun vaults, the same accounts a claim empties", async () => {
    const vaults = await vaultsTheClaimEmpties();
    balances.set(vaults.curve, 120);
    balances.set(vaults.pool, 30.5);
    asked.length = 0;
    expect(await venueWith(mint).fees.cardsUnclaimed()).toBe(150.5);
    expect(new Set(asked)).toEqual(new Set([vaults.curve, vaults.pool]));
  });

  it("counts a vault that does not exist yet as empty", async () => {
    const vaults = await vaultsTheClaimEmpties();
    balances.clear();
    balances.set(vaults.curve, 75);
    expect(await venueWith(mint).fees.cardsUnclaimed()).toBe(75);
  });

  it("claims only from a vault that holds something, so an empty one can't sink the claim", async () => {
    const vaults = await vaultsTheClaimEmpties();
    balances.clear();
    // After graduation the curve's vault is still there, with nothing in it.
    balances.set(vaults.curve, 0);
    balances.set(vaults.pool, 42);
    const onlyPool = await claim();
    expect(onlyPool).toHaveLength(2);
    expect(onlyPool[1]!.keys[4]!.pubkey.toBase58()).toBe(vaults.pool);
    balances.clear();
    expect(await claim()).toHaveLength(1);
  });

  it("never reads a failed balance as an empty wallet", async () => {
    rpcDown = true;
    try {
      await expect(venueWith(mint).fees.cardsBalance()).rejects.toThrow(/429/);
      await expect(venueWith(mint).fees.cardsUnclaimed()).rejects.toThrow(/429/);
    } finally {
      rpcDown = false;
    }
  });

  it("counts nothing before $TENR exists, because the worker cannot claim without its mint", async () => {
    asked.length = 0;
    expect(await venueWith().fees.cardsUnclaimed()).toBe(0);
    expect(asked).toEqual([]);
  });
});

describe("reading the chain", () => {
  const venueOn = (connection: Partial<Connection>, fetchImpl?: typeof fetch) =>
    buildSolanaVenue({ mode: "devnet", connection: { rpcEndpoint: "http://127.0.0.1:1", ...connection } as Connection, signer: new LocalSigner("reads"), db: t.db, endpoints: CC_DEVNET, fetchImpl }, { drops: "", vault: "", cashback: "", fee: "", feePayer: "" });

  it("reads a wallet with no USDC account as zero, but a failed read as an error, never a fake zero", async () => {
    const missing = venueOn({ getTokenAccountBalance: async () => { throw new Error("failed to get token account balance: Invalid param: could not find account"); } });
    expect(await missing.chain.usdcBalance(role("drops"))).toBe(0);
    const down = venueOn({ getTokenAccountBalance: async () => { throw new Error("429 Too Many Requests"); } });
    await expect(down.chain.usdcBalance(role("drops"))).rejects.toThrow(/429/);
  });

  it("refuses a Jupiter swap that someone else pays for, and accepts one the wallet pays itself", async () => {
    const signer = new LocalSigner("reads");
    const fee = await signer.addressOf(role("fee"));
    const order = (payer: PublicKey) => {
      const ix = SystemProgram.transfer({ fromPubkey: fee, toPubkey: Keypair.generate().publicKey, lamports: 1 });
      const message = new TransactionMessage({ payerKey: payer, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [ix] }).compileToV0Message();
      return { transaction: Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"), outAmount: "5000000", requestId: "r1", lastValidBlockHeight: 100 };
    };
    let payer = Keypair.generate().publicKey;
    const fetchImpl = (async () => new Response(JSON.stringify(order(payer)))) as unknown as typeof fetch;
    const venue = venueOn({ getBlockHeight: async () => 1 }, fetchImpl);
    await expect(venue.chain.prepare({ type: "swap", cardsIn: 10, minOut: 1 })).rejects.toThrow(/paid by someone else/);
    payer = fee;
    await expect(venue.chain.prepare({ type: "swap", cardsIn: 10, minOut: 1 })).resolves.toMatchObject({ signature: expect.any(String) });
  });

  it("holds a swap to the least it can pay out, and never takes a Jupiter error for a quote", async () => {
    const signer = new LocalSigner("reads");
    const fee = await signer.addressOf(role("fee"));
    const ix = SystemProgram.transfer({ fromPubkey: fee, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    const message = new TransactionMessage({ payerKey: fee, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [ix] }).compileToV0Message();
    const transaction = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
    let reply: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
    const fetchImpl = (async () => new Response(JSON.stringify(reply.body), { status: reply.status })) as unknown as typeof fetch;
    const venue = venueOn({ getBlockHeight: async () => 1 }, fetchImpl);
    const swap = (minOut: number) => venue.chain.prepare({ type: "swap", cardsIn: 10, minOut });

    // Quoted 1000, but Jupiter's own slippage lets it fill as low as 500: a 985 minimum must refuse it.
    reply = { status: 200, body: { transaction, outAmount: "1000", otherAmountThreshold: "500", requestId: "r", lastValidBlockHeight: 100 } };
    await expect(swap(985)).rejects.toThrow(/as low as 500/);
    await expect(swap(500)).resolves.toMatchObject({ signature: expect.any(String) });
    // A minimum of zero is no minimum.
    await expect(swap(0)).rejects.toThrow(/no minimum/);
    // A rate limit is an error, not a quote worth nothing.
    reply = { status: 429, body: { error: "Too many requests" } };
    await expect(venue.fees.cardsValue(10)).rejects.toThrow(/429/);
    await expect(swap(1)).rejects.toThrow(/429/);
  });

  it("refuses a marketplace purchase that takes more USDC than agreed, or more SOL than a fee", async () => {
    const signer = new LocalSigner("reads");
    const buyer = await signer.addressOf(role("drops"));
    const blockhash = Keypair.generate().publicKey.toBase58();
    const ix = SystemProgram.transfer({ fromPubkey: buyer, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    const raw = Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: buyer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message()).serialize()).toString("base64");
    const usdcAccount = (micros: bigint) => {
      const data = Buffer.alloc(165);
      data.writeBigUInt64LE(micros, 64);
      return data;
    };
    // What the simulation says the wallet holds afterwards.
    let after = { lamports: 1_000_000_000, usdc: 0n };
    const venue = venueOn({
      isBlockhashValid: async () => ({ context: { slot: 1 }, value: true }),
      getMultipleAccountsInfo: (async () => [{ lamports: 1_000_000_000, data: Buffer.alloc(0) }, { lamports: 2_039_280, data: usdcAccount(500_000_000n) }]) as never,
      simulateTransaction: (async () => ({
        context: { slot: 1 },
        value: { err: null, accounts: [{ lamports: after.lamports, data: ["", "base64"] }, { lamports: 2_039_280, data: [usdcAccount(after.usdc).toString("base64"), "base64"] }] },
      })) as never,
    });
    const buy = () => venue.chain.prepare({ type: "ccBuy", buyer: role("drops"), nft: Keypair.generate().publicKey.toBase58(), amount: 120_000_000, raw });

    // The listing was repriced to $180 after the user agreed to $120.
    after = { lamports: 999_990_000, usdc: 320_000_000n };
    await expect(buy()).rejects.toThrow(/more USDC than agreed/);
    after = { lamports: 900_000_000, usdc: 380_000_000n };
    await expect(buy()).rejects.toThrow(/more SOL than a network fee/);
    after = { lamports: 999_990_000, usdc: 380_000_000n };
    await expect(buy()).resolves.toMatchObject({ signature: expect.any(String) });
    // A listing must not take any USDC at all.
    const list = () => venue.chain.prepare({ type: "ccList", owner: role("drops"), nft: Keypair.generate().publicKey.toBase58(), amount: 120_000_000, raw });
    after = { lamports: 999_990_000, usdc: 499_000_000n };
    await expect(list()).rejects.toThrow(/more USDC than agreed/);
    after = { lamports: 999_990_000, usdc: 500_000_000n };
    await expect(list()).resolves.toMatchObject({ signature: expect.any(String) });
  });

  it("looks twice before calling a blockhash expired, because our node may not have seen it yet", async () => {
    const signer = new LocalSigner("reads");
    const owner = await signer.addressOf(role("drops"));
    const ix = SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    const raw = Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [ix] }).compileToV0Message()).serialize()).toString("base64");
    const asked: string[] = [];
    let secondLook = true;
    const venue = venueOn({
      isBlockhashValid: (async (_hash: string, config: { commitment: string }) => {
        asked.push(config.commitment);
        return { context: { slot: 1 }, value: config.commitment === "processed" && secondLook };
      }) as never,
      getMultipleAccountsInfo: (async () => [{ lamports: 5, data: Buffer.alloc(0) }, null]) as never,
      simulateTransaction: (async () => ({ context: { slot: 1 }, value: { err: null, accounts: [{ lamports: 5, data: ["", "base64"] }, null] } })) as never,
    });
    const list = () => venue.chain.prepare({ type: "ccList", owner: role("drops"), nft: Keypair.generate().publicKey.toBase58(), amount: 1, raw });
    await expect(list()).resolves.toMatchObject({ signature: expect.any(String) });
    expect(asked).toEqual(["confirmed", "processed"]);
    secondLook = false;
    await expect(list()).rejects.toThrow(/expired before it was signed/);
  });
});

describe("structure", () => {
  const grep = (pattern: string, dirs: string) => {
    try {
      return execSync(`git grep --no-index -lE "${pattern}" -- ${dirs}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  };

  it("only one file can put a transaction on a chain", () => {
    expect(grep("sendRawTransaction|sendAndConfirm|\\.sendTransaction\\(", "apps/gateway/src apps/worker/src packages/core/src packages/db/src packages/venues/src")).toEqual(["packages/venues/src/solana.ts"]);
  });

  it("the gateway cannot sign: it has no path to signers or the Solana adapter", () => {
    expect(grep("venues/solana|signers|signTransaction|Keypair", "apps/gateway/src")).toEqual([]);
  });

  it("paper code never imports the real adapter statically", () => {
    expect(grep("from \\\"@gemdex/venues/solana\\\"|from \\\"./solana\\\"", "apps/worker/src apps/gateway/src packages/venues/src/index.ts packages/venues/src/paper.ts")).toEqual([]);
  });
});

/** Same addresses as the real parties, signatures stubbed. Lets a real build run against a live RPC. */
class SimSigner implements Signer {
  constructor(private readonly map: (party: Party) => PublicKey) {}
  async addressOf(party: Party) {
    return party.kind === "address" ? new PublicKey(party.address) : this.map(party);
  }
  async sign<T extends AnyTx>(tx: T, party: Party): Promise<T> {
    if (tx instanceof Transaction) tx.addSignature(this.map(party), Buffer.alloc(64, 7));
    else (tx as VersionedTransaction).signatures[0] = new Uint8Array(64).fill(7);
    return tx;
  }
}

// Needs network. Read-only: everything here is simulated and nothing is ever sent.
describe.runIf(process.env.LIVE === "1")("live, read-only", () => {
  it("the real settlement builder passes simulation on a real devnet card", async () => {
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");
    const winners = (await (await fetch(`${CC_DEVNET.gachaBase}/api/getAllWinners?count=20`, { headers: { "User-Agent": "tenner-test" } })).json()) as { data: Array<{ nft_address: string }> };
    const nft = winners.data.map((w) => w.nft_address).find(Boolean)!;
    const { deserializeAssetV1 } = await import("@metaplex-foundation/mpl-core");
    const { publicKey } = await import("@metaplex-foundation/umi");
    const account = (await connection.getAccountInfo(new PublicKey(nft)))!;
    const asset = deserializeAssetV1({ publicKey: publicKey(nft), executable: false, owner: publicKey(account.owner.toBase58()), lamports: { basisPoints: 0n, identifier: "SOL", decimals: 9 }, rentEpoch: 0n, exists: true, data: account.data } as never);

    const gacha = new PublicKey("A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv");
    const owner = new PublicKey(asset.owner);
    const signer = new SimSigner((party) => (party.kind === "role" && party.role === "vault" ? owner : gacha));
    const venue = buildSolanaVenue({ mode: "devnet", connection, signer, db: t.db, endpoints: CC_DEVNET }, { drops: "", vault: "", cashback: "", fee: "", feePayer: "" });

    const buyer = trader("u", gacha.toBase58());
    const prepared = await venue.chain.prepare({ type: "settle", buyer, amount: 1, nft, deliverTo: Keypair.generate().publicKey.toBase58(), memo: "tenner:test" });
    const envelope = JSON.parse(prepared.raw) as { via: string; b64: string };
    expect(envelope.via).toBe("rpc");
    expect(Buffer.from(envelope.b64, "base64").length).toBeLessThan(1232);
    expect(await venue.chain.simulate(prepared.raw)).toEqual({ ok: true });
  });
});
