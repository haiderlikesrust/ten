// Transfers an admin makes into or out of a treasury wallet by hand, recorded by signature so the books follow.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usd } from "@gemdex/core";
import { balanceOf, chainTx, eq, getSetting, post, setSetting, treasuryMoves } from "@gemdex/db";
import { CcRead, createPaperVenue, type Party, type UsdcMoved } from "@gemdex/venues";
import { tickTreasuryMoves } from "../src/treasury";
import { tickScheduler } from "../src/drops";
import { reconcile } from "../src/reconcile";
import type { Ctx } from "../src/ctx";
import { createTestDb, type TestDb } from "../../../tools/testdb";

let t: TestDb;
let ctx: Ctx;
/** What the fake chain reports for each signature, per wallet. */
const onChain = new Map<string, UsdcMoved | ((party: Party) => UsdcMoved)>();
let n = 0;
// Padded with a letter: padded with "1", the 3rd and the 13th signature came out the same.
const sig = () => `${"5".repeat(60)}${String(++n).padStart(8, "A").replace(/0/g, "z")}`;

beforeAll(async () => {
  t = await createTestDb(4);
  const venue = createPaperVenue(t.db);
  const chain = Object.assign(Object.create(Object.getPrototypeOf(venue.chain)), venue.chain, {
    usdcMoved: async (party: Party, signature: string): Promise<UsdcMoved> => {
      const found = onChain.get(signature);
      if (!found) return { status: "missing" };
      return typeof found === "function" ? found(party) : found;
    },
  });
  // Shaped like mainnet: these transfers only exist outside paper.
  ctx = { db: t.db, sql: t.sql, venue: { ...venue, mode: "devnet", chain } as never, cc: new CcRead(), rng: Math.random, log: () => {}, announce: async () => {} };
});
afterAll(async () => {
  await t.shutdown();
});
beforeEach(async () => {
  await t.db.delete(treasuryMoves);
});

async function record(wallet: "drops" | "cashback", signature = sig(), createdAt = new Date()) {
  await t.db.insert(treasuryMoves).values({ signature, wallet, createdAt });
  return signature;
}
const moveOf = async (signature: string) => (await t.db.select().from(treasuryMoves).where(eq(treasuryMoves.signature, signature)))[0]!;

