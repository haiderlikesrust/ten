import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DEFAULT_DROP_SETTINGS as S, pulseView, usd } from "@gemdex/core";
import { balanceOf, claimDrop, claims, dropLimits, drops, eq, holdings, machines, post, setSetting, userAccount, users } from "@gemdex/db";
import { CcRead, createPaperVenue, type PaperVenue } from "@gemdex/venues";
import { createDrop, tickDrops, tickPulse, toEcon, type Ctx } from "../src/lib";
import { createTestDb, type TestDb } from "../../../tools/testdb";

let t: TestDb;
let venue: PaperVenue;
let ctx: Ctx;

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

async function fund(account: string, amount: number) {
  await t.db.transaction((tx) => post(tx, `seed:${account}:${randomUUID()}`, "seed", [{ account: "world", delta: -amount }, { account, delta: amount }]));
  await venue.faucet(account, amount);
}

async function makeUser(amount: number) {
  const id = randomUUID();
  await t.db.insert(users).values({ id, handle: id.slice(0, 6), tradingWallet: `t${id}`, connectedWallet: `phantom${id}` });
  await fund(userAccount(id), amount);
  return id;
}

async function liveCard() {
  const machine = toEcon((await t.db.select().from(machines).where(eq(machines.code, "pokemon_25")))[0]!);
  const created = await createDrop(ctx, machine, { ...S, hiddenShare: 0 });
  for (let i = 0; i < 8; i++) {
    await t.db.update(drops).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(drops.id, created.id));
    await tickDrops(ctx);
    const row = (await t.db.select().from(drops).where(eq(drops.id, created.id)))[0]!;
    if (row.state === "LIVE") return row;
  }
  throw new Error("card never went live");
}

const row = async (id: string) => (await t.db.select().from(drops).where(eq(drops.id, id)))[0]!;
const buy = (userId: string, dropId: string, maxPrice?: number) => claimDrop(t.db, { userId, dropId, idempotencyKey: randomUUID(), maxPrice });
const settle = async (id: string) => {
  for (let i = 0; i < 8; i++) {
    await t.db.update(drops).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(drops.id, id));
    await tickDrops(ctx);
  }
};
/** Moves a card along its path, as if this many seconds had passed. */
const age = (id: string, seconds: number) => t.db.update(drops).set({ opensAt: new Date(Date.now() - seconds * 1000) }).where(eq(drops.id, id));

beforeAll(async () => {
  t = await createTestDb(40);
  venue = createPaperVenue(t.db, { rng: rng(5) });
  ctx = { db: t.db, sql: t.sql, venue, cc: new CcRead(), rng: rng(17), log: () => {}, announce: async () => {} };
  await t.db.insert(machines).values({
    code: "pokemon_25", name: "Starter", price: usd(25), buybackPct: 85, ev: usd(27.49), odds: { common: 1 },
    tiers: { common: { start: 13, end: 30 } }, stock: { common: 500 },
  });
  await fund("drops", usd(5000));
});

afterAll(async () => {
  await t.shutdown();
});

