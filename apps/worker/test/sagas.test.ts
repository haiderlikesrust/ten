import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DEFAULT_DROP_SETTINGS, TERMINAL, usd, type DropState } from "@gemdex/core";
import {
  activity, autoFires, autoRules, balanceOf, balances, cashbackAccruals, ccPacks, chainTx, claims, drops, eq, getSetting, holderSnapshots, holdings, holds, inArray, ledgerEntries, machines,
  orders, placeOrder, poolCards, post, setSetting, sql, userAccount, users,
} from "@gemdex/db";
import { CardFrozen, CcRead, createPaperVenue, role, type Fault, type PaperVenue } from "@gemdex/venues";
import { claimDrop } from "../../gateway/src/claim";
import {
  createDrop, ingestListings, publicDrop, reconcile, tickBalances, tickCashback, tickDrops, tickFees, tickOrders, tickScheduler, toEcon, type Ctx,
} from "../src/lib";
import { sendOnce } from "../src/chain-tx";
import { createTestDb, type TestDb } from "../../../tools/testdb";

let t: TestDb;

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function makeCtx(venue: PaperVenue, seed = 7): Ctx {
  return { db: t.db, sql: t.sql, venue, cc: new CcRead(), rng: rng(seed), log: () => {}, announce: async () => {} };
}

async function fund(venue: PaperVenue, account: string, amount: number) {
  await t.db.transaction((tx) => post(tx, `seed:${account}:${randomUUID()}`, "seed", [{ account: "world", delta: -amount }, { account, delta: amount }]));
  await venue.faucet(account, amount);
}

async function makeUser(venue: PaperVenue, amount: number) {
  const id = randomUUID();
  await t.db.insert(users).values({ id, handle: id.slice(0, 6), tradingWallet: `trade${id}`, connectedWallet: `phantom${id}` });
  if (amount > 0) await fund(venue, userAccount(id), amount);
  return id;
}

/** Skips retry waits and runs the worker until a drop stops moving or reaches a state. */
async function drive(ctx: Ctx, dropId: string, until: DropState[], ticks = 80): Promise<typeof drops.$inferSelect> {
  for (let i = 0; i < ticks; i++) {
    await t.db.update(drops).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(drops.id, dropId));
    await tickDrops(ctx);
    const row = (await t.db.select().from(drops).where(eq(drops.id, dropId)))[0]!;
    if (until.includes(row.state as DropState)) return row;
  }
  const row = (await t.db.select().from(drops).where(eq(drops.id, dropId)))[0]!;
  throw new Error(`drop stuck in ${row.state}: ${row.lastError}`);
}

async function revealedDrop(ctx: Ctx) {
  const machine = toEcon((await t.db.select().from(machines).where(eq(machines.code, "pokemon_25")))[0]!);
  return createDrop(ctx, machine, { ...DEFAULT_DROP_SETTINGS, hiddenShare: 0 });
}

async function hiddenDrop(ctx: Ctx) {
  const machine = toEcon((await t.db.select().from(machines).where(eq(machines.code, "pokemon_25")))[0]!);
  return createDrop(ctx, machine, { ...DEFAULT_DROP_SETTINGS, hiddenShare: 1 });
}

const claim = (userId: string, dropId: string) => claimDrop(t.db, { userId, dropId, idempotencyKey: randomUUID() });
const expireNow = (id: string) => t.db.update(drops).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(drops.id, id));

/** The two books must agree, and the ledger must always sum to zero. */
async function assertBooksBalance(venue: PaperVenue) {
  const total = await t.db.select({ sum: sql<string>`coalesce(sum(${ledgerEntries.delta}), 0)` }).from(ledgerEntries);
  expect(Number(total[0]!.sum)).toBe(0);
  const rows = await t.db.select().from(balances);
  const gaps: string[] = [];
  for (const row of rows) {
    if (row.account === "cc" || row.account === "world") continue;
    const chain = await venue.chainBalance(row.account);
    if (chain !== row.micros) gaps.push(`${row.account}: book ${row.micros} chain ${chain}`);
  }
  expect(gaps).toEqual([]);
}

