import { randomBytes, randomUUID } from "node:crypto";
import { usd } from "@gemdex/core";
import { eq, post, userAccount, users, type Db } from "@gemdex/db";
import type { PaperVenue } from "@gemdex/venues";
import { jwtVerify, SignJWT } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";

function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (!value && process.env.GEMDEX_MODE && process.env.GEMDEX_MODE !== "paper") {
    throw new Error("SESSION_SECRET is required outside paper mode");
  }
  return new TextEncoder().encode(value ?? "paper-mode-only-not-a-secret");
}

export async function issueSession(userId: string): Promise<string> {
  return new SignJWT({ sub: userId }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("7d").sign(secret());
}

export async function readSession(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

export async function userIdFrom(request: FastifyRequest): Promise<string | null> {
  const header = request.headers.authorization;
  return readSession(header?.startsWith("Bearer ") ? header.slice(7) : undefined);
}

export function requireUser(request: FastifyRequest, reply: FastifyReply, userId: string | null): userId is string {
  if (userId) return true;
  void reply.code(401).send({ error: "Connect a wallet first" });
  return false;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Looks like an address, but paper wallets exist only in this database. */
function fakeAddress(): string {
  return Array.from(randomBytes(44), (b) => BASE58[b % BASE58.length]).join("");
}

/** Paper accounts start funded, so trying the terminal takes one click. */
export async function createPaperUser(db: Db, venue: PaperVenue, handle?: string): Promise<string> {
  const id = randomUUID();
  const clean = (handle ?? "").replace(/[^\w-]/g, "").slice(0, 18) || `trainer${id.slice(0, 4)}`;
  // Paper admin is open for local use. Set PAPER_OPEN_ADMIN=false on any public paper deployment.
  const isAdmin = process.env.PAPER_OPEN_ADMIN !== "false";
  await db.insert(users).values({ id, handle: clean, tradingWallet: fakeAddress(), connectedWallet: fakeAddress(), isAdmin });
  await grantPaperFunds(db, venue, id, usd(500));
  return id;
}

export async function grantPaperFunds(db: Db, venue: PaperVenue, userId: string, amount: number): Promise<void> {
  await db.transaction((tx) => post(tx, `faucet:${randomUUID()}`, "deposit", [{ account: "world", delta: -amount }, { account: userAccount(userId), delta: amount }]));
  await venue.faucet(userAccount(userId), amount);
}

export async function loadUser(db: Db, id: string) {
  const rows = await db.select().from(users).where(eq(users.id, id));
  return rows[0] ?? null;
}

interface LinkedWallet {
  type: string;
  chainType?: string;
  walletClientType?: string;
  address?: string;
  id?: string | null;
  delegated?: boolean;
}

/** Trades a verified Privy session for ours. The trading wallet must have delegated signing. */
export async function privySession(db: Db, accessToken: string, idToken: string): Promise<{ userId: string } | { error: string }> {
  const { PrivyClient } = await import("@privy-io/server-auth");
  const privy = new PrivyClient(process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? process.env.PRIVY_APP_ID ?? "", process.env.PRIVY_APP_SECRET ?? "");
  const claims = await privy.verifyAuthToken(accessToken).catch(() => null);
  if (!claims) return { error: "Your sign-in has expired" };
  const person = await privy.getUser({ idToken }).catch(() => null);
  if (!person || person.id !== claims.userId) return { error: "Sign-in did not match" };

  const wallets = (person.linkedAccounts as unknown as LinkedWallet[]).filter((a) => a.type === "wallet" && a.chainType === "solana");
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const external = wallets.find((w) => w.walletClientType !== "privy");
  if (!embedded?.address || !external?.address) return { error: "Connect a Solana wallet first" };
  if (!embedded.delegated) return { error: "Approve one-click trading first" };

  const admins = (process.env.ADMIN_WALLETS ?? "").split(",").map((w) => w.trim()).filter(Boolean);
  const existing = await db.select().from(users).where(eq(users.privyDid, person.id));
  if (existing[0]) {
    await db.update(users).set({ connectedWallet: external.address, privyWalletId: embedded.id ?? null, isAdmin: admins.includes(external.address) }).where(eq(users.id, existing[0].id));
    return { userId: existing[0].id };
  }
  const created = await db
    .insert(users)
    .values({
      privyDid: person.id, privyWalletId: embedded.id ?? null, handle: external.address.slice(0, 6), tradingWallet: embedded.address,
      connectedWallet: external.address, isAdmin: admins.includes(external.address),
    })
    .returning({ id: users.id });
  return { userId: created[0]!.id };
}
