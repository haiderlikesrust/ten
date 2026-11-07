import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { usd } from "@gemdex/core";
import {
  availableBalance, balanceOf, claims, drops, eq, holds, post, setSetting, sql, userAccount, users,
} from "@gemdex/db";
import { claimDrop } from "../src/claim";
import { createTestDb, type TestDb } from "../../../tools/testdb";

let t: TestDb;

async function makeUser(balance: number) {
  const id = randomUUID();
  await t.db.insert(users).values({ id, handle: id.slice(0, 6), tradingWallet: `t${id}`, connectedWallet: `c${id}` });
  if (balance > 0) await t.db.transaction((tx) => post(tx, `seed:${id}`, "seed", [{ account: "world", delta: -balance }, { account: userAccount(id), delta: balance }]));
  return id;
}

async function makeDrop(price = usd(10)) {
  const now = Date.now();
  const rows = await t.db
    .insert(drops)
    .values({ kind: "revealed", state: "LIVE", machineCode: "pokemon_25", packPrice: usd(25), commonFloor: usd(13), price, insuredValue: usd(40), opensAt: new Date(now - 1000), expiresAt: new Date(now + 60_000) })
    .returning();
  return rows[0]!;
}

beforeAll(async () => {
  t = await createTestDb(60);
});
afterAll(async () => {
  await t.shutdown();
});

describe("first click wins", () => {
  it("500 users clicking at once produce exactly one winner", async () => {
    const drop = await makeDrop();
    const userIds = await Promise.all(Array.from({ length: 500 }, () => makeUser(usd(20))));

    const results = await Promise.all(userIds.map((userId) => claimDrop(t.db, { userId, dropId: drop.id, idempotencyKey: randomUUID() })));

    const winners = results.filter((r) => r.status === "won");
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === "lost")).toHaveLength(499);

    const claimRows = await t.db.select().from(claims).where(eq(claims.dropId, drop.id));
    expect(claimRows).toHaveLength(1);

    const held = await t.db.select().from(holds).where(eq(holds.ref, `drop:${drop.id}`));
    expect(held).toHaveLength(1);
    expect(held[0]!.status).toBe("active");

    const row = (await t.db.select().from(drops).where(eq(drops.id, drop.id)))[0]!;
    expect(row.state).toBe("CLAIMED");
    expect(row.winnerClaimId).toBe(claimRows[0]!.id);

    // Losers keep every cent available, the winner has exactly the price on hold.
    for (const userId of userIds) {
      const available = await availableBalance(t.db, userId);
      expect(available).toBe(userId === claimRows[0]!.userId ? usd(10) : usd(20));
    }
  });

  it("a retried click is the same claim, not a second one", async () => {
    const drop = await makeDrop();
    const userId = await makeUser(usd(20));
    const key = randomUUID();
    const first = await claimDrop(t.db, { userId, dropId: drop.id, idempotencyKey: key });
    const again = await claimDrop(t.db, { userId, dropId: drop.id, idempotencyKey: key });
    expect(first.status).toBe("won");
    expect(again).toMatchObject({ status: "won", repeat: true });
    if (first.status === "won" && again.status === "won") expect(again.claimId).toBe(first.claimId);
    expect(await t.db.select().from(holds).where(eq(holds.ref, `drop:${drop.id}`))).toHaveLength(1);
  });

  it("one wallet cannot spend the same dollars across parallel claims", async () => {
    const userId = await makeUser(usd(12));
    const dropList = await Promise.all(Array.from({ length: 30 }, () => makeDrop(usd(10))));
    const results = await Promise.all(dropList.map((d) => claimDrop(t.db, { userId, dropId: d.id, idempotencyKey: randomUUID() })));
    expect(results.filter((r) => r.status === "won")).toHaveLength(1);
    expect(await availableBalance(t.db, userId)).toBe(usd(2));
  });

  it("rejects users under the $5 minimum or short of the price", async () => {
    const drop = await makeDrop(usd(10));
    const poor = await makeUser(usd(4));
    const short = await makeUser(usd(7));
    expect(await claimDrop(t.db, { userId: poor, dropId: drop.id, idempotencyKey: randomUUID() })).toMatchObject({ status: "rejected", reason: "minimum_balance" });
    expect(await claimDrop(t.db, { userId: short, dropId: drop.id, idempotencyKey: randomUUID() })).toMatchObject({ status: "rejected", reason: "insufficient_funds" });
    expect((await t.db.select().from(drops).where(eq(drops.id, drop.id)))[0]!.state).toBe("LIVE");
  });

  it("refuses expired drops and unknown drops", async () => {
    const now = Date.now();
    const rows = await t.db
      .insert(drops)
      .values({ kind: "revealed", state: "LIVE", machineCode: "pokemon_25", packPrice: usd(25), commonFloor: usd(13), price: usd(10), opensAt: new Date(now - 5000), expiresAt: new Date(now - 1000) })
      .returning();
    const userId = await makeUser(usd(20));
    expect(await claimDrop(t.db, { userId, dropId: rows[0]!.id, idempotencyKey: randomUUID() })).toMatchObject({ status: "lost" });
    expect(await claimDrop(t.db, { userId, dropId: randomUUID(), idempotencyKey: randomUUID() })).toMatchObject({ status: "rejected", reason: "not_found" });
    expect(await t.db.select().from(holds).where(eq(holds.ref, `drop:${rows[0]!.id}`))).toHaveLength(0);
  });

  it("applies the win cooldown, and 0 turns it off", async () => {
    const userId = await makeUser(usd(50));
    await t.db.update(users).set({ lastWinAt: new Date() }).where(eq(users.id, userId));
    const drop = await makeDrop();
    const blocked = await claimDrop(t.db, { userId, dropId: drop.id, idempotencyKey: randomUUID() });
    expect(blocked).toMatchObject({ status: "rejected", reason: "cooldown" });
    await setSetting(t.db, "drops", { winCooldownSec: 0 });
    expect(await claimDrop(t.db, { userId, dropId: drop.id, idempotencyKey: randomUUID() })).toMatchObject({ status: "won" });
    await setSetting(t.db, "drops", { winCooldownSec: 300 });
  });

  it("the database refuses a negative balance even if the app logic is wrong", async () => {
    const userId = await makeUser(usd(1));
    await expect(
      t.db.transaction((tx) => post(tx, `overdraw:${userId}`, "test", [{ account: userAccount(userId), delta: -usd(2) }, { account: "world", delta: usd(2) }])),
    ).rejects.toThrow();
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(1));
  });

  it("a ledger ref applies once and an unbalanced batch is refused", async () => {
    const userId = await makeUser(usd(5));
    const legs = [{ account: "world", delta: -usd(1) }, { account: userAccount(userId), delta: usd(1) }];
    const ref = `once:${userId}`;
    expect(await t.db.transaction((tx) => post(tx, ref, "test", legs))).toBe(true);
    expect(await t.db.transaction((tx) => post(tx, ref, "test", legs))).toBe(false);
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(6));
    await expect(t.db.transaction((tx) => post(tx, `${ref}:bad`, "test", [{ account: "world", delta: -1 }]))).rejects.toThrow(/unbalanced/);
  });
});

void sql;