beforeAll(async () => {
  t = await createTestDb(40);
  const tiers = { common: { start: 13, end: 30 }, uncommon: { start: 30, end: 55 }, rare: { start: 55, end: 125 }, epic: { start: 125, end: 500 } };
  await t.db.insert(machines).values({
    code: "pokemon_25", name: "Starter", price: usd(25), buybackPct: 85, ev: usd(27.49), odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 },
    tiers, stock: { common: 500, uncommon: 100, rare: 50, epic: 10 },
  });
  const pool = Array.from({ length: 400 }, (_, i) => {
    const rarity = (["common", "uncommon", "rare", "epic"] as const)[i % 4]!;
    return { nft: `card${i}`, machineCode: "pokemon_25", rarity, name: `Test card ${i}`, insuredValue: usd({ common: 20, uncommon: 40, rare: 90, epic: 300 }[rarity]) };
  });
  await t.db.insert(poolCards).values(pool);
});

afterAll(async () => {
  await t.shutdown();
});

beforeEach(async () => {
  await setSetting(t.db, "ops", { killSwitch: false, reconcileHold: false });
  await t.db.update(poolCards).set({ usedAt: null });
  await t.db.update(drops).set({ state: "VOID" }).where(sql`${drops.state} not in ('SETTLED','DELIVERED','BOUGHT_BACK','SKIPPED','ABANDONED','REFUNDED','VOID')`);
  // Some tests move money behind the book on purpose. Each test starts with the two in step.
  await t.sql`delete from paper_chain where account not like 'token:%' and account <> 'fee_cards'`;
  await t.sql`insert into paper_chain (account, micros) select account, micros from balances where account not in ('cc', 'world')`;
  await t.sql`update holds set status = 'released' where status = 'active'`;
  await t.sql`update claims set state = 'voided' where state = 'won'`;
  await t.sql`delete from app_settings where key = 'reconcileLast'`;
  await t.sql`update chain_tx set status = 'dead' where status in ('signed', 'sent')`;
});

