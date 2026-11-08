import { execSync } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setSetting } from "@gemdex/db";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
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

  it("needs two different admins, unexpired, and no kill switch", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    await setSetting(t.db, "ops", { armedBy: [], armedUntil: null, killSwitch: false });
    await expect(assertArmed(t.db, "mainnet")).rejects.toThrow(/not armed/);
    await setSetting(t.db, "ops", { armedBy: ["a"], armedUntil: future });
    await expect(assertArmed(t.db, "mainnet")).rejects.toThrow(/not armed/);
    await setSetting(t.db, "ops", { armedBy: ["a", "a"], armedUntil: future });
    await expect(assertArmed(t.db, "mainnet")).rejects.toThrow(/not armed/);
    await setSetting(t.db, "ops", { armedBy: ["a", "b"], armedUntil: past });
    await expect(assertArmed(t.db, "mainnet")).rejects.toThrow(/not armed/);
    await setSetting(t.db, "ops", { armedBy: ["a", "b"], armedUntil: future, killSwitch: true });
    await expect(assertArmed(t.db, "mainnet")).rejects.toThrow(/kill switch/);
    await setSetting(t.db, "ops", { armedBy: ["a", "b"], armedUntil: future, killSwitch: false });
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
  const connection = {
    rpcEndpoint: "http://127.0.0.1:1",
    getAccountInfo: async () => null,
    // Both vaults exist, so the claim includes both instructions.
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => ({})),
    getTokenAccountBalance: async (key: PublicKey) => {
      asked.push(key.toBase58());
      const amount = balances.get(key.toBase58());
      if (amount === undefined) throw new Error("could not find account");
      return { value: { uiAmount: amount } };
    },
  } as unknown as Connection;
  const venueWith = (tokenMint?: PublicKey) =>
    buildSolanaVenue({ mode: "devnet", connection, signer: new LocalSigner("fees"), db: t.db, endpoints: CC_DEVNET, tokenMint }, { drops: "", vault: "", cashback: "", fee: "", feePayer: "" });
  const vaultsTheClaimEmpties = async () => {
    const chain = venueWith(mint).chain as unknown as { collectIx(): Promise<TransactionInstruction[]> };
    const [, curve, pool] = await chain.collectIx();
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

  it("counts nothing before $TENR exists, because the worker cannot claim without its mint", async () => {
    asked.length = 0;
    expect(await venueWith().fees.cardsUnclaimed()).toBe(0);
    expect(asked).toEqual([]);
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
