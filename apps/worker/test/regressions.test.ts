// Bugs found in the mainnet review of 2026-11-11, each kept here as the test that would have caught it.
// The paper chain settles at once and never fails to read, so a few of these wrap it to behave like Solana:
// a transaction is "pending" the first time it is looked at, and a just-confirmed one can't be read straight away.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CASHBACK_SETTINGS, DEFAULT_DROP_SETTINGS, usd, type DropState } from "@gemdex/core";
import {
  activity, and, balanceOf, buybacks, cashbackAccruals, ccPacks, chainTx, claimDrop, claims, drops, eq, feeRuns, getSetting, holderSnapshots, holdings, holds, machines,
  orders, placeOrder, poolCards, post, setSetting, sql, userAccount, users,
} from "@gemdex/db";
import { CcRead, createPaperVenue, type PaperVenue } from "@gemdex/venues";
import { tickBuyback } from "../src/buyback";
import { createDrop, reconcile, tickCashback, tickDrops, tickFees, tickOrders, tickScheduler, toEcon, type Ctx } from "../src/lib";
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

/** Book accounts whose money sits in the Drops wallet next to the Pulse pool. */
const SHARED = ["gifts", "gift_reserved", "revenue", "buyback_inflight"];

async function fund(venue: PaperVenue, account: string, amount: number) {
  await t.db.transaction((tx) => post(tx, `seed:${account}:${randomUUID()}`, "seed", [{ account: "world", delta: -amount }, { account, delta: amount }]));
  await venue.faucet(SHARED.includes(account) ? "drops" : account, amount);
}
/** Sets a book account, and its wallet, to exactly this much. */
async function setPool(venue: PaperVenue, account: string, target: number) {
  const diff = target - (await balanceOf(t.db, account));
  if (diff === 0) return;
  await t.db.transaction((tx) => post(tx, `adj:${account}:${randomUUID()}`, "seed", [{ account: "world", delta: -diff }, { account, delta: diff }]));
  await venue.faucet(SHARED.includes(account) ? "drops" : account, diff);
}
async function makeUser(venue: PaperVenue, amount: number) {
  const id = randomUUID();
  await t.db.insert(users).values({ id, handle: id.slice(0, 6), tradingWallet: `trade${id}`, connectedWallet: `phantom${id}` });
  if (amount > 0) await fund(venue, userAccount(id), amount);
  return id;
}
/** A holder, so their packs earn cashback. */
async function makeHolder(venue: PaperVenue, amount: number) {
  const id = await makeUser(venue, amount);
  const wallet = `holder${id}`;
  await t.db.update(users).set({ holderWallet: wallet }).where(eq(users.id, id));
  await t.db.insert(holderSnapshots).values({ wallet, balance: 5_000_000 });
  return id;
}
async function tickOne(ctx: Ctx, dropId: string) {
  await t.db.update(drops).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(drops.id, dropId));
  await tickDrops(ctx);
  return (await t.db.select().from(drops).where(eq(drops.id, dropId)))[0]!;
}
async function drive(ctx: Ctx, dropId: string, until: DropState[], ticks = 40) {
  let row = (await t.db.select().from(drops).where(eq(drops.id, dropId)))[0]!;
  for (let i = 0; i < ticks && !until.includes(row.state as DropState); i++) row = await tickOne(ctx, dropId);
  return row;
}
async function runOrders(ctx: Ctx, userId: string, ticks: number) {
  for (let i = 0; i < ticks; i++) {
    await t.db.update(orders).set({ nextRunAt: new Date(0), leaseUntil: null }).where(eq(orders.userId, userId));
    await tickOrders(ctx);
  }
}
/** Like Solana: the first look at a transaction that was just sent says "pending". */
function withConfirmLag(venue: PaperVenue): PaperVenue {
  const seen = new Set<string>();
  const chain = Object.assign(Object.create(Object.getPrototypeOf(venue.chain)), venue.chain, {
    status: async (signature: string, raw: string) => {
      if (!seen.has(signature)) {
        seen.add(signature);
        return "pending" as const;
      }
      return venue.chain.status(signature, raw);
    },
  });
  return { ...venue, chain };
}

