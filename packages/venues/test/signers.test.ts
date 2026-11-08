import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "@gemdex/db";
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { createSigner, parsePrivateKey, PrivySigner, treasuryFromEnv, type AnyTx, type TreasuryWallet } from "../src/signers";
import { role, trader, type Role } from "../src/index";
import { createTestDb, type TestDb } from "../../../tools/testdb";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb(2);
});
afterAll(async () => {
  await t.shutdown();
});

const ROLES: Role[] = ["drops", "vault", "cashback", "fee", "feePayer"];
const SUFFIX: Record<Role, string> = { drops: "DROPS", vault: "VAULT", cashback: "CASHBACK", fee: "FEE", feePayer: "FEE_PAYER" };
const keys = Object.fromEntries(ROLES.map((r) => [r, Keypair.generate()])) as Record<Role, Keypair>;
const allKeys = Object.fromEntries(ROLES.map((r) => [`TREASURY_KEY_${SUFFIX[r]}`, bs58.encode(keys[r].secretKey)]));
const privyEnv = { PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "secret" };

/** Records which wallets Privy was asked to sign for, and signs as them with keys it was handed. */
class FakePrivy {
  asked: string[] = [];
  constructor(private readonly wallets: Record<string, Keypair>) {}
  walletApi = {
    solana: {
      signTransaction: async ({ walletId, transaction }: { walletId: string; transaction: AnyTx }) => {
        this.asked.push(walletId);
        const copy = Transaction.from((transaction as Transaction).serialize({ requireAllSignatures: false, verifySignatures: false }));
        copy.partialSign(this.wallets[walletId]!);
        return { signedTransaction: copy as AnyTx };
      },
    },
  };
}

