// The $TENR flywheel's gift draws (docs/FLYWHEEL.md), against a real throwaway database in paper mode.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { giftGroupOrder, pickGiftWinner, giftEntriesText, usd, type GiftGroup } from "@gemdex/core";
import { balanceOf, ccPacks, eq, giftDraws, holderStreaks, holdings, machines, orders, placeOrder, poolCards, post, setSetting, userAccount, users } from "@gemdex/db";
import { CcRead, createPaperVenue, type PaperVenue } from "@gemdex/venues";
import { paperTokenReader } from "@gemdex/venues/holdings";
import { createHash } from "node:crypto";
import { tickGiftDraws, tickHolderStreaks } from "../src/gifts";
import { tickOrders } from "../src/orders";
import type { Ctx } from "../src/ctx";
import { createTestDb, type TestDb } from "../../../tools/testdb";

let t: TestDb;
let venue: PaperVenue;
let ctx: Ctx;

const MIN = 60_000;
/** A moment inside a slot whose first group is `group`. */
function slotFor(group: GiftGroup, after = Date.UTC(2026, 10, 7)): number {
  for (let at = after; ; at += 30 * MIN) if (giftGroupOrder(at, 30)[0] === group) return at + 5 * MIN;
}

async function makeUser(opts: { tenr?: number; admin?: boolean } = {}) {
  const id = randomUUID();
  await t.db.insert(users).values({ id, handle: id.slice(0, 6), tradingWallet: `trade${id}`, connectedWallet: `phantom${id}`, isAdmin: !!opts.admin });
  if (opts.tenr) await venue.setTokenBalance(`phantom${id}`, opts.tenr);
  return id;
}

/** Packs opened on the Gacha Desk at a given time. */
async function openedPacks(userId: string, n: number, at: number, price = usd(25)) {
  for (let i = 0; i < n; i++) {
    await t.db.insert(ccPacks).values({ memo: randomUUID(), userId, machineCode: "pokemon_25", price, deliverTo: "x", raw: "x", state: "opened", createdAt: new Date(at - 10 * MIN) });
  }
}

async function fillPool(amount: number) {
  await t.db.transaction((tx) => post(tx, `test_gift_pool:${randomUUID()}`, "test", [{ account: "world", delta: -amount }, { account: "gifts", delta: amount }]));
}

async function drawAt(at: number) {
  await tickGiftDraws(ctx, at);
  const rows = await t.db.select().from(giftDraws);
  return rows.find((d) => d.slotAt.getTime() === Math.floor(at / (30 * MIN)) * 30 * MIN)!;
}

beforeAll(async () => {
  t = await createTestDb(10);
  venue = createPaperVenue(t.db);
  ctx = { db: t.db, sql: t.sql, venue, cc: new CcRead(), rng: Math.random, log: () => {}, announce: async () => {}, tokens: paperTokenReader((w) => venue.chain.tokenBalance(w)), slots: null };
  await t.db.insert(machines).values([
    { code: "pokemon_50", name: "Fifty", price: usd(50), buybackPct: 85, ev: usd(52), odds: { common: 1 }, tiers: { common: { start: 25, end: 60 } }, stock: { common: 5 } },
    { code: "pokemon_100", name: "Hundred", price: usd(100), buybackPct: 90, ev: usd(104), odds: { common: 1 }, tiers: { common: { start: 50, end: 120 } }, stock: { common: 5 } },
  ]);
  await t.db.insert(poolCards).values(Array.from({ length: 20 }, (_, i) => ({ nft: `gift-card-${i}`, machineCode: i % 2 ? "pokemon_100" : "pokemon_50", rarity: "common", name: `Gift card ${i}`, insuredValue: usd(60) })));
  // The Drops wallet holds the gift pool on chain.
  await venue.faucet("drops", usd(5_000));
});

afterAll(async () => {
  await t.shutdown();
});

