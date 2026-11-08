import { createHash } from "node:crypto";
import { eq, users, type Db } from "@gemdex/db";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Mode, Party, Role } from "./types";

export type AnyTx = Transaction | VersionedTransaction;

/** How a treasury wallet signs: through Privy, with a private key from the environment, or (devnet only) with a key made from GEMDEX_DEV_SEED. */
export type Custody = "privy" | "key" | "seed";

export interface Signer {
  addressOf(party: Party): Promise<PublicKey>;
  /** Adds this party's signature. Other signatures on the transaction are kept. */
  sign<T extends AnyTx>(tx: T, party: Party): Promise<T>;
  /** How a treasury wallet signs. Logged at startup, so you can check the setup without the keys. */
  custodyOf?(role: Role): Custody;
}

const ROLES: Role[] = ["drops", "vault", "cashback", "fee", "feePayer"];

/** Each treasury wallet's env var suffix: TREASURY_KEY_FEE_PAYER or PRIVY_WALLET_FEE_PAYER. */
const ENV_NAME: Record<Role, string> = { drops: "DROPS", vault: "VAULT", cashback: "CASHBACK", fee: "FEE", feePayer: "FEE_PAYER" };

function signLocally<T extends AnyTx>(tx: T, keypair: Keypair): T {
  if (tx instanceof VersionedTransaction) tx.sign([keypair]);
  else tx.partialSign(keypair);
  return tx;
}

/**
 * Devnet without Privy: every key is local. Treasury wallets use their TREASURY_KEY_* where one is given, and a
 * key made from the seed otherwise. Users' trading wallets are made from the seed too, so this can never serve
 * real users, and mainnet refuses it.
 */
export class LocalSigner implements Signer {
  private readonly roles = new Map<Role, Keypair>();

  constructor(private readonly seed: string, private readonly keys: Partial<Record<Role, Keypair>> = {}) {
    for (const role of ROLES) this.roles.set(role, keys[role] ?? this.derive(`role:${role}`));
    assertDistinct((role) => this.roles.get(role)!.publicKey);
  }

  private derive(label: string): Keypair {
    return Keypair.fromSeed(createHash("sha256").update(`${this.seed}:${label}`).digest());
  }

  private keypair(party: Party): Keypair {
    if (party.kind === "role") return this.roles.get(party.role)!;
    if (party.kind === "user") return this.derive(`user:${party.userId}`);
    throw new Error("cannot sign for an outside address");
  }

  custodyOf(role: Role): Custody {
    return this.keys[role] ? "key" : "seed";
  }

  async addressOf(party: Party): Promise<PublicKey> {
    if (party.kind === "address") return new PublicKey(party.address);
    return this.keypair(party).publicKey;
  }

  async sign<T extends AnyTx>(tx: T, party: Party): Promise<T> {
    return signLocally(tx, this.keypair(party));
  }
}

interface PrivyWalletApi {
  walletApi: {
    solana: {
      signTransaction(input: { walletId: string; transaction: AnyTx }): Promise<{ signedTransaction: AnyTx }>;
    };
  };
}

/** A treasury wallet Privy holds, or one whose private key is in the worker's environment. */
export type TreasuryWallet = { kind: "privy"; walletId: string; address: PublicKey } | { kind: "key"; keypair: Keypair };

const addressOfWallet = (wallet: TreasuryWallet): PublicKey => (wallet.kind === "key" ? wallet.keypair.publicKey : wallet.address);

/**
 * Users' trading wallets always sign through Privy, which keeps their keys. Each treasury wallet signs either
 * through Privy as well, or with its own private key (docs/LAUNCH.md, section 4). Privy-held keys never reach this
 * class: it only asks Privy for a signature.
 */
export class PrivySigner implements Signer {
  constructor(
    private readonly client: PrivyWalletApi,
    private readonly db: Db,
    private readonly roles: Record<Role, TreasuryWallet>,
  ) {}

  private async user(party: Extract<Party, { kind: "user" }>) {
    const rows = await this.db.select({ walletId: users.privyWalletId, wallet: users.tradingWallet }).from(users).where(eq(users.id, party.userId));
    const row = rows[0];
    if (!row?.walletId) throw new Error(`user ${party.userId} has no delegated wallet`);
    return row as { walletId: string; wallet: string };
  }

  custodyOf(role: Role): Custody {
    return this.roles[role].kind;
  }

  async addressOf(party: Party): Promise<PublicKey> {
    if (party.kind === "address") return new PublicKey(party.address);
    if (party.kind === "role") return addressOfWallet(this.roles[party.role]);
    return new PublicKey((await this.user(party)).wallet);
  }

  async sign<T extends AnyTx>(tx: T, party: Party): Promise<T> {
    if (party.kind === "address") throw new Error("cannot sign for an outside address");
    if (party.kind === "role") {
      const wallet = this.roles[party.role];
      if (wallet.kind === "key") return signLocally(tx, wallet.keypair);
      return this.signWithPrivy(tx, wallet.walletId, wallet.address);
    }
    const user = await this.user(party);
    return this.signWithPrivy(tx, user.walletId, new PublicKey(user.wallet));
  }