const machine = async () => toEcon((await t.db.select().from(machines).where(eq(machines.code, "pokemon_25")))[0]!);

beforeAll(async () => {
  t = await createTestDb(40);
  const tiers = { common: { start: 13, end: 30 }, uncommon: { start: 30, end: 55 }, rare: { start: 55, end: 125 }, epic: { start: 125, end: 500 } };
  await t.db.insert(machines).values({
    code: "pokemon_25", name: "Starter", price: usd(25), buybackPct: 85, ev: usd(27.49), odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 },
    tiers, stock: { common: 500, uncommon: 100, rare: 50, epic: 10 },
  });
  await t.db.insert(poolCards).values(Array.from({ length: 400 }, (_, i) => {
    const rarity = (["common", "uncommon", "rare", "epic"] as const)[i % 4]!;
    return { nft: `card${i}`, machineCode: "pokemon_25", rarity, name: `Test card ${i}`, insuredValue: usd({ common: 20, uncommon: 40, rare: 90, epic: 300 }[rarity]) };
  }));
});
afterAll(async () => {
  await t.shutdown();
});
// Every test starts from books that match the chain, with nothing half done.
beforeEach(async () => {
  await setSetting(t.db, "ops", { killSwitch: false, reconcileHold: false, armedBy: [], armedUntil: null });
  await setSetting(t.db, "drops", { ladder: DEFAULT_DROP_SETTINGS.ladder, walletFloor: 0, dailySpendCap: usd(1_000_000), hiddenShare: DEFAULT_DROP_SETTINGS.hiddenShare });
  await t.db.update(drops).set({ state: "VOID" }).where(sql`${drops.state} not in ('SETTLED','DELIVERED','BOUGHT_BACK','SKIPPED','ABANDONED','REFUNDED','VOID')`);
  await t.sql`delete from paper_chain where account not like 'token:%' and account <> 'fee_cards'`;
  await t.sql`insert into paper_chain (account, micros)
    select case when account in ('gifts', 'gift_reserved', 'revenue', 'buyback_inflight') then 'drops' else account end, sum(micros)
    from balances where account not in ('cc', 'world') group by 1`;
  await t.sql`update holds set status = 'released' where status = 'active'`;
  await t.sql`update claims set state = 'voided' where state = 'won'`;
  await t.sql`delete from app_settings where key in ('reconcileLast', 'dropsStatus')`;
  await t.sql`update chain_tx set status = 'dead' where status in ('signed', 'sent')`;
  await t.sql`update cashback_accruals set status = 'skipped' where status = 'accrued'`;
  await t.sql`update fee_runs set stage = 'DONE' where stage in ('PENDING', 'COLLECTED', 'SWAPPED')`;
});

