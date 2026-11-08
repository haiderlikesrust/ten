// Collector Crypt packs and sell-backs that go wrong, against a real throwaway database.
// Paper money, with Solana's rules swapped in where paper is kinder than the real chain.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DEFAULT_DROP_SETTINGS, usd, type DropState } from "@gemdex/core";
import { balanceOf, ccPacks, chainTx, drops, eq, holds, machines, orders, placeOrder, poolCards, post, sql, userAccount, users } from "@gemdex/db";
import { CcRead, TxRefused, createPaperVenue, type ChainOp, type PaperVenue } from "@gemdex/venues";
import { claimDrop } from "../../gateway/src/claim";
import { createDrop, tickDrops, tickOrders, toEcon, type Ctx } from "../src/lib";
import { createTestDb, type TestDb } from "../../../tools/testdb";

let t: TestDb;

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const makeCtx = (venue: PaperVenue): Ctx => ({ db: t.db, sql: t.sql, venue, cc: new CcRead(), rng: rng(7), log: () => {}, announce: async () => {} });

async function fund(venue: PaperVenue, account: string, amount: number) {
  await t.db.transaction((tx) => post(tx, `seed:${account}:${randomUUID()}`, "seed", [{ account: "world", delta: -amount }, { account, delta: amount }]));
  await venue.faucet(account, amount);
}

async function makeUser(venue: PaperVenue, amount: number) {
  const id = randomUUID();
  await t.db.insert(users).values({ id, handle: id.slice(0, 6), tradingWallet: `trade${id}`, connectedWallet: `phantom${id}` });
  await fund(venue, userAccount(id), amount);
  return id;
}

const dropRow = async (id: string) => (await t.db.select().from(drops).where(eq(drops.id, id)))[0]!;

async function drive(ctx: Ctx, dropId: string, until: DropState[], ticks = 80) {
  for (let i = 0; i < ticks; i++) {
    await t.db.update(drops).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(drops.id, dropId));
    await tickDrops(ctx);
    const row = await dropRow(dropId);
    if (until.includes(row.state as DropState)) return row;
  }
  const row = await dropRow(dropId);
  throw new Error(`drop stuck in ${row.state}: ${row.lastError}`);
}

async function runOrders(ctx: Ctx, userId: string, ticks = 8) {
  for (let i = 0; i < ticks; i++) {
    await t.db.update(orders).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(orders.userId, userId));
    await tickOrders(ctx);
  }
  return (await t.db.select().from(orders).where(eq(orders.userId, userId)))[0]!;
}

const machine = async () => toEcon((await t.db.select().from(machines).where(eq(machines.code, "pokemon_25")))[0]!);
const openPack = (userId: string) =>
  t.db.transaction((tx) => placeOrder(tx, { userId, kind: "gacha_open", params: { machine: "pokemon_25" }, holdAmount: usd(25), idempotencyKey: randomUUID() }));
const sevenHoursAgo = () => new Date(Date.now() - 7 * 3600_000);

/**
 * Solana's rule for CC's pack bytes, which paper does not have: every pack payment dies unlanded,
 * and once dead the bytes are refused rather than signed again.
 */
function deadPacks(venue: PaperVenue) {
  const signed: string[] = [];
  const opOf = (raw: string) => (JSON.parse(raw) as { op: ChainOp }).op;
  const chain = Object.create(venue.chain) as PaperVenue["chain"];
  chain.prepare = async (op) => {
    if (op.type === "ccPack") {
      if (signed.includes(op.raw)) throw new TxRefused("the transaction expired before it was signed");
      signed.push(op.raw);
    }
    return venue.chain.prepare(op);
  };
  chain.send = async (raw) => (opOf(raw).type === "ccPack" ? undefined : venue.chain.send(raw));
  chain.status = async (signature, raw) => (opOf(raw).type === "ccPack" ? "dead" : venue.chain.status(signature, raw));
  return { venue: { ...venue, chain } as PaperVenue, signed };
}

beforeAll(async () => {
  t = await createTestDb(10);
  const tiers = { common: { start: 13, end: 30 }, uncommon: { start: 30, end: 55 }, rare: { start: 55, end: 125 }, epic: { start: 125, end: 500 } };
  await t.db.insert(machines).values({
    code: "pokemon_25", name: "Starter", price: usd(25), buybackPct: 85, ev: usd(27.49), odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 },
    tiers, stock: { common: 500, uncommon: 100, rare: 50, epic: 10 },
  });
  const pool = Array.from({ length: 80 }, (_, i) => {
    const rarity = (["common", "uncommon", "rare", "epic"] as const)[i % 4]!;
    return { nft: `card${i}`, machineCode: "pokemon_25", rarity, name: `Test card ${i}`, insuredValue: usd({ common: 20, uncommon: 40, rare: 90, epic: 300 }[rarity]) };
  });
  await t.db.insert(poolCards).values(pool);
});

afterAll(async () => {
  await t.shutdown();
});

beforeEach(async () => {
  await t.db.update(poolCards).set({ usedAt: null });
  // Each test's drops run alone.
  await t.db.update(drops).set({ state: "VOID" }).where(sql`${drops.state} not in ('SETTLED','DELIVERED','BOUGHT_BACK','SKIPPED','ABANDONED','REFUNDED','VOID')`);
  await t.sql`update claims set state = 'voided' where state = 'won'`;
});