describe("revealed drops", () => {
  it("sells a card to the connected wallet and books every dollar", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(1000));
    const startDrops = await balanceOf(t.db, "drops");
    const userId = await makeUser(venue, usd(100));

    const planned = await revealedDrop(ctx);
    const live = await drive(ctx, planned.id, ["LIVE"]);
    expect(live.price).toBeGreaterThanOrEqual(usd(5));
    expect(live.price).toBeLessThanOrEqual(usd(100));
    expect(live.path).toHaveLength(DEFAULT_DROP_SETTINGS.ttlSec);

    expect(await claim(userId, live.id)).toMatchObject({ status: "won" });
    const done = await drive(ctx, live.id, ["SETTLED"]);
    expect(done.boughtBy).toBe(`phantom${userId}`);
    expect(done.stoppedAt).not.toBeNull();

    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(100) - done.price!);
    expect(await balanceOf(t.db, "drops")).toBe(startDrops - usd(25) + done.price!);

    const held = (await t.db.select().from(holdings).where(eq(holdings.userId, userId)))[0]!;
    expect(held.wallet).toBe("connected");
    expect(held.cost).toBe(done.price);
    expect(held.nft).toBe(done.nft);
    expect(held.buybackUntil).not.toBeNull();

    const claimRow = (await t.db.select().from(claims).where(eq(claims.id, done.winnerClaimId!)))[0]!;
    expect(claimRow.state).toBe("settled");
    expect(claimRow.deliverTo).toBe(`phantom${userId}`);
    expect((await t.db.select().from(holds).where(eq(holds.id, claimRow.holdId)))[0]!.status).toBe("captured");
    await assertBooksBalance(venue);
  });

  it("sells unsold cards back to recover the treasury", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(1000));
    const before = await balanceOf(t.db, "drops");

    const first = await drive(ctx, (await revealedDrop(ctx)).id, ["LIVE"]);
    await expireNow(first.id);
    await tickDrops(ctx);
    const gone = await drive(ctx, first.id, ["BOUGHT_BACK"]);
    expect(gone.soldBackFor).toBe(Math.floor((gone.insuredValue! * 85) / 100));
    expect(await balanceOf(t.db, "drops")).toBe(before - usd(25) + gone.soldBackFor!);
    await assertBooksBalance(venue);
  });

  it("a user who drained their exported key is voided, struck, and the drop goes back on sale", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(1000));
    const cheat = await makeUser(venue, usd(100));
    const honest = await makeUser(venue, usd(100));
    const live = await drive(ctx, (await revealedDrop(ctx)).id, ["LIVE"]);

    expect(await claim(cheat, live.id)).toMatchObject({ status: "won" });
    await venue.drain(userAccount(cheat), usd(100));
    const reopened = await drive(ctx, live.id, ["LIVE"]);
    expect(reopened.winnerClaimId).toBeNull();
    expect(reopened.boughtBy).toBeNull();
    expect(reopened.stoppedAt).toBeNull();

    const cheatRow = (await t.db.select().from(users).where(eq(users.id, cheat)))[0]!;
    expect(cheatRow.strikes).toBe(1);
    const heldRows = await t.db.select().from(holds).where(eq(holds.userId, cheat));
    expect(heldRows.every((h) => h.status === "released")).toBe(true);

    expect(await claim(honest, live.id)).toMatchObject({ status: "won" });
    await drive(ctx, live.id, ["SETTLED"]);
    expect((await t.db.select().from(holdings).where(eq(holdings.userId, honest)))).toHaveLength(1);
    expect((await t.db.select().from(holdings).where(eq(holdings.userId, cheat)))).toHaveLength(0);
  });

  it("a card frozen by CC releases the winner instead of hanging forever", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(1000));
    const userId = await makeUser(venue, usd(100));
    const live = await drive(ctx, (await revealedDrop(ctx)).id, ["LIVE"]);
    await claim(userId, live.id);

    const frozen = Object.create(venue.chain);
    frozen.prepare = async () => {
      throw new CardFrozen("card is frozen");
    };
    await drive({ ...ctx, venue: { ...venue, chain: frozen } }, live.id, ["EXPIRED", "BOUGHT_BACK"]);

    expect((await t.db.select().from(holds).where(eq(holds.userId, userId)))[0]!.status).toBe("released");
    expect((await t.db.select().from(users).where(eq(users.id, userId)))[0]!.strikes).toBe(0);
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(100));
    // It must not go back on sale, because nobody could ever receive it.
    expect((await drive(ctx, live.id, ["BOUGHT_BACK"])).state).toBe("BOUGHT_BACK");
  });

  it("never settles twice when every send result is lost", async () => {
    const venue = createPaperVenue(t.db, { faults: { send_ambiguous: 1 }, rng: rng(9) });
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(1000));
    const userId = await makeUser(venue, usd(100));
    const live = await drive(ctx, (await revealedDrop(ctx)).id, ["LIVE"]);
    await claim(userId, live.id);
    const done = await drive(ctx, live.id, ["SETTLED"]);
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(100) - done.price!);
    await assertBooksBalance(venue);
  });

  it("re-signs only after the old transaction is proven dead", async () => {
    const venue = createPaperVenue(t.db, { faults: { send_lost: 1 }, rng: rng(5), txTtlMs: 40 });
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(100));
    const created = await revealedDrop(ctx);
    await tickDrops(ctx);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await t.db.update(drops).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(drops.id, created.id));
    await tickDrops(ctx);
    const row = (await t.db.select().from(drops).where(eq(drops.id, created.id)))[0]!;
    const attempts = await t.db.select().from(chainTx).where(eq(chainTx.ref, row.memo!));
    expect(attempts.map((a) => a.attempt).sort()).toEqual([1, 2]);
    expect(attempts.find((a) => a.attempt === 1)!.status).toBe("dead");
    expect(await balanceOf(t.db, "drops")).toBe(await venue.chainBalance("drops"));
  });
});