describe("the Pulse pool is never spent twice", () => {
  it("does not pay for a pack the pool's own book can't cover, even with gift money in the same wallet", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await setPool(venue, "drops", usd(10));
    await setPool(venue, "gifts", usd(500));
    const chainBefore = await venue.chainBalance("drops");
    const d = await createDrop(ctx, await machine(), { ...DEFAULT_DROP_SETTINGS, hiddenShare: 0 });
    const row = await drive(ctx, d.id, ["SKIPPED", "OPENING"], 8);
    // It used to pay on chain with the gift pool's dollars, then retry for ever because the book couldn't record it.
    expect(row.state).toBe("SKIPPED");
    expect(row.lastError).toMatch(/can't cover/);
    expect(await t.db.select().from(chainTx).where(eq(chainTx.ref, row.memo!))).toEqual([]);
    expect((await t.db.select().from(ccPacks).where(eq(ccPacks.memo, row.memo!)))[0]!.state).toBe("reserved");
    expect(await venue.chainBalance("drops")).toBe(chainBefore);
    expect(await balanceOf(t.db, "drops")).toBe(usd(10));
  });

  it("keeps back the buyback share of a sealed sale, so the next pack can't be bought with it", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await setSetting(t.db, "drops", { hiddenShare: 0 });
    await setPool(venue, "drops", usd(60));
    await setPool(venue, "revenue", 0);
    const userId = await makeUser(venue, usd(50));
    const sealed = await createDrop(ctx, await machine(), { ...DEFAULT_DROP_SETTINGS, hiddenShare: 1 });
    expect(sealed.kind).toBe("hidden");
    expect((await claimDrop(t.db, { userId, dropId: sealed.id, idempotencyKey: randomUUID() })).status).toBe("won");
    expect((await drive(ctx, sealed.id, ["OPENING"])).state).toBe("OPENING");
    // The pack is paid and the card not yet delivered. The pool holds exactly one more pack's worth, but part of it
    // is owed to buyback when the card is delivered.
    await setPool(venue, "drops", usd(25));
    await t.db.update(drops).set({ nextRunAt: new Date(Date.now() + 3_600_000) }).where(eq(drops.id, sealed.id));
    const status = await tickScheduler(ctx);
    expect(status.pausedFor).toBe("wallet_floor");
    expect(await t.db.select().from(drops).where(and(eq(drops.kind, "revealed"), eq(drops.state, "PLANNED")))).toEqual([]);
    // So the delivery can be booked, and the winner's claim closes.
    const done = await drive(ctx, sealed.id, ["DELIVERED"]);
    expect(done.state).toBe("DELIVERED");
    expect((await t.db.select().from(claims).where(eq(claims.dropId, sealed.id)))[0]!.state).toBe("settled");
  });

  it("leaves out a pack size that costs more than what is left of today's cap", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await setPool(venue, "drops", usd(1_000));
    // $10 of room: the pool could open a $25 pack, but today's cap can't take one.
    const { spent24h } = await tickScheduler(ctx);
    await t.sql`delete from app_settings where key = 'dropsStatus'`;
    await setSetting(t.db, "drops", { dailySpendCap: spent24h + usd(10) });
    const before = (await t.sql`select count(*)::int as n from drops`)[0]!.n as number;
    expect((await tickScheduler(ctx)).pausedFor).toBe("daily_cap");
    expect((await t.sql`select count(*)::int as n from drops`)[0]!.n).toBe(before);
  });
});

describe("mainnet outside an armed window", () => {
  it("drops no new cards", async () => {
    const venue = createPaperVenue(t.db);
    const mainnet = makeCtx({ ...venue, mode: "mainnet" } as never);
    await setPool(venue, "drops", usd(1_000));
    const before = (await t.sql`select count(*)::int as n from drops`)[0]!.n as number;
    expect((await tickScheduler(mainnet)).pausedFor).toBe("not_armed");
    expect((await t.sql`select count(*)::int as n from drops`)[0]!.n).toBe(before);
    await setSetting(t.db, "ops", { armedBy: ["admin"], armedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await tickScheduler(mainnet)).pausedFor).toBeNull();
  });

  it("claims nothing, so no buyer's money is put on hold with nobody able to settle it", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await setPool(venue, "drops", usd(1_000));
    const userId = await makeUser(venue, usd(400));
    const d = await createDrop(ctx, await machine(), { ...DEFAULT_DROP_SETTINGS, hiddenShare: 0 });
    expect((await drive(ctx, d.id, ["LIVE"])).state).toBe("LIVE");
    expect(await claimDrop(t.db, { userId, dropId: d.id, idempotencyKey: randomUUID(), mode: "mainnet" })).toMatchObject({ status: "rejected", reason: "drops_paused" });
    await setSetting(t.db, "ops", { armedBy: ["admin"], armedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await claimDrop(t.db, { userId, dropId: d.id, idempotencyKey: randomUUID(), mode: "mainnet" })).status).toBe("won");
  });
});