describe("a CC pack payment that dies unlanded", () => {
  it("skips a revealed drop, and CC's bytes are signed exactly once", async () => {
    const base = createPaperVenue(t.db);
    await fund(base, "drops", usd(100));
    const before = await balanceOf(t.db, "drops");
    const { venue, signed } = deadPacks(base);
    const ctx = makeCtx(venue);
    const done = await drive(ctx, (await createDrop(ctx, await machine(), { ...DEFAULT_DROP_SETTINGS, hiddenShare: 0 })).id, ["SKIPPED"]);
    expect(done.lastError).toMatch(/pack payment failed/);
    expect(signed).toHaveLength(1);
    expect(await t.db.select().from(chainTx).where(eq(chainTx.ref, done.memo!))).toHaveLength(1);
    expect(await balanceOf(t.db, "drops")).toBe(before);
  });

  it("fails a user's order without charging them", async () => {
    const base = createPaperVenue(t.db);
    const { venue, signed } = deadPacks(base);
    const userId = await makeUser(base, usd(100));
    await openPack(userId);
    const order = await runOrders(makeCtx(venue), userId);
    expect(order.state).toBe("failed");
    expect(order.error).toMatch(/Pack payment failed/);
    expect(signed).toHaveLength(1);
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(100));
    expect((await t.db.select().from(holds).where(eq(holds.userId, userId))).every((h) => h.status === "released")).toBe(true);
  });

  it("burns a hidden drop's pack for a fresh one each time, then refunds the winner", async () => {
    const base = createPaperVenue(t.db);
    await fund(base, "drops", usd(1000));
    const userId = await makeUser(base, usd(100));
    const drop = await createDrop(makeCtx(base), await machine(), { ...DEFAULT_DROP_SETTINGS, hiddenShare: 1 });
    await claimDrop(t.db, { userId, dropId: drop.id, idempotencyKey: randomUUID() });

    const { venue, signed } = deadPacks(base);
    const refundDue = await drive(makeCtx(venue), drop.id, ["REFUND_DUE"]);
    expect(refundDue.packPayAttempts).toBe(3);
    expect(new Set(signed).size).toBe(3);
    expect(signed).toHaveLength(3);
    for (const pack of await t.db.select().from(ccPacks).where(eq(ccPacks.dropId, drop.id))) {
      expect(await t.db.select().from(chainTx).where(eq(chainTx.ref, pack.memo))).toHaveLength(1);
    }
    await drive(makeCtx(base), drop.id, ["REFUNDED"]);
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(100));
  });
});

describe("a paid pack CC never settles", () => {
  it("ends a user's order for review after the deadline, without refunding what CC still holds", async () => {
    const venue = createPaperVenue(t.db, { faults: { open_waiting: 1 } });
    const ctx = makeCtx(venue);
    const userId = await makeUser(venue, usd(100));
    await openPack(userId);
    const waiting = await runOrders(ctx, userId, 5);
    expect(waiting.state).toBe("running");
    expect(waiting.step).toBe("open");

    await t.db.update(ccPacks).set({ createdAt: sevenHoursAgo() }).where(eq(ccPacks.memo, waiting.memo!));
    const order = await runOrders(ctx, userId, 1);
    expect(order.state).toBe("failed");
    expect(order.error).toMatch(/manual review/);
    expect(order.result).toMatchObject({ memo: waiting.memo });
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(75));
  });

  it("flags a revealed drop for review and checks it only now and then", async () => {
    const venue = createPaperVenue(t.db, { faults: { open_waiting: 1 } });
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(100));
    const opening = await drive(ctx, (await createDrop(ctx, await machine(), { ...DEFAULT_DROP_SETTINGS, hiddenShare: 0 })).id, ["OPENING"]);
    await t.db.update(ccPacks).set({ createdAt: sevenHoursAgo() }).where(eq(ccPacks.memo, opening.memo!));
    await t.db.update(drops).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(drops.id, opening.id));
    await tickDrops(ctx);
    const flagged = await dropRow(opening.id);
    expect(flagged.state).toBe("OPENING");
    expect(flagged.lastError).toMatch(/needs review/);
    expect(flagged.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
  });
});

describe("cards in the Vault", () => {
  it("a card with no insured value is sold back, never listed from the pack price", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(100));
    const inVault = await drive(ctx, (await createDrop(ctx, await machine(), { ...DEFAULT_DROP_SETTINGS, hiddenShare: 0 })).id, ["IN_VAULT"]);
    await t.db.update(drops).set({ insuredValue: null }).where(eq(drops.id, inVault.id));
    const done = await drive(ctx, inVault.id, ["LIVE", "BOUGHT_BACK"]);
    expect(done.state).toBe("BOUGHT_BACK");
    expect(done.price).toBeNull();
  });

  it("stops selling a card back after three failed offers, for a person to look at", async () => {
    const healthy = createPaperVenue(t.db);
    await fund(healthy, "drops", usd(100));
    const live = await drive(makeCtx(healthy), (await createDrop(makeCtx(healthy), await machine(), { ...DEFAULT_DROP_SETTINGS, hiddenShare: 0 })).id, ["LIVE"]);
    await t.db.update(drops).set({ state: "EXPIRED" }).where(eq(drops.id, live.id));

    const failing = makeCtx(createPaperVenue(t.db, { faults: { send_failed: 1 } }));
    for (let i = 0; i < 8; i++) {
      await t.db.update(drops).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(drops.id, live.id));
      await tickDrops(failing);
    }
    const parked = await dropRow(live.id);
    expect(parked.state).toBe("EXPIRED");
    expect(parked.lastError).toMatch(/needs review: sell-back stopped/);
    expect(await t.db.select().from(chainTx).where(eq(chainTx.ref, live.id))).toHaveLength(3);
  });
});