/** A transfer that needs `signer`'s signature. Never sent anywhere. */
function transferFrom(signer: PublicKey, feePayer = signer): Transaction {
  const tx = new Transaction({ feePayer, recentBlockhash: bs58.encode(Buffer.alloc(32, 1)) });
  tx.add(SystemProgram.transfer({ fromPubkey: signer, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  return tx;
}

const signedBy = (tx: Transaction, key: PublicKey) => {
  const entry = tx.signatures.find((s) => s.publicKey.equals(key));
  return !!entry?.signature && entry.signature.some((b) => b !== 0);
};

describe("private keys", () => {
  it("reads a wallet's base58 export and a keypair file's array as the same key", () => {
    const key = Keypair.generate();
    expect(parsePrivateKey("K", bs58.encode(key.secretKey)).publicKey.equals(key.publicKey)).toBe(true);
    expect(parsePrivateKey("K", `  ${JSON.stringify(Array.from(key.secretKey))}\n`).publicKey.equals(key.publicKey)).toBe(true);
  });

  it("refuses a damaged key without repeating it", () => {
    const good = bs58.encode(Keypair.generate().secretKey);
    for (const bad of [good.slice(0, -3), `${good.slice(0, -1)}${good.endsWith("z") ? "y" : "z"}`, "not a key", "[1,2,3]", "[300,1]", bs58.encode(Keypair.generate().publicKey.toBytes())]) {
      let message = "";
      try {
        parsePrivateKey("TREASURY_KEY_DROPS", bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/TREASURY_KEY_DROPS is not a Solana private key/);
      expect(message).not.toContain(bad);
    }
  });
});

describe("treasury wallets from the environment", () => {
  it("takes every wallet from its private key", () => {
    const wallets = treasuryFromEnv(allKeys);
    for (const r of ROLES) {
      const wallet = wallets[r] as Extract<TreasuryWallet, { kind: "key" }>;
      expect(wallet.kind).toBe("key");
      expect(wallet.keypair.publicKey.equals(keys[r].publicKey)).toBe(true);
    }
  });

  it("mixes private keys and Privy wallets, and blank counts as unset", () => {
    const vault = Keypair.generate().publicKey.toBase58();
    const wallets = treasuryFromEnv({ ...allKeys, TREASURY_KEY_VAULT: " ", PRIVY_WALLET_VAULT: `wallet-v:${vault}`, PRIVY_WALLET_FEE: "" });
    expect(wallets.vault).toMatchObject({ kind: "privy", walletId: "wallet-v" });
    expect((wallets.vault as Extract<TreasuryWallet, { kind: "privy" }>).address.toBase58()).toBe(vault);
    expect(wallets.fee.kind).toBe("key");
  });

  it("refuses a role set both ways, or not at all", () => {
    expect(() => treasuryFromEnv({ ...allKeys, PRIVY_WALLET_DROPS: `w:${keys.drops.publicKey.toBase58()}` })).toThrow(/Set TREASURY_KEY_DROPS or PRIVY_WALLET_DROPS, not both/);
    expect(() => treasuryFromEnv({ ...allKeys, TREASURY_KEY_FEE_PAYER: "" })).toThrow(/TREASURY_KEY_FEE_PAYER \(a private key\) or PRIVY_WALLET_FEE_PAYER/);
    expect(() => treasuryFromEnv({ ...allKeys, TREASURY_KEY_VAULT: undefined, PRIVY_WALLET_VAULT: "no-address" })).toThrow(/walletId:address/);
    expect(() => treasuryFromEnv({ ...allKeys, TREASURY_KEY_VAULT: undefined, PRIVY_WALLET_VAULT: "w:nope" })).toThrow(/not a Solana address/);
  });

  it("refuses two roles on one wallet, whichever way each is set", () => {
    expect(() => treasuryFromEnv({ ...allKeys, TREASURY_KEY_VAULT: allKeys.TREASURY_KEY_DROPS })).toThrow(/drops and vault wallets are the same address/);
    expect(() => treasuryFromEnv({ ...allKeys, TREASURY_KEY_FEE: undefined, PRIVY_WALLET_FEE: `w:${keys.cashback.publicKey.toBase58()}` })).toThrow(/cashback and fee wallets are the same address/);
  });
});

describe("createSigner", () => {
  it("lets mainnet use private keys for the treasury, with Privy for users", async () => {
    const signer = await createSigner("mainnet", t.db, { ...privyEnv, ...allKeys });
    expect(signer).toBeInstanceOf(PrivySigner);
    for (const r of ROLES) {
      expect(signer.custodyOf!(r)).toBe("key");
      expect((await signer.addressOf(role(r))).equals(keys[r].publicKey)).toBe(true);
    }
  });

  it("still refuses mainnet without Privy, because users' wallets would be keys on this server", async () => {
    await expect(createSigner("mainnet", t.db, allKeys)).rejects.toThrow(/mainnet needs Privy/);
  });

  it("devnet without Privy uses the given keys, and the seed for the rest", async () => {
    const signer = await createSigner("devnet", t.db, { TREASURY_KEY_FEE: allKeys.TREASURY_KEY_FEE, GEMDEX_DEV_SEED: "s" });
    expect(signer.custodyOf!("fee")).toBe("key");
    expect(signer.custodyOf!("drops")).toBe("seed");
    expect((await signer.addressOf(role("fee"))).equals(keys.fee.publicKey)).toBe(true);
  });

  it("names a broken key at startup", async () => {
    await expect(createSigner("mainnet", t.db, { ...privyEnv, ...allKeys, TREASURY_KEY_CASHBACK: "oops" })).rejects.toThrow(/TREASURY_KEY_CASHBACK is not a Solana private key/);
  });
});

describe("signing", () => {
  const vaultHeld = Keypair.generate();
  const userKey = Keypair.generate();
  const fake = new FakePrivy({ "wallet-v": vaultHeld, "wallet-u": userKey });
  const roles = { ...treasuryFromEnv({ ...allKeys, TREASURY_KEY_VAULT: undefined, PRIVY_WALLET_VAULT: `wallet-v:${vaultHeld.publicKey.toBase58()}` }) };
  const signer = new PrivySigner(fake as never, undefined as never, roles);

  it("signs for a private-key wallet here, without asking Privy", async () => {
    const tx = await signer.sign(transferFrom(keys.drops.publicKey), role("drops"));
    expect(signedBy(tx, keys.drops.publicKey)).toBe(true);
    expect(tx.verifySignatures()).toBe(true);
    expect(fake.asked).toEqual([]);
  });

  it("asks Privy for a Privy wallet, and keeps signatures already on the transaction", async () => {
    const tx = transferFrom(vaultHeld.publicKey, keys.feePayer.publicKey);
    await signer.sign(tx, role("feePayer"));
    await signer.sign(tx, role("vault"));
    expect(fake.asked).toEqual(["wallet-v"]);
    expect(signedBy(tx, keys.feePayer.publicKey) && signedBy(tx, vaultHeld.publicKey)).toBe(true);
    expect(tx.verifySignatures()).toBe(true);
  });

  it("always signs for users through Privy", async () => {
    const id = randomUUID();
    await t.db.insert(users).values({ id, handle: "u", tradingWallet: userKey.publicKey.toBase58(), connectedWallet: Keypair.generate().publicKey.toBase58(), privyWalletId: "wallet-u" });
    const withDb = new PrivySigner(fake as never, t.db, roles);
    fake.asked = [];
    const party = trader(id, userKey.publicKey.toBase58());
    const tx = await withDb.sign(transferFrom(userKey.publicKey, keys.feePayer.publicKey), party);
    await withDb.sign(tx, role("feePayer"));
    expect(fake.asked).toEqual(["wallet-u"]);
    expect(tx.verifySignatures()).toBe(true);
  });

  it("signs a versioned transaction with a private key", async () => {
    const legacy = transferFrom(keys.drops.publicKey);
    const tx = new VersionedTransaction(legacy.compileMessage());
    await signer.sign(tx, role("drops"));
    expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true);
  });

  it("will not sign for an outside address", async () => {
    await expect(signer.sign(transferFrom(keys.drops.publicKey), { kind: "address", address: keys.drops.publicKey.toBase58() })).rejects.toThrow(/outside address/);
  });
});