describe("one click buys the card", () => {
  it("charges the price at that second, and the chart stops", async () => {
    const card = await liveCard();
    const userId = await makeUser(usd(200));
    await age(card.id, 120);
    const expected = card.path![120]!;

    const result = await buy(userId, card.id);
    expect(result).toMatchObject({ status: "won", price: expected });

    const stopped = await row(card.id);
    expect(stopped.state).toBe("CLAIMED");
    expect(stopped.price).toBe(expected);
    expect(stopped.boughtBy).toBe(`phantom${userId}`);
    expect(stopped.stoppedAt).not.toBeNull();

    await settle(card.id);
    const done = await row(card.id);
    expect(done.state).toBe("SETTLED");
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(200) - expected);
    const owned = (await t.db.select().from(holdings).where(eq(holdings.userId, userId)))[0]!;
    expect(owned.wallet).toBe("connected");
    expect(owned.cost).toBe(expected);
  });

  it("there is no second buyer", async () => {
    const card = await liveCard();
    const first = await makeUser(usd(200));
    const second = await makeUser(usd(200));
    expect((await buy(first, card.id)).status).toBe("won");
    expect(await buy(second, card.id)).toMatchObject({ status: "lost" });
    expect(await balanceOf(t.db, userAccount(second))).toBe(usd(200));
  });

  it("many people clicking at once produce one owner", async () => {
    const card = await liveCard();
    const people = await Promise.all(Array.from({ length: 80 }, () => makeUser(usd(200))));
    const results = await Promise.all(people.map((userId) => buy(userId, card.id)));
    expect(results.filter((r) => r.status === "won")).toHaveLength(1);
    expect(await t.db.select().from(claims).where(eq(claims.dropId, card.id))).toHaveLength(1);
  });

  it("protects a buyer when the price jumps mid-click", async () => {
    const card = await liveCard();
    const userId = await makeUser(usd(200));
    const price = card.path![0]!;
    expect(await buy(userId, card.id, price - usd(3))).toMatchObject({ status: "rejected", reason: "price_moved" });
    expect((await row(card.id)).state).toBe("LIVE");
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(200));
  });

  it("the price restarts moving if a buyer fails to pay", async () => {
    const card = await liveCard();
    const userId = await makeUser(usd(200));
    await buy(userId, card.id);
    await venue.drain(userAccount(userId), usd(200));
    await settle(card.id);
    const back = await row(card.id);
    expect(back.state).toBe("LIVE");
    expect(back.boughtBy).toBeNull();
    expect(back.stoppedAt).toBeNull();
    await venue.faucet(userAccount(userId), usd(200));
  });
});

describe("the price lock", () => {
  it("an unsold card keeps its final price, permanently, and can still be bought at it", async () => {
    const card = await liveCard();
    const userId = await makeUser(usd(200));
    await age(card.id, S.ttlSec + 30);
    const final = card.path!.at(-1)!;
    expect(pulseView(await row(card.id)).price).toBe(final);
    await age(card.id, S.ttlSec + 200);
    expect(pulseView(await row(card.id)).price).toBe(final);
    expect(await buy(userId, card.id)).toMatchObject({ status: "won", price: final });
  });

  it("after the hold, an unsold card goes back to CC", async () => {
    const card = await liveCard();
    await t.db.update(drops).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(drops.id, card.id));
    await settle(card.id);
    expect((await row(card.id)).state).toBe("BOUGHT_BACK");
  });
});

describe("what the world sees", () => {
  it("never reveals where the price is going", async () => {
    const card = await liveCard();
    await age(card.id, 10);
    const view = JSON.stringify(pulseView(await row(card.id)));
    expect(view).not.toContain('"path"');
    const seen = pulseView(await row(card.id)).series;
    expect(seen.length).toBeLessThanOrEqual(11);
  });
});

describe("limit orders", () => {
  it("buys the moment the price reaches the target, once", async () => {
    const card = await liveCard();
    const userId = await makeUser(usd(200));
    await setSetting(t.db, "drops", { winCooldownSec: 0 });
    const target = Math.max(...card.path!);
    await t.db.insert(dropLimits).values({ dropId: card.id, userId, maxPrice: target });
    await tickPulse(ctx);
    expect((await t.db.select().from(dropLimits).where(eq(dropLimits.userId, userId)))[0]!.state).toBe("filled");
    const stopped = await row(card.id);
    expect(stopped.boughtBy).toBe(`phantom${userId}`);
    expect(stopped.price).toBeLessThanOrEqual(target);
    await setSetting(t.db, "drops", { winCooldownSec: 300 });
  });

  it("stays open through a cooldown, then fills", async () => {
    const card = await liveCard();
    const userId = await makeUser(usd(200));
    await t.db.update(users).set({ lastWinAt: new Date() }).where(eq(users.id, userId));
    await t.db.insert(dropLimits).values({ dropId: card.id, userId, maxPrice: Math.max(...card.path!) });
    await tickPulse({ ...ctx, rng: () => 0.99 });
    expect((await t.db.select().from(dropLimits).where(eq(dropLimits.userId, userId)))[0]!.state).toBe("open");
    expect((await row(card.id)).state).toBe("LIVE");
    await t.db.update(users).set({ lastWinAt: null }).where(eq(users.id, userId));
    await tickPulse({ ...ctx, rng: () => 0.99 });
    expect((await t.db.select().from(dropLimits).where(eq(dropLimits.userId, userId)))[0]!.state).toBe("filled");
  });

  it("waits while the price is above the target", async () => {
    const card = await liveCard();
    const userId = await makeUser(usd(200));
    await t.db.insert(dropLimits).values({ dropId: card.id, userId, maxPrice: usd(1) });
    await tickPulse({ ...ctx, rng: () => 0.99 });
    expect((await t.db.select().from(dropLimits).where(eq(dropLimits.userId, userId)))[0]!.state).toBe("open");
    expect((await row(card.id)).state).toBe("LIVE");
  });
});

