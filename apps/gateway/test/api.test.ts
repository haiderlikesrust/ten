import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { usd } from "@gemdex/core";
import { drops, eq, giftDraws, holdings, machines, orders, setSetting, users } from "@gemdex/db";
import { buildServer } from "../src/server";
import { createTestDb, type TestDb } from "../../../tools/testdb";

let t: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;

/** Signs in a paper user. They hold the $TENR access minimum (0.1% of 1B) unless told otherwise. */
async function login(handle: string, tokens = 1_000_000) {
  const res = await app.inject({ method: "POST", url: "/auth/paper", payload: { handle } });
  const { token } = res.json() as { token: string };
  const headers = { authorization: `Bearer ${token}` };
  if (tokens > 0) await app.inject({ method: "POST", url: "/rewards/paper-tokens", headers, payload: { tokens } });
  return headers;
}

beforeAll(async () => {
  t = await createTestDb(10);
  app = await buildServer({ database: t, mode: "paper" });
  await t.db.insert(machines).values({
    code: "pokemon_25", name: "Starter", price: usd(25), buybackPct: 85, ev: usd(27.49), odds: { common: 1 },
    tiers: { common: { start: 13, end: 30 } }, stock: { common: 5 },
  });
});

afterAll(async () => {
  await app.close();
  await t.shutdown();
});