describe("hidden drops", () => {
  it("keeps the card secret, delivers straight to the winner, and leaks nothing before", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(1000));
    const userId = await makeUser(venue, usd(100));
    const drop = await hiddenDrop(ctx);

    expect(drop.state).toBe("LIVE");
    expect(drop.nft).toBeNull();
    expect(drop.memo).toBeNull();
    expect(drop.price!).toBeLessThan(usd(13));
    expect(await t.db.select().from(ccPacks).where(eq(ccPacks.dropId, drop.id))).toHaveLength(0);
    expect(publicDrop(drop).card).toBeNull();

    await claim(userId, drop.id);
    const claimed = await drive(ctx, drop.id, ["OPENING", "DELIVERED"]);
    expect(publicDrop({ ...claimed, nft: "x", card: { name: "secret" } }).card).toBeNull();

    const done = await drive(ctx, drop.id, ["DELIVERED"]);
    expect(publicDrop(done).card).not.toBeNull();
    const pack = (await t.db.select().from(ccPacks).where(eq(ccPacks.dropId, drop.id)))[0]!;
    expect(pack.deliverTo).toBe(`phantom${userId}`);
    const claimRow = (await t.db.select().from(claims).where(eq(claims.dropId, drop.id)))[0]!;
    expect(claimRow.price).toBeLessThan(usd(13));
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(100) - claimRow.price);
    await assertBooksBalance(venue);
  });

  it("costs nothing when it goes unsold", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(1000));
    const before = await balanceOf(t.db, "drops");
    const drop = await hiddenDrop(ctx);
    await expireNow(drop.id);
    await tickDrops(ctx);
    expect((await t.db.select().from(drops).where(eq(drops.id, drop.id)))[0]!.state).toBe("EXPIRED");
    expect(await balanceOf(t.db, "drops")).toBe(before);
  });

  it("voids without touching user money when the machine is down", async () => {
    const venue = createPaperVenue(t.db, { faults: { machine_down: 1 }, rng: rng(3) });
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(100));
    const userId = await makeUser(venue, usd(50));
    const drop = await hiddenDrop(ctx);
    await claim(userId, drop.id);
    const done = await drive(ctx, drop.id, ["VOID"]);
    expect(done.state).toBe("VOID");
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(50));
    expect((await t.db.select().from(users).where(eq(users.id, userId)))[0]!.strikes).toBe(0);
    expect((await t.db.select().from(holds).where(eq(holds.userId, userId))).every((h) => h.status === "released")).toBe(true);
  });

  it("refunds the winner in full if the pack can never be paid", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(1000));
    const userId = await makeUser(venue, usd(100));
    const drop = await hiddenDrop(ctx);
    await claim(userId, drop.id);
    await drive(ctx, drop.id, ["PACK_PAYING"]);
    const paid = (await t.db.select().from(claims).where(eq(claims.dropId, drop.id)))[0]!.price;
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(100) - paid);

    // Every payment to CC now fails, so each freshly reserved pack burns in turn.
    const failing = createPaperVenue(t.db, { faults: { send_failed: 1 }, rng: rng(8) });
    const failed = await drive(makeCtx(failing), drop.id, ["REFUND_DUE"]);
    expect(failed.packPayAttempts).toBe(3);
    const packs = await t.db.select().from(ccPacks).where(eq(ccPacks.dropId, drop.id));
    expect(packs).toHaveLength(3);
    expect(packs.every((p) => p.state === "reserved")).toBe(true);

    const done = await drive(ctx, drop.id, ["REFUNDED"]);
    expect(done.state).toBe("REFUNDED");
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(100));
    const refunded = (await t.db.select().from(claims).where(eq(claims.dropId, drop.id)))[0]!;
    expect(refunded.state).toBe("refunded");
    await assertBooksBalance(venue);
  });

  it("waits for CC's refund on a dead pack, so a late open cannot pay twice", async () => {
    const venue = createPaperVenue(t.db, { faults: { open_dead: 1 }, rng: rng(4) });
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(1000));
    const userId = await makeUser(venue, usd(100));
    const drop = await hiddenDrop(ctx);
    await claim(userId, drop.id);
    const done = await drive(ctx, drop.id, ["REFUNDED"]);
    expect(done.state).toBe("REFUNDED");
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(100));
    expect(await t.db.select().from(holdings).where(eq(holdings.userId, userId))).toHaveLength(0);
    await assertBooksBalance(venue);
  });

  it("a reopened hidden drop delivers to the new winner, not the old one", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(1000));
    const first = await makeUser(venue, usd(50));
    const second = await makeUser(venue, usd(50));
    const drop = await hiddenDrop(ctx);
    await claim(first, drop.id);
    await drive(ctx, drop.id, ["QUOTED"]);
    await venue.drain(userAccount(first), usd(50));

    const reopened = await drive(ctx, drop.id, ["LIVE"]);
    expect(reopened.memo).toBeNull();
    expect(reopened.winnerClaimId).toBeNull();
    await claim(second, drop.id);
    await drive(ctx, drop.id, ["DELIVERED"]);
    const packs = await t.db.select().from(ccPacks).where(eq(ccPacks.dropId, drop.id));
    const paid = packs.filter((p) => p.state === "opened");
    expect(paid).toHaveLength(1);
    expect(paid[0]!.deliverTo).toBe(`phantom${second}`);
  });
});

