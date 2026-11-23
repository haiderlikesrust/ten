// Sell to Tenner: Tenner buys a user's card for its Collector Crypt buyback price and drops it in Pulse instead of a
// pack. Unsold, it goes back to Collector Crypt for that same price, so the pool ends where it started.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SOLD_TO_TENNER, usd } from "@gemdex/core";
import { activity, balanceOf, ccPacks, drops, eq, holdings, machines, orders, placeOrder, post, setSetting, sql, userAccount, users } from "@gemdex/db";
import { CcRead, createPaperVenue, type PaperVenue } from "@gemdex/venues";
import { tickDrops, tickOrders, tickScheduler, type Ctx } from "../src/lib";
import { createTestDb, type TestDb } from "../../../tools/testdb";

let t: TestDb;
let venue: PaperVenue;
let ctx: Ctx;

const INSURED = usd(30);
/** pokemon_25 buys back at 85%. */
const BUYBACK = Math.floor((INSURED * 85) / 100);

async function seed(account: string, amount: number) {
  await t.db.transaction((tx) => post(tx, `seed:${account}:${randomUUID()}`, "seed", [{ account: "world", delta: -amount }, { account, delta: amount }]));
  await venue.faucet(account, amount);
}

/** Sets the Pulse pool, book and wallet, to exactly this much. */
async function setPool(target: number) {
  const diff = target - (await balanceOf(t.db, "drops"));
  if (diff !== 0) await seed("drops", diff);
}

/** A user holding a pulled card whose buyback window opened `ageHours` ago. */
async function userWithCard(ageHours = 1) {
  const id = randomUUID();
  await t.db.insert(users).values({ id, handle: id.slice(0, 6), tradingWallet: `trade${id}`, connectedWallet: `phantom${id}` });
  const nft = `nft${randomUUID().replace(/-/g, "")}`;
  const openedAt = new Date(Date.now() - ageHours * 3600_000);
  await t.db.insert(ccPacks).values({ memo: `memo${nft}`, userId: id, machineCode: "pokemon_25", price: usd(25), deliverTo: `phantom${id}`, raw: "{}", state: "opened", nft, insuredValue: INSURED, openedAt });
  const rows = await t.db.insert(holdings).values({
    userId: id, nft, wallet: "connected", card: { name: "Test Charizard", image: null }, source: "gacha", cost: usd(25), insuredValue: INSURED,
    buybackUntil: new Date(openedAt.getTime() + 72 * 3600_000), buybackAmount: BUYBACK,
  }).returning({ id: holdings.id });
  return { userId: id, nft, holdingId: rows[0]!.id };
}

async function sell(userId: string, holdingId: string) {
  const placed = await t.db.transaction((tx) => placeOrder(tx, { userId, kind: "sell_tenner", params: { holdingId }, holdAmount: 0, idempotencyKey: randomUUID() }));
  if (!placed.ok) throw new Error("order not placed");
  for (let i = 0; i < 10; i++) {
    await t.db.update(orders).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(orders.id, placed.orderId));
    await tickOrders(ctx);
    const row = (await t.db.select().from(orders).where(eq(orders.id, placed.orderId)))[0]!;
    if (row.state === "done" || row.state === "failed") return row;
  }
  throw new Error("order never finished");
}

async function dropFor(nft: string) {
  return (await t.db.select().from(drops).where(eq(drops.nft, nft)))[0];
}

beforeAll(async () => {
  t = await createTestDb(20);
  venue = createPaperVenue(t.db);
  ctx = { db: t.db, sql: t.sql, venue, cc: new CcRead(), rng: () => 0.5, log: () => {}, announce: async () => {} };
  const tiers = { common: { start: 13, end: 30 }, uncommon: { start: 30, end: 55 }, rare: { start: 55, end: 125 }, epic: { start: 125, end: 500 } };
  await t.db.insert(machines).values({
    code: "pokemon_25", name: "Starter", price: usd(25), buybackPct: 85, ev: usd(27.49), odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 },
    tiers, stock: { common: 500, uncommon: 100, rare: 50, epic: 10 },
  });
});
afterAll(async () => {
  await t.shutdown();
});
beforeEach(async () => {
  await setSetting(t.db, "ops", { killSwitch: false, reconcileHold: false, armedBy: [], armedUntil: null });
  await setSetting(t.db, "drops", { sellEnabled: true, sellMax: usd(100), walletFloor: 0, dailySpendCap: usd(1_000_000) });
  await t.db.update(drops).set({ state: "VOID" }).where(sql`${drops.state} not in ('SETTLED','DELIVERED','BOUGHT_BACK','SKIPPED','REFUNDED','VOID')`);
  await t.sql`delete from app_settings where key = 'dropsStatus'`;
});

