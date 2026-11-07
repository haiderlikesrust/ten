import { createHash } from "node:crypto";
import { eq, users, type Db } from "@gemdex/db";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Mode, Party, Role } from "./types";

export type AnyTx = Transaction | VersionedTransaction;

export interface Signer {
  addressOf(party: Party): Promise<PublicKey>;
  /** Adds this party's signature. Other signatures on the transaction are kept. */
  sign<T extends AnyTx>(tx: T, party: Party): Promise<T>;
}

const ROLES: Role[] = ["drops", "vault", "cashback", "fee", "feePayer"];

/**
 * Raw keys from the environment. Devnet only, by construction: there is no path to this
 * class in mainnet mode, because a key in an env file is exactly what custody must avoid.
 */
export class LocalSigner implements Signer {
  private readonly roles = new Map<Role, Keypair>();

  constructor(private readonly seed: string, rawRoles: Partial<Record<Role, string>> = {}) {
    for (const role of ROLES) {
      const secret = rawRoles[role];
      this.roles.set(role, secret ? Keypair.fromSecretKey(bs58.decode(secret)) : this.derive(`role:${role}`));
    }
  }

  private derive(label: string): Keypair {
    return Keypair.fromSeed(createHash("sha256").update(`${this.seed}:${label}`).digest());
  }

  private keypair(party: Party): Keypair {
    if (party.kind === "role") return this.roles.get(party.role)!;
    if (party.kind === "user") return this.derive(`user:${party.userId}`);
    throw new Error("cannot sign for an outside address");
  }

  async addressOf(party: Party): Promise<PublicKey> {
    if (party.kind === "address") return new PublicKey(party.address);
    return this.keypair(party).publicKey;
  }

  async sign<T extends AnyTx>(tx: T, party: Party): Promise<T> {
    const keypair = this.keypair(party);
    if (tx instanceof VersionedTransaction) tx.sign([keypair]);
    else tx.partialSign(keypair);
    return tx;
  }
}

interface PrivyWalletApi {
  walletApi: {
    solana: {
      signTransaction(input: { walletId: string; transaction: AnyTx }): Promise<{ signedTransaction: AnyTx }>;
    };
  };
}

/** Keys stay in Privy's enclaves. This class only ever asks for a signature. */
export class PrivySigner implements Signer {
  constructor(
    private readonly client: PrivyWalletApi,
    private readonly db: Db,
    private readonly roles: Record<Role, { walletId: string; address: string }>,
  ) {}

  private async user(party: Extract<Party, { kind: "user" }>) {
    const rows = await this.db.select({ walletId: users.privyWalletId, wallet: users.tradingWallet }).from(users).where(eq(users.id, party.userId));
    const row = rows[0];
    if (!row?.walletId) throw new Error(`user ${party.userId} has no delegated wallet`);
    return row as { walletId: string; wallet: string };
  }

  async addressOf(party: Party): Promise<PublicKey> {
    if (party.kind === "address") return new PublicKey(party.address);
    if (party.kind === "role") return new PublicKey(this.roles[party.role].address);
    return new PublicKey((await this.user(party)).wallet);
  }

  async sign<T extends AnyTx>(tx: T, party: Party): Promise<T> {
    if (party.kind === "address") throw new Error("cannot sign for an outside address");
    const walletId = party.kind === "role" ? this.roles[party.role].walletId : (await this.user(party)).walletId;
    const { signedTransaction } = await this.client.walletApi.solana.signTransaction({ walletId, transaction: tx });
    // Copies only this signer's signature across, so a response can never drop another party's.
    const signer = await this.addressOf(party);
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

function roleWalletsFromEnv(env: NodeJS.ProcessEnv): Record<Role, { walletId: string; address: string }> {
  const read = (name: string) => {
    const [walletId, address] = (env[name] ?? "").split(":");
    if (!walletId || !address) throw new Error(`${name} must be set to walletId:address`);
    return { walletId, address };
  };
  return {
    drops: read("PRIVY_WALLET_DROPS"),
    vault: read("PRIVY_WALLET_VAULT"),
    cashback: read("PRIVY_WALLET_CASHBACK"),
    fee: read("PRIVY_WALLET_FEE"),
    feePayer: read("PRIVY_WALLET_FEE_PAYER"),
  };
}

export async function createSigner(mode: Mode, db: Db, env: NodeJS.ProcessEnv = process.env): Promise<Signer> {
  if (mode === "paper") throw new Error("paper mode has no signer");
  if (env.PRIVY_APP_ID && env.PRIVY_APP_SECRET) {
    const { PrivyClient } = await import("@privy-io/server-auth");
    const client = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET, env.PRIVY_AUTH_KEY ? { walletApi: { authorizationPrivateKey: env.PRIVY_AUTH_KEY } } : undefined);
    return new PrivySigner(client as unknown as PrivyWalletApi, db, roleWalletsFromEnv(env));
  }
  if (mode === "mainnet") throw new Error("mainnet requires Privy wallets. Local keys are refused.");
  const raw: Partial<Record<Role, string>> = env.GEMDEX_ROLE_KEYS ? JSON.parse(env.GEMDEX_ROLE_KEYS) : {};
  return new LocalSigner(env.GEMDEX_DEV_SEED || "gemdex-devnet", raw);
}