describe("failed sends", () => {
  const pay = (ref: string) => async () => ({ type: "usdc" as const, from: role("drops"), to: role("cashback"), amount: usd(1), memo: `tenner:test:${ref}` });

  it("go out again when the work has to finish, and stay failed when it does not", async () => {
    const broken = createPaperVenue(t.db, { faults: { send_failed: 1 }, rng: rng(1) });
    const healthy = createPaperVenue(t.db, { rng: rng(1) });
    await fund(healthy, "drops", usd(10));

    const retried = randomUUID();
    expect((await sendOnce(makeCtx(broken), "test", retried, pay(retried), { retryFailed: true })).status).toBe("failed");
    expect((await sendOnce(makeCtx(healthy), "test", retried, pay(retried), { retryFailed: true })).status).toBe("confirmed");

    const final = randomUUID();
    expect((await sendOnce(makeCtx(broken), "test", final, pay(final))).status).toBe("failed");
    expect((await sendOnce(makeCtx(healthy), "test", final, pay(final))).status).toBe("failed");
    expect(await t.db.select().from(chainTx).where(eq(chainTx.ref, final))).toHaveLength(1);
  });
});

describe("chaos", () => {
  it("survives random failures across 120 drops with every dollar accounted for", async () => {
    const faults: Partial<Record<Fault, number>> = {
      send_lost: 0.08, send_ambiguous: 0.1, send_failed: 0.08, machine_down: 0.05, open_waiting: 0.15, open_dead: 0.03, simulate_fail: 0.05,
    };
    const venue = createPaperVenue(t.db, { faults, rng: rng(Number(process.env.CHAOS_SEED ?? 1234)), txTtlMs: 30 });
    const ctx = makeCtx(venue, 99);
    await fund(venue, "drops", usd(20_000));
    const players = await Promise.all(Array.from({ length: 24 }, () => makeUser(venue, usd(300))));
    await setSetting(t.db, "drops", { winCooldownSec: 0 });

    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push((i % 3 === 0 ? await hiddenDrop(ctx) : await revealedDrop(ctx)).id);

    const r = rng(77);
    for (let round = 0; round < 500; round++) {
      await t.db.update(drops).set({ nextRunAt: new Date(0) }).where(inArray(drops.id, ids));
      // A restart mid-flight: every lease is forgotten and work resumes from saved state.
      if (round % 25 === 0) await t.db.update(drops).set({ leaseUntil: null }).where(inArray(drops.id, ids));
      await tickDrops(ctx);
      const live = await t.db.select().from(drops).where(sql`${drops.state} = 'LIVE' and ${inArray(drops.id, ids)}`);
      await Promise.all(
        live.slice(0, 10).map((d) => {
          const shooters = [0, 1, 2].map(() => players[Math.floor(r() * players.length)]!);
          return Promise.all(shooters.map((userId) => claim(userId, d.id)));
        }),
      );
      if (round % 40 === 39) for (const d of live) await expireNow(d.id);
      await new Promise((resolve) => setTimeout(resolve, 4));
      const rows = await t.db.select({ state: drops.state }).from(drops).where(inArray(drops.id, ids));
      const open = rows.filter((row) => !TERMINAL.includes(row.state as DropState) && row.state !== "EXPIRED");
      if (open.length === 0 && round > 50) break;
    }

    // Finish anything still moving, with faults off, so the books can be compared at rest.
    const calm = createPaperVenue(t.db, { rng: rng(1) });
    const calmCtx = makeCtx(calm, 5);
    for (let round = 0; round < 150; round++) {
      await t.db.update(drops).set({ nextRunAt: new Date(0), leaseUntil: null }).where(inArray(drops.id, ids));
      await t.db.update(drops).set({ expiresAt: new Date(0) }).where(sql`${drops.state} = 'LIVE' and ${inArray(drops.id, ids)}`);
      await tickDrops(calmCtx);
      const rows = await t.db.select({ state: drops.state, kind: drops.kind }).from(drops).where(inArray(drops.id, ids));
      // Only a hidden EXPIRED is finished. A revealed one still has its sell-back to complete.
      if (rows.every((row) => TERMINAL.includes(row.state as DropState) || (row.kind === "hidden" && row.state === "EXPIRED"))) break;
    }

    const final = await t.db.select().from(drops).where(inArray(drops.id, ids));
    const stuck = final.filter((d) => !TERMINAL.includes(d.state as DropState) && !(d.kind === "hidden" && d.state === "EXPIRED"));
    expect(stuck.map((d) => `${d.kind}:${d.state}:${d.lastError}`)).toEqual([]);

    const wins = final.filter((d) => d.state === "SETTLED" || d.state === "DELIVERED");
    expect(wins.length).toBeGreaterThan(10);
    const settledClaims = await t.db.select().from(claims).where(eq(claims.state, "settled"));
    const perDrop = new Map<string, number>();
    for (const c of settledClaims) perDrop.set(c.dropId, (perDrop.get(c.dropId) ?? 0) + 1);
    expect([...perDrop.values()].every((n) => n === 1)).toBe(true);

    // No user can be left with money stuck on hold or a phantom card.
    const stuckHolds = await t.db.select().from(holds).where(eq(holds.status, "active"));
    expect(stuckHolds).toEqual([]);
    for (const d of wins) {
      const rows = await t.db.select().from(claims).where(eq(claims.id, d.winnerClaimId!));
      expect(rows[0]?.state).toBe("settled");
    }
    await assertBooksBalance(venue);
    await setSetting(t.db, "drops", { winCooldownSec: 300 });
  }, 120_000);
});