describe("a win that can't be paid for", () => {
  it("is released once its time is up: no strike, the hold back, the card on sale again", async () => {
    const base = createPaperVenue(t.db);
    await setPool(base, "drops", usd(1_000));
    const userId = await makeUser(base, usd(400));
    const d = await createDrop(makeCtx(base), await machine(), { ...DEFAULT_DROP_SETTINGS, hiddenShare: 0 });
    expect((await drive(makeCtx(base), d.id, ["LIVE"])).state).toBe("LIVE");
    expect((await claimDrop(t.db, { userId, dropId: d.id, idempotencyKey: randomUUID() })).status).toBe("won");
    // The winner's trading wallet now refuses to sign, every time it is asked.
    const chain = Object.assign(Object.create(Object.getPrototypeOf(base.chain)), base.chain, {
      prepare: async () => {
        throw new Error("the signer refused");
      },
    });
    const ctx = makeCtx({ ...base, chain });
    // Still inside its settle time: it keeps trying.
    expect((await tickOne(ctx, d.id)).state).toBe("CLAIMED");
    await t.db.update(claims).set({ settleBy: new Date(Date.now() - 1_000) }).where(eq(claims.dropId, d.id));
    // It used to stay CLAIMED for ever, the hold active and the card off sale.
    expect((await tickOne(ctx, d.id)).state).toBe("LIVE");
    const claim = (await t.db.select().from(claims).where(eq(claims.dropId, d.id)))[0]!;
    expect(claim.state).toBe("voided");
    expect((await t.db.select().from(holds).where(eq(holds.id, claim.holdId)))[0]!.status).toBe("released");
    expect((await t.db.select().from(users).where(eq(users.id, userId)))[0]!.strikes).toBe(0);
  });
});

describe("the live feed", () => {
  it("says nothing about a card until it is for sale", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    await setPool(venue, "drops", usd(1_000));
    const d = await createDrop(ctx, await machine(), { ...DEFAULT_DROP_SETTINGS, hiddenShare: 0 });
    expect((await drive(ctx, d.id, ["LIVE"])).state).toBe("LIVE");
    const said = await t.sql<{ state: string }[]>`
      select payload->'drop'->>'state' as state from outbox
      where topic = 'drops' and payload->>'type' = 'drop' and payload->'drop'->>'id' = ${d.id} order by seq`;
    // Its pack being bought and opened used to be announced too, with the card and its value, a moment before it could be bought.
    expect(said.map((event) => event.state)).toEqual(["LIVE"]);
  });
});

describe("fees and buyback", () => {
  it("finishes a fee run whose swap has landed, even when the price dips under the minimum afterwards", async () => {
    const base = createPaperVenue(t.db, { cardsPriceUsd: 0.2 });
    let quotes = 0;
    let reads = 0;
    const fees = Object.assign(Object.create(Object.getPrototypeOf(base.fees)), base.fees, {
      // The quote is 4% lower every time after the swap has gone out.
      cardsValue: async (cards: number) => (++quotes <= 2 ? base.fees.cardsValue(cards) : Math.floor((await base.fees.cardsValue(cards)) * 0.96)),
      // The RPC can't show a just-confirmed transaction on the first read.
      usdcReceived: async (signature: string) => {
        if (++reads === 1) throw new Error("transaction is not readable yet");
        return base.fees.usdcReceived(signature);
      },
    });
    const ctx = makeCtx({ ...base, fees });
    await setPool(base, "fee", 0);
    await t.sql`delete from paper_chain where account in ('fee_cards', 'fee_cards_unclaimed')`;
    await base.accrueCards(130); // $26 at $0.20: just over the $25 minimum
    for (let i = 0; i < 4; i++) await tickFees(ctx).catch(() => {});
    const run = (await t.db.select().from(feeRuns).orderBy(sql`${feeRuns.createdAt} desc`).limit(1))[0]!;
    // It used to be marked SKIPPED here, with $26 sitting in the Fee wallet that the books never saw.
    expect(run.stage).toBe("DONE");
    expect(run.usdcOut).toBe(usd(26));
    expect(await balanceOf(t.db, "fee")).toBe(0);
    expect(await base.chainBalance("fee")).toBe(0);
  });

  it("never gives up on a buyback whose swap has confirmed, so the same dollars are not swapped twice", async () => {
    const base = createPaperVenue(t.db);
    let reads = 0;
    const lag = withConfirmLag(base);
    const fees = Object.assign(Object.create(Object.getPrototypeOf(base.fees)), base.fees, {
      tenrReceived: async (signature: string) => {
        if (++reads === 1) throw new Error("transaction is not readable yet");
        return base.fees.tenrReceived(signature);
      },
    });
    const ctx = makeCtx({ ...lag, fees });
    await t.db.delete(buybacks);
    await setPool(base, "drops", usd(1_000));
    await setPool(base, "revenue", usd(100));
    await setPool(base, "buyback_inflight", 0);
    const chainBefore = await base.chainBalance("drops");
    await tickBuyback(ctx).catch(() => {}); // the run starts; its swap is sent and still pending
    await t.sql`update buybacks set created_at = now() - interval '6 hours 1 minute'`;
    for (let i = 0; i < 5; i++) await tickBuyback(ctx).catch(() => {});
    // It used to hand the $100 back to revenue after the swap had spent it, and the next run swapped $100 more.
    expect(chainBefore - (await base.chainBalance("drops"))).toBe(usd(100));
    expect((await t.db.select().from(buybacks)).map((b) => b.stage)).toEqual(["DONE"]);
    expect(await balanceOf(t.db, "revenue")).toBe(0);
  });
});