beforeEach(async () => {
  await t.sql`delete from gift_draws`;
  await t.sql`delete from holder_streaks`;
  await t.sql`delete from cc_packs`;
  await t.sql`update users set is_admin = true`; // Users from earlier tests can't win later ones.
});

describe("gift draws", () => {
  it("rolls over while the pool can't cover the smallest pack", async () => {
    const at = slotFor("active");
    const draw = await drawAt(at);
    expect(draw).toMatchObject({ state: "rolled", reason: "The pool is still filling" });
  });

  it("gives an active user a pack, holds the prize back from the pool, and draws once per slot", async () => {
    await fillPool(usd(1_300) - (await balanceOf(t.db, "gifts")));
    const at = slotFor("active", Date.UTC(2026, 10, 8));
    const player = await makeUser({ tenr: 1_000_000 });
    await openedPacks(player, 10, at);
    const draw = await drawAt(at);
    expect(draw).toMatchObject({ state: "drawn", grp: "active", prize: usd(100), machineCode: "pokemon_100", winnerUserId: player });
    expect(draw.entries).toEqual([{ userId: player, wallet: `phantom${player}`, weight: 10 }]);
    expect(await balanceOf(t.db, "gifts")).toBe(usd(1_200));
    expect(await balanceOf(t.db, "gift_reserved")).toBe(usd(100));
    // Anyone can check the result from what's published.
    const hash = createHash("sha256").update(giftEntriesText(draw.entries)).digest("hex");
    expect(draw.entriesHash).toBe(hash);
    expect(pickGiftWinner(draw.entries, draw.seed!)?.userId).toBe(player);
    // A second tick in the same slot doesn't draw again.
    await tickGiftDraws(ctx, at + MIN);
    expect((await t.db.select().from(giftDraws)).length).toBe(1);
  });

  it("needs 10 packs in the hour, the access minimum, and nobody blocked", async () => {
    await fillPool(usd(700));
    const at = slotFor("active", Date.UTC(2026, 10, 9));
    const nine = await makeUser({ tenr: 1_000_000 });
    await openedPacks(nine, 9, at);
    const stale = await makeUser({ tenr: 1_000_000 });
    await openedPacks(stale, 10, at - 2 * 3_600_000);
    const broke = await makeUser({ tenr: 999_999 });
    await openedPacks(broke, 12, at);
    const admin = await makeUser({ tenr: 5_000_000, admin: true });
    await openedPacks(admin, 12, at);
    const draw = await drawAt(at);
    expect(draw).toMatchObject({ state: "rolled", reason: "Nobody was eligible" });
    expect(await balanceOf(t.db, "gift_reserved")).toBe(usd(100));
  });

  it("long holders need 2% now, and win more for holding longer", async () => {
    const at = slotFor("holders", Date.UTC(2026, 10, 10));
    const whale = await makeUser({ tenr: 20_000_000 });
    const dolphin = await makeUser({ tenr: 10_000_000 });
    await tickHolderStreaks(ctx, at - 3 * 86_400_000);
    const streaks = await t.db.select().from(holderStreaks);
    expect(streaks.map((s) => s.userId)).toEqual([whale]);
    await t.db.update(holderStreaks).set({ aboveSince: new Date(at - 3 * 86_400_000 - MIN) }).where(eq(holderStreaks.userId, whale));
    const draw = await drawAt(at);
    expect(draw).toMatchObject({ state: "drawn", grp: "holders", winnerUserId: whale });
    expect(draw.entries).toEqual([{ userId: whale, wallet: `phantom${whale}`, weight: 4 }]);
    void dolphin;
    // Selling under 2% ends the streak.
    await venue.setTokenBalance(`phantom${whale}`, 19_999_999);
    await tickHolderStreaks(ctx, at + MIN);
    expect((await t.db.select().from(holderStreaks).where(eq(holderStreaks.userId, whale)))[0]!.aboveSince).toBeNull();
  });

  it("a recent winner sits out, and an unclaimed gift goes back to the pool", async () => {
    await fillPool(usd(1_300) - (await balanceOf(t.db, "gifts")));
    const reservedBefore = await balanceOf(t.db, "gift_reserved");
    const at = slotFor("active", Date.UTC(2026, 10, 11));
    const player = await makeUser({ tenr: 1_000_000 });
    await openedPacks(player, 10, at);
    const won = await drawAt(at);
    expect(won.winnerUserId).toBe(player);
    // Same player, next active slot, inside the 24-hour cooldown.
    const next = slotFor("active", at + 30 * MIN);
    await openedPacks(player, 10, next);
    expect((await drawAt(next)).state).toBe("rolled");
    // Nobody claims for 24 hours.
    const pool = await balanceOf(t.db, "gifts");
    await tickGiftDraws(ctx, won.expiresAt!.getTime() + MIN);
    const after = (await t.db.select().from(giftDraws).where(eq(giftDraws.id, won.id)))[0]!;
    expect(after.state).toBe("expired");
    expect(await balanceOf(t.db, "gifts")).toBe(pool + won.prize!);
    expect(await balanceOf(t.db, "gift_reserved")).toBe(reservedBefore);
  });

  it("stays off when gifts are turned off", async () => {
    await setSetting(t.db, "flywheel", { giftsEnabled: false });
    try {
      await tickGiftDraws(ctx, slotFor("active", Date.UTC(2026, 10, 12)));
      expect((await t.db.select().from(giftDraws)).length).toBe(0);
    } finally {
      await setSetting(t.db, "flywheel", { giftsEnabled: true });
    }
  });

  it("pays a claimed gift from its reserved prize, never from the winner", async () => {
    await fillPool(usd(1_300) - (await balanceOf(t.db, "gifts")));
    const at = slotFor("active", Date.UTC(2026, 10, 13));
    const player = await makeUser({ tenr: 1_000_000 });
    await openedPacks(player, 10, at);
    const draw = await drawAt(at);
    expect(draw.state).toBe("drawn");
    const reserved = await balanceOf(t.db, "gift_reserved");
    const wallet = await balanceOf(t.db, userAccount(player));
    // What the claim route does: a pack order with no hold, tied to the gift.
    const placed = await t.db.transaction((tx) => placeOrder(tx, { userId: player, kind: "gacha_open", params: { machine: draw.machineCode, turbo: false, gift: draw.id }, holdAmount: 0, idempotencyKey: `gift:${draw.id}` }));
    expect(placed.ok).toBe(true);
    await t.db.update(giftDraws).set({ orderId: placed.ok ? placed.orderId : null, state: "claimed" }).where(eq(giftDraws.id, draw.id));
    for (let i = 0; i < 20; i++) {
      await tickOrders(ctx);
      const order = (await t.db.select().from(orders).where(eq(orders.id, placed.ok ? placed.orderId : "")))[0]!;
      if (order.state === "done" || order.state === "failed") break;
      await t.db.update(orders).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(orders.id, order.id));
    }
    const order = (await t.db.select().from(orders).where(eq(orders.id, placed.ok ? placed.orderId : "")))[0]!;
    expect(order.state).toBe("done");
    expect(await balanceOf(t.db, "gift_reserved")).toBe(reserved - draw.prize!);
    expect(await balanceOf(t.db, userAccount(player))).toBe(wallet);
    const card = (await t.db.select().from(holdings).where(eq(holdings.userId, player)))[0]!;
    expect(card.cost).toBe(0);
    // The gift pack doesn't count toward the winner's own activity or spend in later draws.
    const own = await t.sql<{ n: number }[]>`select count(*)::int as n from cc_packs where user_id = ${player} and drop_id is null and state in ('paid', 'opened')
      and memo not in (select memo from orders where params ? 'gift' and memo is not null)`;
    const all = await t.sql<{ n: number }[]>`select count(*)::int as n from cc_packs where user_id = ${player} and drop_id is null and state in ('paid', 'opened')`;
    expect(all[0]!.n - own[0]!.n).toBe(1);
  });
});