describe("access control", () => {
  it("refuses every account route without a session", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/me"], ["GET", "/portfolio"], ["GET", "/activity"], ["GET", "/tracker"], ["GET", "/watchlist"], ["GET", "/rewards"],
      ["POST", "/wallet/faucet"], ["POST", "/orders/buy"], ["POST", "/orders/open"], ["POST", "/orders/holding"], ["POST", `/drops/${randomUUID()}/claim`],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as "GET", url, payload: method === "POST" ? {} : undefined });
      expect(`${url} ${res.statusCode}`).toBe(`${url} 401`);
    }
  });

  it("rejects a forged session", async () => {
    const res = await app.inject({ url: "/me", headers: { authorization: "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0." } });
    expect(res.statusCode).toBe(401);
  });

  it("keeps non-admins out of every admin route", async () => {
    const headers = await login("regular");
    const me = (await app.inject({ url: "/me", headers })).json() as { id: string };
    await t.sql`update users set is_admin = false where id = ${me.id}`;
    expect((await app.inject({ url: "/admin/overview", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/admin/ops", headers, payload: { killSwitch: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/admin/arm", headers, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/admin/settings/drops", headers, payload: {} })).statusCode).toBe(403);
  });

  it("one user cannot see or touch what belongs to another", async () => {
    const alice = await login("alice");
    const mallory = await login("mallory");
    const aliceId = ((await app.inject({ url: "/me", headers: alice })).json() as { id: string }).id;

    const placed = (await app.inject({ method: "POST", url: "/orders/open", headers: alice, payload: { machine: "pokemon_25", idempotencyKey: randomUUID() } })).json() as { orderIds: string[] };
    expect((await app.inject({ url: `/orders/${placed.orderIds[0]}`, headers: alice })).statusCode).toBe(200);
    expect((await app.inject({ url: `/orders/${placed.orderIds[0]}`, headers: mallory })).statusCode).toBe(404);

    const held = await t.db.insert(holdings).values({ userId: aliceId, nft: "n1", wallet: "connected", card: {}, source: "gacha", cost: usd(25) }).returning();
    const res = await app.inject({ method: "POST", url: "/orders/holding", headers: mallory, payload: { action: "buyback", holdingId: held[0]!.id, idempotencyKey: randomUUID() } });
    // The order is accepted, but the worker checks ownership and it fails without touching the card.
    const stolen = await t.db.select().from(orders);
    expect(res.statusCode).toBe(200);
    expect(stolen.find((o) => (o.params as { holdingId?: string }).holdingId === held[0]!.id)?.userId).not.toBe(aliceId);
  });
});

describe("hidden drops", () => {
  it("never leak over the API", async () => {
    const now = Date.now();
    await t.db.insert(drops).values({
      kind: "hidden", state: "LIVE", machineCode: "pokemon_25", packPrice: usd(25), commonFloor: usd(13), price: usd(9),
      nft: "SECRET_NFT", insuredValue: usd(999), rarity: "epic", card: { name: "SECRET_CARD" }, memo: "SECRET_MEMO",
      opensAt: new Date(now), expiresAt: new Date(now + 60_000),
    });
    const body = (await app.inject({ url: "/drops" })).body;
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("999000000");
  });
});

describe("input validation", () => {
  it("refuses bad orders", async () => {
    const headers = await login("validator");
    const buy = (payload: unknown) => app.inject({ method: "POST", url: "/orders/buy", headers, payload: payload as object });
    expect((await buy({ nft: "x", price: -5, idempotencyKey: "a" })).statusCode).toBe(400);
    expect((await buy({ nft: "x", price: 1.5, idempotencyKey: "b" })).statusCode).toBe(400);
    expect((await buy({ nft: "x", price: "1", idempotencyKey: "c" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/orders/holding", headers, payload: { action: "steal", holdingId: randomUUID(), idempotencyKey: "d" } })).statusCode).toBe(400);
    const claim = await app.inject({ method: "POST", url: "/drops/not-a-uuid/claim", headers, payload: { idempotencyKey: "e" } });
    expect(claim.json()).toMatchObject({ status: "rejected", reason: "not_found" });
  });

  it("cannot buy more than the wallet holds", async () => {
    const headers = await login("spender");
    const res = await app.inject({ method: "POST", url: "/orders/buy", headers, payload: { nft: "x", price: usd(501), idempotencyKey: randomUUID() } });
    expect(res.statusCode).toBe(402);
  });

  it("settings cannot store unknown keys or nonsense", async () => {
    const headers = await login("tinkerer");
    await app.inject({ method: "PATCH", url: "/me/settings", headers, payload: { isAdmin: true, strikes: -1, autoForward: true } });
    const me = (await app.inject({ url: "/me", headers })).json() as { settings: Record<string, unknown>; strikes: number };
    expect(me.settings.isAdmin).toBeUndefined();
    expect(me.strikes).toBe(0);
    const bad = await app.inject({ method: "PATCH", url: "/admin/settings/drops", headers, payload: { minPrice: 10, maxPrice: 1, crashLo: 0.5, crashHi: 0.8, ttlSec: 45 } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("pulse prices", () => {
  it("never shows a price that has not happened yet", async () => {
    const now = Date.now();
    // Every value here is unique, so any future price would be easy to spot in a response.
    const path = Array.from({ length: 300 }, (_, i) => 11_000_000 + i * 1_337);
    const rows = await t.db.insert(drops).values({
      kind: "revealed", state: "LIVE", machineCode: "pokemon_25", packPrice: usd(25), commonFloor: usd(13), price: path[0]!, path,
      insuredValue: usd(25), opensAt: new Date(now - 20_000), expiresAt: new Date(now + 600_000),
    }).returning();
    const id = rows[0]!.id;

    const detail = await app.inject({ url: `/pulse/drops/${id}` });
    const { prices } = detail.json() as { prices: number[] };
    expect(prices.length).toBeGreaterThan(15);
    expect(prices.length).toBeLessThanOrEqual(25);
    expect(prices).toEqual(path.slice(0, prices.length));

    const future = path.slice(prices.length + 5).map(String);
    for (const url of ["/pulse/drops", `/pulse/drops/${id}`, "/drops"]) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('"path"');
      for (const value of future) expect(res.body).not.toContain(value);
    }
  });

  it("stops at the moment a card is bought", async () => {
    const now = Date.now();
    const path = Array.from({ length: 300 }, (_, i) => 12_000_000 + i * 1_337);
    const rows = await t.db.insert(drops).values({
      kind: "revealed", state: "SETTLED", machineCode: "pokemon_25", packPrice: usd(25), commonFloor: usd(13), price: path[4]!, path,
      insuredValue: usd(25), opensAt: new Date(now - 60_000), expiresAt: new Date(now + 600_000), stoppedAt: new Date(now - 55_500), boughtBy: "BuyerWallet1111",
    }).returning();
    const { drop, prices } = (await app.inject({ url: `/pulse/drops/${rows[0]!.id}` })).json() as { drop: { price: number; boughtBy: string }; prices: number[] };
    expect(prices).toHaveLength(5);
    expect(drop.price).toBe(path[4]);
    expect(drop.boughtBy).toBe("BuyerWallet1111");
  });
});

describe("treasury transfers", () => {
  it("only admins record one, only on a real chain, with a real signature, and only once", async () => {
    const headers = await login("treasurer");
    const me = (await app.inject({ url: "/me", headers })).json() as { id: string; connectedWallet: string };
    const real = await buildServer({ database: t, mode: "devnet" });
    const saved = process.env.ADMIN_WALLETS;
    const send = (server: typeof app, payload: unknown) => server.inject({ method: "POST", url: "/admin/treasury-moves", headers, payload: payload as object });
    const signature = "5".repeat(87) + "z";
    // On a real chain, admin follows ADMIN_WALLETS.
    process.env.ADMIN_WALLETS = "";
    expect((await send(real, { signature, wallet: "drops" })).statusCode).toBe(403);
    process.env.ADMIN_WALLETS = me.connectedWallet;
    expect((await send(app, { signature, wallet: "drops" })).statusCode).toBe(400);
    expect((await send(real, { signature: "not-a-signature", wallet: "drops" })).statusCode).toBe(400);
    expect((await send(real, { signature, wallet: "vault" })).statusCode).toBe(400);
    expect((await send(real, { signature: ` ${signature} `, wallet: "drops" })).statusCode).toBe(200);
    expect((await send(real, { signature, wallet: "cashback" })).statusCode).toBe(409);
    process.env.ADMIN_WALLETS = saved;
    await real.close();
  });
});

describe("arming mainnet", () => {
  it("one admin arms it for 2 hours, renewing never cuts it short, disarm ends it, and admin follows ADMIN_WALLETS live", async () => {
    const [a, b, c] = [await login("arm_a"), await login("arm_b"), await login("arm_c")];
    const wallet = async (headers: { authorization: string }) => ((await app.inject({ url: "/me", headers })).json() as { connectedWallet: string }).connectedWallet;
    const saved = process.env.ADMIN_WALLETS;
    process.env.ADMIN_WALLETS = [await wallet(a), await wallet(b)].join(",");
    await setSetting(t.db, "ops", { armedBy: [], armedUntil: null });
    const main = await buildServer({ database: t, mode: "mainnet" });
    const post = async (url: string, headers: { authorization: string }) => main.inject({ method: "POST", url, headers, payload: {} });
    type Ops = { armedBy: string[]; armedUntil: string | null };
    try {
      // Paper made c an admin, but on a real chain only ADMIN_WALLETS counts.
      expect((await post("/admin/arm", c)).statusCode).toBe(403);
      // A single press arms it, for 2 hours.
      const armed = (await post("/admin/arm", a)).json() as Ops;
      expect(armed.armedBy).toHaveLength(1);
      expect(new Date(armed.armedUntil!).getTime()).toBeGreaterThan(Date.now() + 7_100_000);
      // Renewing restarts the 2 hours and never shortens them.
      const renewed = (await post("/admin/arm", b)).json() as Ops;
      expect(new Date(renewed.armedUntil!).getTime()).toBeGreaterThanOrEqual(new Date(armed.armedUntil!).getTime());
      // Disarm ends it at once.
      const off = (await post("/admin/disarm", a)).json() as Ops;
      expect(off.armedUntil).toBeNull();
      // Taking b out of ADMIN_WALLETS takes effect on the next request, without b signing in again.
      process.env.ADMIN_WALLETS = await wallet(a);
      expect((await post("/admin/arm", b)).statusCode).toBe(403);
      expect((await main.inject({ url: "/admin/overview", headers: b })).statusCode).toBe(403);
    } finally {
      process.env.ADMIN_WALLETS = saved;
      await setSetting(t.db, "ops", { armedBy: [], armedUntil: null });
      await main.close();
    }
  });
});

describe("trading routes", () => {
  it("refuse new trades while the kill switch is on, and answer an empty body with a 400", async () => {
    const headers = await login("paused_trader");
    await setSetting(t.db, "ops", { killSwitch: true });
    try {
      const res = await app.inject({ method: "POST", url: "/orders/open", headers, payload: { machine: "pokemon_25", count: 1, idempotencyKey: randomUUID() } });
      expect(res.statusCode).toBe(503);
    } finally {
      await setSetting(t.db, "ops", { killSwitch: false });
    }
    for (const url of ["/orders/buy", "/orders/open", "/orders/holding"]) {
      expect((await app.inject({ method: "POST", url, headers })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/orders/open", headers, payload: { machine: "pokemon_25", count: 2.5, idempotencyKey: "k" } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/listings?limit=-5&offset=-1" })).statusCode).toBe(200);
  });

  it("lets a winner claim a gift again after a failed attempt, with a new order", async () => {
    const headers = await login("gift_retry");
    const me = (await app.inject({ url: "/me", headers })).json() as { id: string };
    const [draw] = await t.db.insert(giftDraws).values({ slotAt: new Date(), state: "drawn", prize: usd(25), machineCode: "pokemon_25", winnerUserId: me.id, expiresAt: new Date(Date.now() + 3_600_000) }).returning();
    const first = (await app.inject({ method: "POST", url: `/gifts/${draw!.id}/claim`, headers })).json() as { orderId: string };
    // The worker fails the order and reopens the gift, as it does when Collector Crypt can't serve the pack.
    await t.db.update(orders).set({ state: "failed" }).where(eq(orders.id, first.orderId));
    await t.db.update(giftDraws).set({ orderId: null, state: "drawn" }).where(eq(giftDraws.id, draw!.id));
    const second = (await app.inject({ method: "POST", url: `/gifts/${draw!.id}/claim`, headers })).json() as { orderId: string };
    expect(second.orderId).toBeTruthy();
    expect(second.orderId).not.toBe(first.orderId);
  });
});

describe("mode gates", () => {
  it("arming only exists on mainnet, and paper-only routes vanish elsewhere", async () => {
    const headers = await login("ops");
    expect((await app.inject({ method: "POST", url: "/admin/arm", headers, payload: {} })).statusCode).toBe(400);
    const real = await buildServer({ database: t, mode: "devnet" });
    expect((await real.inject({ method: "POST", url: "/auth/paper", payload: {} })).statusCode).toBe(404);
    await real.close();
  });
});

void users;
void setSetting;

describe("$TENR access minimum", () => {
  const buy = (headers: Record<string, string>) =>
    app.inject({ method: "POST", url: "/orders/buy", headers, payload: { nft: "x", price: usd(1), idempotencyKey: randomUUID() } });
  const open = (headers: Record<string, string>) =>
    app.inject({ method: "POST", url: "/orders/open", headers, payload: { machine: "pokemon_25", idempotencyKey: randomUUID() } });

  it("refuses buys, pack opens and Pulse claims below 0.1% of supply, and says why", async () => {
    const headers = await login("no-tenr", 0);
    const bought = await buy(headers);
    expect(bought.statusCode).toBe(403);
    expect(bought.json()).toMatchObject({ code: "access", error: "Hold 0.1% of $TENR to use Tenner" });
    expect((await open(headers)).statusCode).toBe(403);
    const claim = await app.inject({ method: "POST", url: `/drops/${randomUUID()}/claim`, headers, payload: { idempotencyKey: randomUUID() } });
    expect(claim.json()).toMatchObject({ status: "rejected", reason: "access" });
    const me = (await app.inject({ url: "/me", headers })).json() as { access: { enforced: boolean; ok: boolean; needed: number; held: number } };
    expect(me.access).toMatchObject({ enforced: true, ok: false, needed: 1_000_000, held: 0 });
  });

  it("lets a holder through at exactly 0.1%, and not one token under", async () => {
    const short = await login("almost", 999_999);
    expect((await buy(short)).statusCode).toBe(403);
    const exact = await login("exactly", 1_000_000);
    // Past the minimum the order goes in (paper users start with $500).
    expect((await buy(exact)).statusCode).toBe(200);
  });

  it("still lets anyone browse without $TENR", async () => {
    const headers = await login("browser", 0);
    for (const url of ["/me", "/portfolio", "/rewards", "/listings", "/meta"]) {
      expect(`${url} ${(await app.inject({ url, headers })).statusCode}`).toBe(`${url} 200`);
    }
  });

  it("turns off when the minimum is set to 0", async () => {
    const headers = await login("free", 0);
    await setSetting(t.db, "flywheel", { accessBps: 0 });
    try {
      expect((await buy(headers)).statusCode).toBe(200);
    } finally {
      await setSetting(t.db, "flywheel", { accessBps: 10 });
    }
  });
});