  private async signWithPrivy<T extends AnyTx>(tx: T, walletId: string, signer: PublicKey): Promise<T> {
    const { signedTransaction } = await this.client.walletApi.solana.signTransaction({ walletId, transaction: tx });
    // Copies only this signer's signature across, so a response can never drop another party's.
    if (tx instanceof VersionedTransaction) {
      const signed = signedTransaction as VersionedTransaction;
      const index = tx.message.staticAccountKeys.findIndex((key) => key.equals(signer));
      const signature = signed.signatures[index];
      if (index < 0 || !signature) throw new Error("privy did not return a signature");
      tx.signatures[index] = signature;
    } else {
      const signature = (signedTransaction as Transaction).signatures.find((s) => s.publicKey.equals(signer))?.signature;
      if (!signature) throw new Error("privy did not return a signature");
      tx.addSignature(signer, signature);
    }
    return tx;
  }
}

/**
 * Reads a private key the way wallets export one: base58 (Phantom, Solflare, Backpack) or a keypair file's byte
 * array (solana-keygen). The error names the variable but never repeats its value.
 */
export function parsePrivateKey(name: string, value: string): Keypair {
  const refuse = () => new Error(`${name} is not a Solana private key. Paste the base58 key your wallet exports, or a keypair file's [1,2,...] array.`);
  let bytes: Uint8Array;
  try {
    const text = value.trim();
    if (text.startsWith("[")) {
      const list: unknown = JSON.parse(text);
      if (!Array.isArray(list) || !list.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw refuse();
      bytes = Uint8Array.from(list as number[]);
    } else {
      bytes = bs58.decode(text);
    }
    // Checks that the public half matches the secret half, so a key that lost characters is caught here.
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw refuse();
  }
}

function privyWallet(name: string, value: string): TreasuryWallet {
  const [walletId, address] = value.split(":");
  if (!walletId || !address) throw new Error(`${name} must be set to walletId:address`);
  try {
    return { kind: "privy", walletId, address: new PublicKey(address) };
  } catch {
    throw new Error(`${name} has an address that is not a Solana address`);
  }
}

/** Two roles on one wallet would mix their money, and Reconciliation compares each wallet with its own books. */
function assertDistinct(addressOf: (role: Role) => PublicKey) {
  const seen = new Map<string, Role>();
  for (const role of ROLES) {
    const address = addressOf(role).toBase58();
    const other = seen.get(address);
    if (other) throw new Error(`The ${other} and ${role} wallets are the same address. Each role needs its own wallet.`);
    seen.set(address, role);
  }
}

/** Each treasury wallet from TREASURY_KEY_<ROLE> (a private key) or PRIVY_WALLET_<ROLE> (walletId:address). Exactly one per role. */
export function treasuryFromEnv(env: NodeJS.ProcessEnv): Record<Role, TreasuryWallet> {
  const wallets = {} as Record<Role, TreasuryWallet>;
  for (const role of ROLES) {
    const keyVar = `TREASURY_KEY_${ENV_NAME[role]}`;
    const privyVar = `PRIVY_WALLET_${ENV_NAME[role]}`;
    const key = env[keyVar]?.trim();
    const privy = env[privyVar]?.trim();
    if (key && privy) throw new Error(`Set ${keyVar} or ${privyVar}, not both`);
    if (key) wallets[role] = { kind: "key", keypair: parsePrivateKey(keyVar, key) };
    else if (privy) wallets[role] = privyWallet(privyVar, privy);
    else throw new Error(`Set ${keyVar} (a private key) or ${privyVar} (walletId:address)`);
  }
  assertDistinct((role) => addressOfWallet(wallets[role]));
  return wallets;
}

/** Devnet without Privy: whichever TREASURY_KEY_* are set. The rest come from the seed. */
function localKeysFromEnv(env: NodeJS.ProcessEnv): Partial<Record<Role, Keypair>> {
  const keys: Partial<Record<Role, Keypair>> = {};
  for (const role of ROLES) {
    const name = `TREASURY_KEY_${ENV_NAME[role]}`;
    const value = env[name]?.trim();
    if (value) keys[role] = parsePrivateKey(name, value);
  }
  return keys;
}

export async function createSigner(mode: Mode, db: Db, env: NodeJS.ProcessEnv = process.env): Promise<Signer> {
  if (mode === "paper") throw new Error("paper mode has no signer");
  if (env.PRIVY_APP_ID && env.PRIVY_APP_SECRET) {
    const roles = treasuryFromEnv(env);
    const { PrivyClient } = await import("@privy-io/server-auth");
    const client = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET, env.PRIVY_AUTH_KEY ? { walletApi: { authorizationPrivateKey: env.PRIVY_AUTH_KEY } } : undefined);
    return new PrivySigner(client as unknown as PrivyWalletApi, db, roles);
  }
  // Without Privy, users' trading wallets would be keys made from a seed on this server.
  if (mode === "mainnet") throw new Error("mainnet needs Privy (PRIVY_APP_ID and PRIVY_APP_SECRET) for users' trading wallets. Treasury wallets can use TREASURY_KEY_* instead of Privy.");
  return new LocalSigner(env.GEMDEX_DEV_SEED || "gemdex-devnet", localKeysFromEnv(env));
}