describe("user orders", () => {
  it("opening a pack delivers to the connected wallet and pays holder cashback", async () => {
    const venue = createPaperVenue(t.db, { rng: rng(11) });
    const ctx = makeCtx(venue);
    await fund(venue, "cashback", usd(500));
    const userId = await makeUser(venue, usd(100));
    const wallet = `holder${userId}`;
    await t.db.update(users).set({ holderWallet: wallet }).where(eq(users.id, userId));
    await t.db.insert(holderSnapshots).values({ wallet, balance: 5_000_000 });

    const placed = await t.db.transaction((tx) =>
      placeOrder(tx, { userId, kind: "gacha_open", params: { machine: "pokemon_25" }, holdAmount: usd(25), idempotencyKey: randomUUID() }),
    );
    expect(placed.ok).toBe(true);
    for (let i = 0; i < 12; i++) {
      await t.db.update(orders).set({ nextRunAt: new Date(0), leaseUntil: null });
      await tickOrders(ctx);
    }
    await tickCashback(ctx);
    const order = (await t.db.select().from(orders).where(eq(orders.userId, userId)))[0]!;
    expect(order.state).toBe("done");
    const held = (await t.db.select().from(holdings).where(eq(holdings.userId, userId)))[0]!;
    expect(held.wallet).toBe("connected");

    // Machine cap: recycle cost 6.5%, minus 1% safety, limited to the 3% maximum.
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(100) - usd(25) + usd(0.75));
    await assertBooksBalance(venue);
  });

  it("gives nothing to a wallet that flash-bought the token", async () => {
    const venue = createPaperVenue(t.db, { rng: rng(12) });
    const ctx = makeCtx(venue);
    await fund(venue, "cashback", usd(500));
    const userId = await makeUser(venue, usd(100));
    const wallet = `flash${userId}`;
    await t.db.update(users).set({ holderWallet: wallet }).where(eq(users.id, userId));
    await t.db.insert(holderSnapshots).values([{ wallet, balance: 0 }, { wallet, balance: 9_000_000 }]);
    await t.db.transaction((tx) => placeOrder(tx, { userId, kind: "gacha_open", params: { machine: "pokemon_25" }, holdAmount: usd(25), idempotencyKey: randomUUID() }));
    for (let i = 0; i < 12; i++) {
      await t.db.update(orders).set({ nextRunAt: new Date(0), leaseUntil: null });
      await tickOrders(ctx);
    }
    await tickCashback(ctx);
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(75));
  });

  it("a user cannot sell a card that belongs to someone else", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    const alice = await makeUser(venue, usd(50));
    const mallory = await makeUser(venue, usd(50));
    const held = await t.db.insert(holdings).values({ userId: alice, nft: "stolen", wallet: "connected", card: {}, source: "gacha", cost: usd(25) }).returning();
    await t.db.transaction((tx) => placeOrder(tx, { userId: mallory, kind: "buyback", params: { holdingId: held[0]!.id }, holdAmount: 0, idempotencyKey: randomUUID() }));
    await tickOrders(ctx);
    const order = (await t.db.select().from(orders).where(eq(orders.userId, mallory)))[0]!;
    expect(order.state).toBe("failed");
    expect((await t.db.select().from(holdings).where(eq(holdings.id, held[0]!.id)))[0]!.status).toBe("held");
    expect(await balanceOf(t.db, userAccount(mallory))).toBe(usd(50));
  });

  it("two parallel orders cannot spend the same money, and a retry is one order", async () => {
    const venue = createPaperVenue(t.db);
    const userId = await makeUser(venue, usd(30));
    const key = randomUUID();
    const place = (idempotencyKey: string) =>
      t.db.transaction((tx) => placeOrder(tx, { userId, kind: "gacha_open", params: { machine: "pokemon_25" }, holdAmount: usd(25), idempotencyKey }));
    const [a, b, c] = await Promise.all([place(key), place(key), place(randomUUID())]);
    const results = [a, b, c];
    expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
    expect(await t.db.select().from(orders).where(eq(orders.userId, userId))).toHaveLength(1);
  });
});