describe("cashback", () => {
  it("never promises more than the pool holds or the daily cap allows, however many packs open together", async () => {
    const venue = withConfirmLag(createPaperVenue(t.db, { rng: rng(11) }));
    const ctx = makeCtx(venue);
    await setPool(venue, "cashback", usd(2));
    const userId = await makeHolder(venue, usd(1_000));
    for (let i = 0; i < 10; i++) {
      expect((await t.db.transaction((tx) => placeOrder(tx, { userId, kind: "gacha_open", params: { machine: "pokemon_25" }, holdAmount: usd(25), idempotencyKey: `cb:${i}:${randomUUID()}` }))).ok).toBe(true);
    }
    await runOrders(ctx, userId, 20);
    const accruals = await t.db.select().from(cashbackAccruals).where(eq(cashbackAccruals.userId, userId));
    expect(accruals).toHaveLength(10);
    expect(accruals.filter((a) => a.status === "accrued").reduce((sum, a) => sum + a.amount, 0)).toBeLessThanOrEqual(usd(2));
    for (let i = 0; i < 12; i++) await tickCashback(ctx);
    // Nothing is left retrying, and nothing was sent that had to fail.
    expect((await t.db.select().from(cashbackAccruals).where(eq(cashbackAccruals.userId, userId))).some((a) => a.status === "accrued")).toBe(false);
    expect((await t.sql`select count(*)::int as n from chain_tx where purpose = 'cashback' and status = 'failed' and ref in (select id::text from cashback_accruals where user_id = ${userId})`)[0]!.n).toBe(0);
    expect(await balanceOf(t.db, "cashback")).toBeGreaterThanOrEqual(0);

    await setPool(venue, "cashback", usd(500));
    await setSetting(t.db, "cashback", { dailyCapPerUser: usd(1) });
    try {
      const capped = await makeHolder(venue, usd(1_000));
      for (let i = 0; i < 30; i++) await t.db.transaction((tx) => placeOrder(tx, { userId: capped, kind: "gacha_open", params: { machine: "pokemon_25" }, holdAmount: usd(25), idempotencyKey: `cap:${i}:${randomUUID()}` }));
      await runOrders(ctx, capped, 20);
      const today = await t.db.select().from(cashbackAccruals).where(eq(cashbackAccruals.userId, capped));
      // Thirty packs in parallel used to be promised several dollars against a $1 cap.
      expect(today.reduce((sum, a) => sum + a.amount, 0)).toBe(usd(1));
    } finally {
      await setSetting(t.db, "cashback", { dailyCapPerUser: DEFAULT_CASHBACK_SETTINGS.dailyCapPerUser });
    }
  });
});