describe("limit orders, after the mainnet review", () => {
  it("never buys with an order that was cancelled after the worker read it", async () => {
    const card = await liveCard();
    const userId = await makeUser(usd(200));
    await setSetting(t.db, "drops", { winCooldownSec: 0 });
    const target = Math.max(...card.path!);
    const order = (await t.db.insert(dropLimits).values({ dropId: card.id, userId, maxPrice: target }).returning())[0]!;
    // The worker has read the open order and is about to claim. The user cancels in that moment.
    await t.db.update(dropLimits).set({ state: "cancelled" }).where(eq(dropLimits.id, order.id));
    const result = await claimDrop(t.db, { userId, dropId: card.id, idempotencyKey: `limit:${order.id}`, maxPrice: target, limitId: order.id });
    expect(result).toMatchObject({ status: "rejected", reason: "cancelled" });
    expect((await row(card.id)).state).toBe("LIVE");
    expect((await t.db.select().from(dropLimits).where(eq(dropLimits.id, order.id)))[0]!.state).toBe("cancelled");
    expect(await t.db.select().from(claims).where(eq(claims.userId, userId))).toEqual([]);
    await setSetting(t.db, "drops", { winCooldownSec: 300 });
  });

  it("waits while mainnet is unarmed, and fills once it is armed", async () => {
    const card = await liveCard();
    const userId = await makeUser(usd(200));
    await setSetting(t.db, "drops", { winCooldownSec: 0 });
    await t.db.insert(dropLimits).values({ dropId: card.id, userId, maxPrice: Math.max(...card.path!) });
    const mainnet = { ...ctx, rng: () => 0.99, venue: { ...venue, mode: "mainnet" } as never };
    await setSetting(t.db, "ops", { armedBy: [], armedUntil: null });
    await tickPulse(mainnet);
    // It used to fill here: the buyer's money went on hold, and nothing could be signed to settle it.
    expect((await t.db.select().from(dropLimits).where(eq(dropLimits.userId, userId)))[0]!.state).toBe("open");
    expect((await row(card.id)).state).toBe("LIVE");
    await setSetting(t.db, "ops", { armedBy: ["admin"], armedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    await tickPulse(mainnet);
    expect((await t.db.select().from(dropLimits).where(eq(dropLimits.userId, userId)))[0]!.state).toBe("filled");
    await setSetting(t.db, "ops", { armedBy: [], armedUntil: null });
    await setSetting(t.db, "drops", { winCooldownSec: 300 });
  });
});

describe("stand-in buyers", () => {
  it("run in paper mode and split their payment like real sales", async () => {
    const card = await liveCard();
    await age(card.id, 60);
    const before = await balanceOf(t.db, "revenue");
    await tickPulse({ ...ctx, rng: () => 0.0001 });
    const sold = await row(card.id);
    expect(sold.state).toBe("SETTLED");
    expect(sold.simBuyer).toBe(true);
    expect(sold.boughtBy).toBeTruthy();
    expect(await balanceOf(t.db, "revenue")).toBeGreaterThanOrEqual(before + Math.floor(sold.price! / 2));
  });

  it("can never run with real money", async () => {
    const card = await liveCard();
    await age(card.id, 60);
    const real = { ...ctx, rng: () => 0.0001, venue: { ...venue, mode: "devnet" } as never };
    for (let i = 0; i < 5; i++) await tickPulse(real);
    const after = await row(card.id);
    expect(after.state).toBe("LIVE");
    expect(after.simBuyer).toBe(false);
  });
});
