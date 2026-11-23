// Public profiles and the sniping leaderboard.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usd } from "@gemdex/core";
import { holdings, setSetting } from "@gemdex/db";
import { buildServer } from "../src/server";
import { createTestDb, type TestDb } from "../../../tools/testdb";

let t: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;

async function login(handle: string) {
  const { token } = (await app.inject({ method: "POST", url: "/auth/paper", payload: { handle } })).json() as { token: string };
  const headers = { authorization: `Bearer ${token}` };
  const me = (await app.inject({ url: "/me", headers })).json() as { id: string };
  return { headers, id: me.id };
}

const PNG = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString("base64");

beforeAll(async () => {
  t = await createTestDb(10);
  app = await buildServer({ database: t, mode: "paper" });
});
afterAll(async () => {
  await app.close();
  await t.shutdown();
});

describe("profiles", () => {
  it("gives each username to one person, ignoring case, and refuses reserved or malformed ones", async () => {
    const a = await login("alice");
    const b = await login("bob");
    expect((await app.inject({ method: "PATCH", url: "/profile", headers: a.headers, payload: { username: "0GAntD", bio: "Charizard hunter", xHandle: "@0GAntD" } })).statusCode).toBe(200);
    const taken = await app.inject({ method: "PATCH", url: "/profile", headers: b.headers, payload: { username: "0gantd" } });
    expect(taken.statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: "/profile", headers: b.headers, payload: { username: "Admin" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/profile", headers: b.headers, payload: { username: "no spaces" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/profile", headers: b.headers, payload: { bio: "x".repeat(161) } })).statusCode).toBe(400);
    // The owner can change the case of their own name.
    expect((await app.inject({ method: "PATCH", url: "/profile", headers: a.headers, payload: { username: "0gAntD" } })).statusCode).toBe(200);
    const me = (await app.inject({ url: "/me", headers: a.headers })).json() as { username: string };
    expect(me.username).toBe("0gAntD");
  });

  it("stores a picture only when its bytes are the type it claims, and serves it cacheable", async () => {
    const c = await login("carol");
    const fake = "data:image/png;base64," + Buffer.from("<svg onload=alert(1)>").toString("base64");
    expect((await app.inject({ method: "PUT", url: "/profile/avatar", headers: c.headers, payload: { image: fake } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/profile/avatar", headers: c.headers, payload: { image: "data:image/svg+xml;base64,PHN2Zz4=" } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: "/profile/avatar", headers: c.headers, payload: { image: PNG } });
    expect(ok.statusCode).toBe(200);
    const { avatarUrl } = ok.json() as { avatarUrl: string };
    const served = await app.inject({ url: avatarUrl });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["cache-control"]).toContain("immutable");
    // A new picture replaces the old one, which is gone.
    const next = (await app.inject({ method: "PUT", url: "/profile/avatar", headers: c.headers, payload: { image: PNG } })).json() as { avatarUrl: string };
    expect(next.avatarUrl).not.toBe(avatarUrl);
    expect((await app.inject({ url: avatarUrl })).statusCode).toBe(404);
  });

  it("shows a public page with snipe stats and never a wallet address", async () => {
    const d = await login("dave");
    await app.inject({ method: "PATCH", url: "/profile", headers: d.headers, payload: { username: "paincrypt0" } });
    await t.db.insert(holdings).values([
      { userId: d.id, nft: "n1", wallet: "connected", card: { name: "Pikachu" }, source: "drop", cost: usd(10), insuredValue: usd(40) },
      { userId: d.id, nft: "n2", wallet: "connected", card: { name: "Mew" }, source: "drop", cost: usd(20), insuredValue: usd(30), status: "sold", exitPrice: usd(15) },
      { userId: d.id, nft: "n3", wallet: "connected", card: { name: "Pack card" }, source: "gacha", cost: usd(25), insuredValue: usd(100) },
    ]);
    const res = await app.inject({ url: "/profiles/PAINCRYPT0" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { profile: Record<string, unknown>; stats: { allTime: { snipes: number; profit: number; best: number } }; best: { name: string } };
    // Pikachu held at insured value (+30), Mew sold for less than it cost (-5). The pack pull is not a snipe.
    expect(body.stats.allTime).toMatchObject({ snipes: 2, profit: usd(25), best: usd(30) });
    expect(body.best.name).toBe("Pikachu");
    expect(JSON.stringify(body)).not.toMatch(/tradingWallet|connectedWallet|phantom|trade[0-9a-f]/i);
    expect((await app.inject({ url: "/profiles/nobody_here" })).statusCode).toBe(404);
  });
});

describe("leaderboard", () => {
  it("ranks snipers by the chosen measure and links only those with a profile", async () => {
    const e = await login("erin");
    await t.db.insert(holdings).values([
      { userId: e.id, nft: "e1", wallet: "connected", card: { name: "A" }, source: "drop", cost: usd(5), insuredValue: usd(6) },
      { userId: e.id, nft: "e2", wallet: "connected", card: { name: "B" }, source: "drop", cost: usd(5), insuredValue: usd(6) },
      { userId: e.id, nft: "e3", wallet: "connected", card: { name: "C" }, source: "drop", cost: usd(5), insuredValue: usd(6) },
    ]);
    type Board = { rows: Array<{ name: string; username: string | null; snipes: number; profit: number }> };
    const byProfit = (await app.inject({ url: "/leaderboard?period=all&sort=profit" })).json() as Board;
    expect(byProfit.rows[0]).toMatchObject({ username: "paincrypt0", profit: usd(25) });
    const bySnipes = (await app.inject({ url: "/leaderboard?period=all&sort=snipes" })).json() as Board;
    expect(bySnipes.rows[0]).toMatchObject({ name: "erin", username: null, snipes: 3 });
    // A bad period or sort falls back instead of failing.
    expect((await app.inject({ url: "/leaderboard?period=forever&sort=drop table" })).statusCode).toBe(200);
  });
});

describe("Sell to Tenner", () => {
  it("is refused while switched off, and starts one order per card when on", async () => {
    const f = await login("frank");
    const rows = await t.db.insert(holdings).values({ userId: f.id, nft: "f1", wallet: "connected", card: { name: "F" }, source: "gacha", cost: usd(25), insuredValue: usd(30) }).returning({ id: holdings.id });
    const url = `/holdings/${rows[0]!.id}/sell-to-tenner`;
    expect((await app.inject({ method: "POST", url, headers: f.headers, payload: { idempotencyKey: "k1" } })).statusCode).toBe(400);
    await setSetting(t.db, "drops", { sellEnabled: true });
    const first = (await app.inject({ method: "POST", url, headers: f.headers, payload: { idempotencyKey: "k2" } })).json() as { orderId: string };
    const again = (await app.inject({ method: "POST", url, headers: f.headers, payload: { idempotencyKey: "k3" } })).json() as { orderId: string };
    expect(again.orderId).toBe(first.orderId);
    const other = await login("gina");
    expect((await app.inject({ method: "POST", url, headers: other.headers, payload: { idempotencyKey: "k4" } })).statusCode).toBe(404);
  });
});