describe("auto-buy", () => {
  const listing = (n: number, price: number) => ({ nftAddress: `auto${n}`, itemName: `2020 Charizard ${n}`, category: "Pokemon", gradingCompany: "PSA", grade: "GEM-MT 10", insuredValue: "100", listing: { price, marketplace: "CC", createdAt: new Date().toISOString() } });

  it("buys a matching listing once, and stops at the daily budget", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    const userId = await makeUser(venue, usd(500));
    await t.db.insert(autoRules).values({ userId, name: "cheap zards", maxPrice: usd(60), minDiscountPct: 30, search: "charizard", dailyBudget: usd(100), grader: "PSA", minGrade: 9 });
    const cc = { marketplace: async () => ({ filterNFtCard: [listing(1, 50), listing(2, 90), listing(3, 55), listing(4, 58)], nextCursor: null }) };
    const feedCtx = { ...ctx, cc: cc as never };

    await ingestListings(feedCtx);
    await ingestListings(feedCtx);
    for (let i = 0; i < 6; i++) {
      await t.db.update(orders).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(orders.userId, userId));
      await tickOrders(ctx);
    }
    const bought = await t.db.select().from(holdings).where(eq(holdings.userId, userId));
    expect(bought).toHaveLength(1);
    expect(bought[0]!.nft).toBe("auto1");
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(450));

    // A later listing still fits the budget, and the one after it would break it.
    const later = { marketplace: async () => ({ filterNFtCard: [listing(5, 45)], nextCursor: null }) };
    await ingestListings({ ...ctx, cc: later as never });
    const beyond = { marketplace: async () => ({ filterNFtCard: [listing(6, 45)], nextCursor: null }) };
    await ingestListings({ ...ctx, cc: beyond as never });
    const fires = await t.db.select().from(autoFires);
    expect(fires.map((f) => f.nft).sort()).toEqual(["auto1", "auto5"]);
  });
});

describe("deposit sync", () => {
  const realLike = (venue: PaperVenue, ctx: Ctx): Ctx => ({ ...ctx, venue: { ...venue, mode: "devnet" } as never });

  it("books deposits and withdrawals that happen on-chain", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = realLike(venue, makeCtx(venue));
    const userId = await makeUser(venue, usd(10));
    await venue.faucet(userAccount(userId), usd(40));
    await tickBalances(ctx);
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(50));
    await venue.drain(userAccount(userId), usd(20));
    await tickBalances(ctx);
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(30));
    await tickBalances(ctx);
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(30));
  });

  it("never touches a wallet with money in flight, so nothing is counted twice", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = realLike(venue, makeCtx(venue));
    await fund(venue, "cashback", usd(100));
    const userId = await makeUser(venue, usd(10));
    await t.db.insert(cashbackAccruals).values({ userId, memo: `m${userId}`, machineCode: "pokemon_25", packPrice: usd(25), rateBps: 300, amount: usd(0.75) });

    // Cashback has landed on-chain but is not booked yet. Syncing now would double it.
    await venue.faucet(userAccount(userId), usd(0.75));
    await tickBalances(ctx);
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(10));
  });
});