describe("Sell to Tenner", () => {
  it("pays the buyback price, drops the card in Pulse, and sells it back for the same when nobody buys it", async () => {
    await setPool(usd(100));
    const { userId, nft, holdingId } = await userWithCard();

    const order = await sell(userId, holdingId);
    expect(order.state).toBe("done");
    expect(await balanceOf(t.db, userAccount(userId))).toBe(BUYBACK);
    expect(await balanceOf(t.db, "drops")).toBe(usd(100) - BUYBACK);
    const holding = (await t.db.select().from(holdings).where(eq(holdings.id, holdingId)))[0]!;
    expect(holding.status).toBe("sold");
    expect(holding.exitPrice).toBe(BUYBACK);
    expect((await t.db.select().from(activity).where(eq(activity.userId, userId))).map((a) => a.title)).toContain("Sold Test Charizard to Tenner");

    // It waits for a Pulse slot, unseen, like a pack being opened.
    let drop = (await dropFor(nft))!;
    expect(drop).toMatchObject({ origin: "user", state: "IN_VAULT", machineCode: SOLD_TO_TENNER, packPrice: BUYBACK, insuredValue: INSURED });
    expect(drop.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 3600_000);

    // The scheduler gives it the next slot instead of opening a pack.
    await tickScheduler(ctx);
    await tickDrops(ctx);
    drop = (await dropFor(nft))!;
    expect(drop.state).toBe("LIVE");
    expect((await t.db.select().from(drops).where(eq(drops.state, "PLANNED"))).length).toBe(0);

    // Nobody buys it: it goes back to Collector Crypt, and the pool is whole again.
    await t.db.update(drops).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(drops.id, drop.id));
    for (let i = 0; i < 4 && drop.state !== "BOUGHT_BACK"; i++) {
      await t.db.update(drops).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(drops.id, drop.id));
      await tickDrops(ctx);
      drop = (await dropFor(nft))!;
    }
    expect(drop.state).toBe("BOUGHT_BACK");
    expect(drop.soldBackFor).toBe(BUYBACK);
    expect(await balanceOf(t.db, "drops")).toBe(usd(100));
  });

  it("takes the next slot even when the pool is too low for a pack", async () => {
    await setPool(BUYBACK);
    const { userId, nft, holdingId } = await userWithCard();
    expect((await sell(userId, holdingId)).state).toBe("done");
    expect(await balanceOf(t.db, "drops")).toBe(0);
    await tickScheduler(ctx);
    await tickDrops(ctx);
    expect((await dropFor(nft))!.state).toBe("LIVE");
  });

  it("only uses money the pool has free, and never the same dollars twice", async () => {
    await setPool(BUYBACK + usd(5));
    const first = await userWithCard();
    const second = await userWithCard();
    expect((await sell(first.userId, first.holdingId)).state).toBe("done");
    const refused = await sell(second.userId, second.holdingId);
    expect(refused.state).toBe("failed");
    expect(refused.error).toMatch(/can't take a card right now/);
    expect(await balanceOf(t.db, userAccount(second.userId))).toBe(0);
    expect((await t.db.select().from(holdings).where(eq(holdings.id, second.holdingId)))[0]!.status).toBe("held");
  });

  it("refuses, with nothing moved, when it is off, the card is worth too much, or its window is nearly closed", async () => {
    await setPool(usd(500));
    const before = await balanceOf(t.db, "drops");

    await setSetting(t.db, "drops", { sellEnabled: false });
    const off = await userWithCard();
    expect((await sell(off.userId, off.holdingId)).error).toMatch(/switched off/);

    await setSetting(t.db, "drops", { sellEnabled: true, sellMax: usd(20) });
    const dear = await userWithCard();
    expect((await sell(dear.userId, dear.holdingId)).error).toMatch(/up to \$20/);

    await setSetting(t.db, "drops", { sellMax: usd(100) });
    // 64 hours into a 72-hour window leaves 8: too little to wait, run and be sold back with the safety margin.
    const late = await userWithCard(64);
    expect((await sell(late.userId, late.holdingId)).error).toMatch(/Too little time/);

    expect(await balanceOf(t.db, "drops")).toBe(before);
    expect((await t.db.select().from(drops).where(eq(drops.origin, "user"))).filter((d) => [off.nft, dear.nft, late.nft].includes(d.nft ?? "")).length).toBe(0);
  });
});
