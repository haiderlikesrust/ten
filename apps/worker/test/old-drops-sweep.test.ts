import { usd } from "@gemdex/core";
import { balanceOf, drops, eq, post, treasuryMoves } from "@gemdex/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DROPS_WALLET_ACCOUNTS } from "../src/reconcile";
import { DROPS_WALLET_BOOKS, applySweep, planSweep, usdcSentBy } from "../../../tools/book-old-drops-sweep";
import { createTestDb, type TestDb } from "../../../tools/testdb";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OLD = "Old1Drops1111111111111111111111111111111111";
const SIG = "5".repeat(88);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb(4);
  // What the canary left: half a Pulse sale in the drops pool, half waiting for buyback.
  await t.db.transaction((tx) => post(tx, "seed:pulse", "seed", [{ account: "world", delta: -usd(26.77) }, { account: "drops", delta: usd(13.385) }, { account: "revenue", delta: usd(13.385) }]));
});

afterAll(async () => {
  await t.shutdown();
});

describe("booking a sweep from a previous Drops wallet", () => {
  it("covers every account the Drops wallet holds", () => {
    expect([...DROPS_WALLET_BOOKS].sort()).toEqual(["drops", ...DROPS_WALLET_ACCOUNTS].sort());
  });

  it("reads what left the old wallet from the transfer's token balances", () => {
    const tx = {
      meta: {
        err: null,
        preTokenBalances: [{ owner: OLD, mint: USDC, uiTokenAmount: { amount: "26770000" } }, { owner: "me", mint: USDC, uiTokenAmount: { amount: "0" } }],
        postTokenBalances: [{ owner: OLD, mint: USDC, uiTokenAmount: { amount: "0" } }, { owner: "me", mint: USDC, uiTokenAmount: { amount: "26770000" } }],
      },
    };
    expect(usdcSentBy(tx, OLD, USDC)).toBe(usd(26.77));
    expect(usdcSentBy(tx, "me", USDC)).toBe(-usd(26.77));
    expect(usdcSentBy(tx, OLD, "other-mint")).toBe(0);
  });

  it("waits while a drop is still open", async () => {
    const [open] = await t.db.insert(drops).values({ kind: "revealed", state: "LIVE", machineCode: "pokemon_25", packPrice: usd(25), commonFloor: usd(13) }).returning();
    const plan = await planSweep(t, SIG);
    expect(plan.blockers.join(" ")).toMatch(/still open/);
    await t.db.delete(drops).where(eq(drops.id, open!.id));
  });

  it("refuses a transfer smaller than what the books hold", async () => {
    await expect(applySweep(t, { signature: SIG, from: OLD, moved: usd(20) })).rejects.toThrow(/less than/);
    expect(await balanceOf(t.db, "drops")).toBe(usd(13.385));
  });

  it("books everything out once, and lists it under Treasury transfers", async () => {
    const plan = await planSweep(t, SIG);
    expect(plan.blockers).toEqual([]);
    expect(plan.total).toBe(usd(26.77));

    expect(await applySweep(t, { signature: SIG, from: OLD, moved: usd(26.77) })).toEqual({ total: usd(26.77) });
    for (const account of DROPS_WALLET_BOOKS) expect(await balanceOf(t.db, account)).toBe(0);
    const [move] = await t.db.select().from(treasuryMoves).where(eq(treasuryMoves.signature, SIG));
    expect(move).toMatchObject({ wallet: "drops", state: "BOOKED", amount: -usd(26.77) });

    // A second run changes nothing.
    await expect(applySweep(t, { signature: SIG, from: OLD, moved: usd(26.77) })).rejects.toThrow();
    expect((await planSweep(t, SIG)).blockers.join(" ")).toMatch(/already recorded/);
    expect(await balanceOf(t.db, "world")).toBe(0);
  });
});