describe("fee pipeline", () => {
  it("splits exactly 30/70 and a crash cannot pay it twice", async () => {
    const venue = createPaperVenue(t.db, { cardsPriceUsd: 0.2 });
    const ctx = makeCtx(venue);
    await venue.accrueCards(5000);
    const before = { cashback: await balanceOf(t.db, "cashback"), drops: await balanceOf(t.db, "drops") };
    await tickFees(ctx);
    await tickFees(ctx);
    await tickFees(ctx);
    expect(await balanceOf(t.db, "cashback")).toBe(before.cashback + usd(300));
    expect(await balanceOf(t.db, "drops")).toBe(before.drops + usd(700));
    expect(await venue.fees.cardsBalance()).toBe(0);
    await assertBooksBalance(venue);
  });

  it("resumes after failures without double-counting", async () => {
    const venue = createPaperVenue(t.db, { cardsPriceUsd: 0.2, faults: { send_ambiguous: 0.5, send_lost: 0.3 }, rng: rng(21), txTtlMs: 20 });
    const ctx = makeCtx(venue);
    await venue.accrueCards(1000);
    const before = { cashback: await balanceOf(t.db, "cashback"), drops: await balanceOf(t.db, "drops") };
    for (let i = 0; i < 60; i++) {
      await tickFees(ctx);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await balanceOf(t.db, "cashback")).toBe(before.cashback + usd(60));
    expect(await balanceOf(t.db, "drops")).toBe(before.drops + usd(140));
  });

  it("skips amounts too small to be worth swapping", async () => {
    const venue = createPaperVenue(t.db, { cardsPriceUsd: 0.2 });
    const ctx = makeCtx(venue);
    await venue.accrueCards(10);
    const runs = await t.sql`select count(*)::int as n from fee_runs`;
    await tickFees(ctx);
    const after = await t.sql`select count(*)::int as n from fee_runs`;
    expect(after[0]!.n).toBe(runs[0]!.n);
  });
});

describe("pause and reconcile", () => {
  it("catches money moved behind the book and pauses drops on the second run", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(5000));
    expect((await reconcile(ctx, 0)).ok).toBe(true);

    await venue.drain("drops", usd(7));
    expect((await reconcile(ctx, 0)).ok).toBe(false);
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(false);
    await reconcile(ctx, 0);
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(true);

    const status = await tickScheduler(ctx);
    expect(status.pausedFor).toBe("reconcile_mismatch");
    await venue.faucet("drops", usd(7));
  });

  it("ignores a difference that clears on the second look", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "fee", usd(10));
    // Money arrives on chain, and the book catches up while the check is looking.
    await venue.faucet("fee", usd(148));
    const closing = reconcile(ctx, 40);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await t.db.transaction((tx) => post(tx, `test_fee:${randomUUID()}`, "fee_in", [{ account: "world", delta: -usd(148) }, { account: "fee", delta: usd(148) }]));
    expect((await closing).ok).toBe(true);
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(false);
  });

  it("two separate gaps of the same size never add up to a pause", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "fee", usd(10));
    for (let run = 0; run < 2; run++) {
      await venue.faucet("fee", usd(148));
      const closing = reconcile(ctx, 40);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await t.db.transaction((tx) => post(tx, `test_fee:${randomUUID()}`, "fee_in", [{ account: "world", delta: -usd(148) }, { account: "fee", delta: usd(148) }]));
      await closing;
      await venue.drain("fee", usd(148));
      await t.db.transaction((tx) => post(tx, `test_fee:${randomUUID()}`, "fee_out", [{ account: "fee", delta: -usd(148) }, { account: "world", delta: usd(148) }]));
    }
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(false);
  });

  it("a real difference still pauses, even with the second look on", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(5000));
    await venue.drain("drops", usd(7));
    await reconcile(ctx, 5);
    await reconcile(ctx, 5);
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(true);
    await venue.faucet("drops", usd(7));
  });

  it("paper recovers once the books match, but real money waits for a person", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(5000));
    await setSetting(t.db, "ops", { reconcileHold: true });

    await reconcile({ ...ctx, venue: { ...venue, mode: "devnet" } as unknown as typeof venue }, 0);
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(true);

    await reconcile(ctx, 0);
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(false);
  });

  it("creates no drops under the kill switch, and paces from budget", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await fund(venue, "drops", usd(5000));
    await setSetting(t.db, "drops", { machineMix: [{ code: "pokemon_25", weight: 1 }] });
    await setSetting(t.db, "ops", { killSwitch: true });
    const before = await t.sql`select count(*)::int as n from drops`;
    expect((await tickScheduler(ctx)).pausedFor).toBe("kill_switch");
    expect((await t.sql`select count(*)::int as n from drops`)[0]!.n).toBe(before[0]!.n);

    await setSetting(t.db, "ops", { killSwitch: false });
    await t.sql`delete from app_settings where key = 'dropsStatus'`;
    const status = await tickScheduler(ctx);
    expect(status.pausedFor).toBeNull();
    expect(status.intervalSec).toBeGreaterThanOrEqual(30);
    expect((await t.sql`select count(*)::int as n from drops`)[0]!.n).toBe(before[0]!.n + 1);
    await setSetting(t.db, "drops", { machineMix: DEFAULT_DROP_SETTINGS.machineMix });
  });
});

void activity;