describe("orders", () => {
  it("records a pull once, however often its last step has to run", async () => {
    const venue = createPaperVenue(t.db, { rng: rng(5) });
    const ctx = makeCtx(venue);
    const userId = await makeHolder(venue, usd(100));
    await t.db.transaction((tx) => placeOrder(tx, { userId, kind: "gacha_open", params: { machine: "pokemon_25" }, holdAmount: usd(25), idempotencyKey: `pull:${randomUUID()}` }));
    await runOrders(ctx, userId, 2); // start -> pay -> open
    expect((await t.db.select().from(orders).where(eq(orders.userId, userId)))[0]!.step).toBe("open");
    // Something fails after the card is saved but before the order is marked done, twice.
    await setSetting(t.db, "cashback", { tiers: 5 as never });
    await runOrders(ctx, userId, 2);
    await setSetting(t.db, "cashback", { tiers: DEFAULT_CASHBACK_SETTINGS.tiers });
    await runOrders(ctx, userId, 1);
    expect((await t.db.select().from(orders).where(eq(orders.userId, userId)))[0]!.state).toBe("done");
    // Each rerun used to add the same card to the portfolio again.
    expect(await t.db.select().from(holdings).where(eq(holdings.userId, userId))).toHaveLength(1);
    expect(await t.db.select().from(activity).where(and(eq(activity.userId, userId), eq(activity.kind, "pull")))).toHaveLength(1);
    expect(await balanceOf(t.db, userAccount(userId))).toBe(usd(75));
  });

  it("only sends a card the user holds in their trading wallet", async () => {
    const venue = createPaperVenue(t.db);
    const ctx = makeCtx(venue);
    const userId = await makeUser(venue, 0);
    await t.db.transaction((tx) => placeOrder(tx, { userId, kind: "send", params: { nft: "someone-elses-card" }, holdAmount: 0, idempotencyKey: `send:${randomUUID()}` }));
    await runOrders(ctx, userId, 1);
    const order = (await t.db.select().from(orders).where(eq(orders.userId, userId)))[0]!;
    // It used to build and send a transfer for any address, with Tenner paying the fee for each failure.
    expect(order.state).toBe("failed");
    expect(order.error).toMatch(/not in your trading wallet/);
    expect(await t.db.select().from(chainTx).where(and(eq(chainTx.purpose, "send"), eq(chainTx.ref, order.id)))).toEqual([]);
  });
});

describe("reconciliation", () => {
  it("is not paused by a wallet holding more than its book, which anyone can cause with a fraction of a cent", async () => {
    const base = createPaperVenue(t.db);
    const ctx = makeCtx({ ...base, mode: "devnet" } as never);
    await setPool(base, "drops", usd(1_000));
    expect((await reconcile(ctx, 0)).ok).toBe(true);
    await base.faucet("fee", 1);
    // Still reported, so an admin can see it. It just no longer stops Pulse.
    expect((await reconcile(ctx, 0)).mismatches).toEqual([{ account: "fee", book: 0, chain: 1 }]);
    await reconcile(ctx, 0);
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(false);
    expect((await tickScheduler(ctx)).pausedFor).not.toBe("reconcile_mismatch");
    // Money missing from a wallet still pauses it.
    await base.drain("drops", usd(7));
    await reconcile(ctx, 0);
    await reconcile(ctx, 0);
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(true);
  });

  it("is not switched off for good by a transaction left behind unfinished", async () => {
    const base = createPaperVenue(t.db);
    const ctx = makeCtx({ ...base, mode: "devnet" } as never);
    await setPool(base, "drops", usd(1_000));
    await t.db.insert(chainTx).values({ purpose: "test", ref: randomUUID(), attempt: 1, signature: `stale${randomUUID()}`, raw: "{}", status: "sent" });
    await base.drain("drops", usd(7));
    // Fresh, it explains a difference: money may be on its way.
    await reconcile(ctx, 0);
    await reconcile(ctx, 0);
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(false);
    // Hours old, it explains nothing.
    await t.sql`update chain_tx set updated_at = now() - interval '2 hours' where purpose = 'test'`;
    await reconcile(ctx, 0);
    expect((await getSetting(t.db, "ops")).reconcileHold).toBe(true);
    await t.sql`update chain_tx set status = 'dead' where purpose = 'test'`;
  });
});