describe("treasury transfers", () => {
  it("books a deposit into the Pulse pool, once, however often it is read", async () => {
    const before = await balanceOf(t.db, "drops");
    const signature = await record("drops");
    onChain.set(signature, { status: "ok", amount: usd(100) });
    await tickTreasuryMoves(ctx);
    await tickTreasuryMoves(ctx);
    expect(await balanceOf(t.db, "drops")).toBe(before + usd(100));
    expect(await moveOf(signature)).toMatchObject({ state: "BOOKED", amount: usd(100) });
    // Recorded twice by mistake: the second can never book again.
    await t.db.update(treasuryMoves).set({ state: "PENDING" }).where(eq(treasuryMoves.signature, signature));
    await tickTreasuryMoves(ctx);
    expect(await balanceOf(t.db, "drops")).toBe(before + usd(100));
  });

  it("books a deposit into the cashback pool, read for the Cashback wallet", async () => {
    const before = await balanceOf(t.db, "cashback");
    const signature = await record("cashback");
    onChain.set(signature, (party) => (party.kind === "role" && party.role === "cashback" ? { status: "ok", amount: usd(20) } : { status: "ok", amount: 0 }));
    await tickTreasuryMoves(ctx);
    expect(await balanceOf(t.db, "cashback")).toBe(before + usd(20));
  });

  it("books a sweep out of the Pulse pool", async () => {
    const funded = await record("drops");
    onChain.set(funded, { status: "ok", amount: usd(300) });
    await tickTreasuryMoves(ctx);
    const before = await balanceOf(t.db, "drops");
    const swept = await record("drops");
    onChain.set(swept, { status: "ok", amount: -usd(120) });
    await tickTreasuryMoves(ctx);
    expect(await balanceOf(t.db, "drops")).toBe(before - usd(120));
    expect(await moveOf(swept)).toMatchObject({ state: "BOOKED", amount: -usd(120) });
  });

  it("refuses a sweep bigger than the pool, which would take the gift pool or buyback money", async () => {
    await t.db.transaction((tx) => post(tx, "test:gifts", "test", [{ account: "world", delta: -usd(500) }, { account: "gifts", delta: usd(500) }]));
    const pool = await balanceOf(t.db, "drops");
    const signature = await record("drops");
    onChain.set(signature, { status: "ok", amount: -(pool + usd(1)) });
    await tickTreasuryMoves(ctx);
    const move = await moveOf(signature);
    expect(move.state).toBe("REFUSED");
    expect(move.reason).toMatch(/more than the .* Pulse pool holds/);
    expect(await balanceOf(t.db, "drops")).toBe(pool);
  });

  it("refuses Tenner's own transactions, failed ones, and ones that moved nothing", async () => {
    const own = sig();
    await t.db.insert(chainTx).values({ purpose: "settle", ref: "x", signature: own, raw: "x", status: "confirmed" });
    onChain.set(own, { status: "ok", amount: usd(50) });
    const failed = sig();
    onChain.set(failed, { status: "failed" });
    const nothing = sig();
    onChain.set(nothing, { status: "ok", amount: 0 });
    for (const s of [own, failed, nothing]) await record("drops", s);
    const before = await balanceOf(t.db, "drops");
    await tickTreasuryMoves(ctx);
    expect((await moveOf(own)).reason).toMatch(/Tenner's own/);
    expect((await moveOf(failed)).reason).toMatch(/failed on chain/);
    expect((await moveOf(nothing)).reason).toMatch(/no USDC/);
    expect(await balanceOf(t.db, "drops")).toBe(before);
  });

  it("waits for a transaction the chain doesn't have yet, and gives up after an hour", async () => {
    const fresh = await record("drops");
    await tickTreasuryMoves(ctx);
    expect((await moveOf(fresh)).state).toBe("PENDING");
    const stale = await record("drops", sig(), new Date(Date.now() - 2 * 3_600_000));
    await tickTreasuryMoves(ctx);
    expect((await moveOf(stale)).state).toBe("REFUSED");
    expect((await moveOf(fresh)).state).toBe("PENDING");
  });

  it("keeps reading the others when one transaction can't be read", async () => {
    const broken = await record("drops");
    onChain.set(broken, () => {
      throw new Error("RPC down");
    });
    const good = await record("drops");
    onChain.set(good, { status: "ok", amount: usd(5) });
    await tickTreasuryMoves(ctx);
    expect((await moveOf(broken)).state).toBe("PENDING");
    expect((await moveOf(good)).state).toBe("BOOKED");
  });

  it("books one transfer between the two wallets on both sides", async () => {
    const drops = await balanceOf(t.db, "drops");
    const cashback = await balanceOf(t.db, "cashback");
    const signature = sig();
    // One transaction: $30 out of Drops, into Cashback. It is recorded once for each wallet.
    onChain.set(signature, (party) => ({ status: "ok", amount: (party as { role?: string }).role === "drops" ? -usd(30) : usd(30) }));
    await record("drops", signature);
    await record("cashback", signature);
    await tickTreasuryMoves(ctx);
    await tickTreasuryMoves(ctx);
    expect(await balanceOf(t.db, "drops")).toBe(drops - usd(30));
    expect(await balanceOf(t.db, "cashback")).toBe(cashback + usd(30));
    expect((await t.db.select().from(treasuryMoves).where(eq(treasuryMoves.signature, signature))).map((move) => move.state)).toEqual(["BOOKED", "BOOKED"]);
  });

  it("never counts a hand-made transfer as Pulse spending", async () => {
    // Pool money that came from fees, not a transfer, and one real pack bought with it.
    await t.db.transaction((tx) => post(tx, `seed:test:${sig()}`, "seed", [{ account: "world", delta: -usd(1_000) }, { account: "drops", delta: usd(1_000) }]));
    await t.db.transaction((tx) => post(tx, `pack:test:${sig()}`, "pack", [{ account: "drops", delta: -usd(50) }, { account: "cc", delta: usd(50) }]));
    const spent = async () => (await tickScheduler(ctx)).spent24h;
    // The deposits booked earlier in this file must not hide the pack.
    const before = await spent();
    expect(before).toBeGreaterThanOrEqual(usd(50));
    // A sweep must not trip the daily cap.
    const sweep = await record("drops");
    onChain.set(sweep, { status: "ok", amount: -usd(900) });
    await tickTreasuryMoves(ctx);
    expect((await moveOf(sweep)).state).toBe("BOOKED");
    expect(await spent()).toBe(before);
    // A top-up must not hide what Pulse really spent.
    const topUp = await record("drops");
    onChain.set(topUp, { status: "ok", amount: usd(300) });
    await tickTreasuryMoves(ctx);
    expect(await spent()).toBe(before);
  });

  it("holds off Reconciliation while a recorded transfer waits to be booked", async () => {
    // The books hold deposits this fake chain never saw, so the two differ, as right after funding.
    await setSetting(t.db, "ops", { reconcileHold: false });
    await record("drops");
    await reconcile(ctx, 0);
    await reconcile(ctx, 0);
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(false);
    // With nothing recorded, the same difference holds drops for a person to look at.
    await t.db.delete(treasuryMoves);
    await reconcile(ctx, 0);
    await reconcile(ctx, 0);
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(true);
    await setSetting(t.db, "ops", { reconcileHold: false });
  });
});
