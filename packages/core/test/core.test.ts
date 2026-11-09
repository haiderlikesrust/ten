import { describe, expect, it } from "vitest";
import {
  DEFAULT_CASHBACK_SETTINGS as CB, DEFAULT_DROP_SETTINGS as S, HIDDEN, REVEALED, TERMINAL,
  assertTransition, canTransition, cashbackAmount, cashbackCapBps, discountPct, expectedBurn,
  floorToCents, formatUsd, hiddenPrice, holderBalance, intervalSeconds, ofBps,
  ladderMix, parseGradeNumber, parseUsd, pauseReason, pickMachine, recycleCost, splitFees,
  tierFor, usd, type MachineEcon,
} from "../src/index";

const p25: MachineEcon = { code: "pokemon_25", price: usd(25), buybackPct: 85, ev: usd(27.49), commonFloor: usd(13), open: true, stock: 100 };
const db50: MachineEcon = { code: "dragonball_50", price: usd(50), buybackPct: 93, ev: usd(51.44), commonFloor: usd(25), open: true, stock: 100 };

/** Small seeded generator so property tests repeat exactly. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe("money", () => {
  it("parses every shape CC sends", () => {
    expect(parseUsd("$258.00")).toBe(usd(258));
    expect(parseUsd("85")).toBe(usd(85));
    expect(parseUsd(39)).toBe(usd(39));
    expect(parseUsd("$1,250.50")).toBe(usd(1250.5));
    expect(parseUsd(null)).toBeNull();
    expect(parseUsd("n/a")).toBeNull();
    expect(parseUsd(-1)).toBeNull();
  });
  it("rounds down and formats", () => {
    expect(floorToCents(12_345_678)).toBe(12_340_000);
    expect(ofBps(usd(100), 300)).toBe(usd(3));
    expect(formatUsd(usd(5))).toBe("$5");
    expect(formatUsd(usd(5.5))).toBe("$5.50");
    expect(formatUsd(usd(-5.5))).toBe("-$5.50");
    expect(formatUsd(usd(1500), { compact: true })).toBe("$1.5K");
    expect(formatUsd(usd(20000), { compact: true })).toBe("$20K");
  });
  it("rejects values that are not safe integers", () => {
    expect(() => usd(Number.MAX_VALUE)).toThrow();
  });
});

describe("hidden price", () => {
  it("is always below the lowest card the machine can give", () => {
    const r = rng(2);
    for (let i = 0; i < 50_000; i++) {
      const floor = usd(Math.floor(r() * 3000) + 1);
      const price = hiddenPrice(floor, r(), S);
      if (price === null) continue;
      expect(price).toBeGreaterThanOrEqual(S.minPrice);
      expect(price).toBeLessThanOrEqual(S.maxPrice);
      expect(price).toBeLessThan(floor);
    }
  });
  it("returns null when no legal price exists", () => {
    expect(hiddenPrice(usd(5), 0.5, S)).toBeNull();
  });
});

describe("budget", () => {
  it("reproduces the modelled cost per drop", () => {
    expect(recycleCost(p25)).toBe(usd(25) - Math.floor((usd(27.49) * 85) / 100));
    const burn = expectedBurn(p25, S);
    // ($6.87 x 49%) + ($23.37 x 51%) comes back on a $25 pack, so about $9.72 is spent.
    expect(burn.revealed).toBeGreaterThan(usd(9.5));
    expect(burn.revealed).toBeLessThan(usd(10));
    expect(burn.hidden).toBeGreaterThan(burn.revealed);
  });
  it("paces drops from budget and respects the floor", () => {
    expect(intervalSeconds(usd(6.64), usd(1000), 30)).toBe(574);
    expect(intervalSeconds(usd(1), usd(100_000), 30)).toBe(30);
    expect(intervalSeconds(usd(5), 0, 30)).toBe(Number.POSITIVE_INFINITY);
  });
  it("pauses for the most serious reason first", () => {
    const base = { enabled: true, killSwitch: false, reconcileHold: false, dropsBalance: usd(500), spent24h: 0, settings: { ...S, walletFloor: usd(100) } };
    expect(pauseReason(base)).toBeNull();
    expect(pauseReason({ ...base, dropsBalance: usd(1) })).toBe("wallet_floor");
    expect(pauseReason({ ...base, spent24h: S.dailySpendCap })).toBe("daily_cap");
    expect(pauseReason({ ...base, reconcileHold: true, dropsBalance: 0 })).toBe("reconcile_mismatch");
    expect(pauseReason({ ...base, killSwitch: true, reconcileHold: true })).toBe("kill_switch");
  });
  it("skips closed or empty machines", () => {
    const closed = { ...p25, open: false };
    const empty = { ...db50, stock: 0 };
    const mix = [{ code: "pokemon_25", weight: 60 }, { code: "dragonball_50", weight: 40 }];
    expect(pickMachine(mix, [closed, empty], 0.5)).toBeNull();
    expect(pickMachine(mix, [closed, db50], 0.99)?.code).toBe("dragonball_50");
  });
});

describe("pack ladder", () => {
  const m = (code: string, price: number): MachineEcon => ({ code, price: usd(price), buybackPct: 90, ev: usd(price * 1.04), commonFloor: usd(price / 2), open: true, stock: 100 });
  const all = [m("pokemon_25", 25), m("pokemon_50", 50), m("onepiece_50", 50), m("dragonball_50", 50), m("pokemon_100", 100), m("pokemon_250", 250), m("onepiece_250", 250), m("pokemon_500", 500)];
  const sizes = (free: number, last: number | null = null) =>
    [...new Set(ladderMix(S.ladder, all, usd(free), last === null ? null : usd(last)).map((x) => all.find((a) => a.code === x.code)!.price / 1e6))];

  it("opens $25 at $25, and adds bigger sizes as the pool grows", () => {
    expect(sizes(24)).toEqual([]);
    expect(sizes(25)).toEqual([25]);
    expect(sizes(1_000)).toEqual([25, 50, 100]);
    expect(sizes(2_000)).toEqual([25, 50, 100, 250]);
    expect(sizes(3_000)).toEqual([25, 50, 100, 250, 500]);
  });
  it("keeps mixing at a big pool: $500 is a small share, and never twice in a row", () => {
    const mix = ladderMix(S.ladder, all, usd(4_000), null);
    const total = mix.reduce((sum, x) => sum + x.weight, 0);
    const share = (code: string) => (mix.find((x) => x.code === code)?.weight ?? 0) / total;
    expect(share("pokemon_500")).toBeCloseTo(0.05);
    expect(share("pokemon_25")).toBeCloseTo(0.4);
    // A size's weight is shared by its machines, so three $50 machines don't triple the $50 share.
    expect(share("pokemon_50") + share("onepiece_50") + share("dragonball_50")).toBeCloseTo(0.25);
    expect(sizes(4_000, 500)).toEqual([25, 50, 100, 250]);
    expect(sizes(4_000, 100)).toEqual([25, 50, 100, 250, 500]);
    // With nothing else open, a big size may repeat rather than stop Pulse.
    const only500 = S.ladder.map((t) => ({ ...t, enabled: t.price === usd(500) }));
    expect(ladderMix(only500, all, usd(4_000), usd(500)).map((x) => x.code)).toEqual(["pokemon_500"]);
  });
  it("leaves out sizes that are off, unaffordable, or have no machine that can sell", () => {
    const off = S.ladder.map((t) => (t.price === usd(25) ? { ...t, enabled: false } : t));
    expect(ladderMix(off, all, usd(25), null)).toEqual([]);
    const closed = all.map((x) => (x.code === "pokemon_100" ? { ...x, open: false } : x));
    expect(ladderMix(S.ladder, closed, usd(1_000), null).some((x) => x.code === "pokemon_100")).toBe(false);
    // A machine listed under the wrong price is never used.
    const wrong = S.ladder.map((t) => (t.price === usd(25) ? { ...t, machines: ["pokemon_50"] } : t));
    expect(ladderMix(wrong, all, usd(100), null)).toEqual([]);
  });
});

describe("cashback", () => {
  it("always stays below the open-and-sell-back loss on every machine", () => {
    for (const m of [p25, db50]) {
      const cap = cashbackCapBps(m, CB);
      const lossBps = (recycleCost(m) * 10_000) / m.price;
      expect(cap).toBeLessThan(lossBps);
      expect(cap).toBeLessThanOrEqual(CB.maxRateBps);
    }
  });
  it("pays nothing when machine value is unknown", () => {
    expect(cashbackCapBps({ ...p25, ev: null }, CB)).toBe(0);
  });
  it("respects tier, machine cap, daily cap and pool", () => {
    const base = { packPrice: usd(100), tierBps: 300, machineCapBps: 200, paidToday: 0, dailyCap: usd(50), poolBalance: usd(500) };
    expect(cashbackAmount(base)).toBe(usd(2));
    expect(cashbackAmount({ ...base, paidToday: usd(49.5) })).toBe(usd(0.5));
    expect(cashbackAmount({ ...base, poolBalance: usd(1) })).toBe(usd(1));
    expect(cashbackAmount({ ...base, paidToday: usd(60) })).toBe(0);
  });
  it("uses the lowest snapshot, so flash buying earns nothing", () => {
    expect(holderBalance([5_000_000, 5_000_000, 0, 5_000_000])).toBe(0);
    expect(tierFor(holderBalance([1_200_000, 1_500_000]), CB.tiers)?.name).toBe("Ace");
    expect(tierFor(10, CB.tiers)).toBeNull();
    expect(holderBalance([])).toBe(0);
  });
});

describe("fee split", () => {
  it("is 30/70 and never loses dust", () => {
    const r = rng(3);
    for (let i = 0; i < 20_000; i++) {
      const received = Math.floor(r() * 1e11);
      const { cashback, drops } = splitFees(received, 3000);
      expect(cashback + drops).toBe(received);
      expect(cashback).toBe(Math.floor((received * 3000) / 10_000));
    }
    expect(splitFees(usd(100), 3000)).toEqual({ cashback: usd(30), gifts: 0, drops: usd(70) });
    expect(splitFees(usd(100), 3000, 2000)).toEqual({ cashback: usd(30), gifts: usd(20), drops: usd(50) });
    // Shares that add past 100% can never pay out more than came in.
    expect(splitFees(usd(100), 9000, 2000)).toEqual({ cashback: usd(90), gifts: usd(10), drops: 0 });
  });
});

describe("state machines", () => {
  it("terminal states have no way out", () => {
    for (const table of [REVEALED, HIDDEN]) {
      for (const state of TERMINAL) expect(table[state]).toBeUndefined();
    }
  });
  it("allows the happy paths", () => {
    const rev = ["PLANNED", "PACK_PAID", "OPENING", "IN_VAULT", "LIVE", "CLAIMED", "SETTLING", "SETTLED"] as const;
    rev.slice(1).forEach((to, i) => expect(canTransition("revealed", rev[i]!, to)).toBe(true));
    const hid = ["LIVE", "CLAIMED", "QUOTED", "DEBITING", "PACK_PAYING", "OPENING", "DELIVERED"] as const;
    hid.slice(1).forEach((to, i) => expect(canTransition("hidden", hid[i]!, to)).toBe(true));
  });
  it("blocks money from skipping steps", () => {
    expect(canTransition("revealed", "LIVE", "SETTLED")).toBe(false);
    expect(canTransition("hidden", "CLAIMED", "OPENING")).toBe(false);
    expect(canTransition("hidden", "REFUND_DUE", "DELIVERED")).toBe(false);
    expect(() => assertTransition("revealed", "SETTLED", "LIVE")).toThrow();
  });
  it("a hidden drop can only reopen before money has moved to CC", () => {
    expect(canTransition("hidden", "DEBITING", "LIVE")).toBe(true);
    expect(canTransition("hidden", "QUOTED", "LIVE")).toBe(true);
    expect(canTransition("hidden", "PACK_PAYING", "LIVE")).toBe(false);
    expect(canTransition("hidden", "OPENING", "LIVE")).toBe(false);
  });
});

describe("misc", () => {
  it("reads grades", () => {
    expect(parseGradeNumber("GEM-MT 10")).toBe(10);
    expect(parseGradeNumber("NM-MT 8.5")).toBe(8.5);
    expect(parseGradeNumber("Authentic")).toBeNull();
    expect(parseGradeNumber("x", 9)).toBe(9);
  });
  it("computes discount", () => {
    expect(discountPct(usd(100), usd(1000))).toBe(90);
    expect(discountPct(usd(1), 0)).toBe(0);
  });
});

describe("$TENR access minimum", () => {
  it("needs the share of supply in basis points", async () => {
    const { accessFrom, shareOfSupply, accessMessage } = await import("../src/flywheel");
    expect(accessFrom(1_000_000, 1_000_000_000, 10)).toMatchObject({ enforced: true, ok: true, needed: 1_000_000 });
    expect(accessFrom(999_999.99, 1_000_000_000, 10).ok).toBe(false);
    // Burns shrink supply, so the same bag clears a higher bar.
    expect(accessFrom(950_000, 950_000_000, 10).ok).toBe(true);
    expect(accessFrom(0, 1_000_000_000, 0)).toMatchObject({ enforced: false, ok: true });
    expect(accessFrom(0, 0, 10)).toMatchObject({ enforced: false, ok: true });
    expect(shareOfSupply(10)).toBe("0.1%");
    expect(shareOfSupply(200)).toBe("2%");
    expect(accessMessage({ bps: 10 })).toBe("Hold 0.1% of $TENR to use Tenner");
  });
});

describe("gift draws", () => {
  it("sizes the prize from the pool and rolls over when even the smallest pack doesn't fit", async () => {
    const { giftPrize } = await import("../src/gifts");
    const tiers = [usd(500), usd(250), usd(100), usd(50)];
    expect(giftPrize(usd(12_000), 833, tiers)).toBe(usd(500));
    expect(giftPrize(usd(3_100), 833, tiers)).toBe(usd(250));
    expect(giftPrize(usd(1_300), 833, tiers)).toBe(usd(100));
    expect(giftPrize(usd(650), 833, tiers)).toBe(usd(50));
    expect(giftPrize(usd(500), 833, tiers)).toBeNull();
    expect(giftPrize(0, 833, tiers)).toBeNull();
  });

  it("takes turns between the three groups, slot by slot", async () => {
    const { giftGroupOrder, giftSlot } = await import("../src/gifts");
    const slot = giftSlot(Date.UTC(2026, 10, 7, 12, 17), 30);
    expect(new Date(slot).toISOString()).toBe("2026-11-07T12:00:00.000Z");
    const first = giftGroupOrder(slot, 30)[0];
    const next = giftGroupOrder(slot + 30 * 60_000, 30)[0];
    const third = giftGroupOrder(slot + 60 * 60_000, 30)[0];
    expect(new Set([first, next, third]).size).toBe(3);
    expect(giftGroupOrder(slot + 90 * 60_000, 30)[0]).toBe(first);
  });

  it("weights holders by days held and blasters by spend", async () => {
    const { holderWeight, blasterWeight } = await import("../src/gifts");
    const now = Date.UTC(2026, 10, 7);
    expect(holderWeight(now - 3_600_000, now)).toBe(1);
    expect(holderWeight(now - 3 * 86_400_000 - 1, now)).toBe(4);
    expect(blasterWeight(usd(4))).toBe(1);
    expect(blasterWeight(usd(255))).toBe(25);
  });

  it("picks the same winner from the same entries and seed, whatever order they come in", async () => {
    const { pickGiftWinner, giftEntriesText } = await import("../src/gifts");
    const entries = [
      { userId: "b", wallet: "WalletB", weight: 3 },
      { userId: "a", wallet: "WalletA", weight: 1 },
      { userId: "c", wallet: "WalletC", weight: 6 },
    ];
    expect(giftEntriesText(entries)).toBe("a:WalletA:1\nb:WalletB:3\nc:WalletC:6");
    // Total weight 10, in published order a(0) b(1-3) c(4-9).
    expect(pickGiftWinner(entries, "0")?.userId).toBe("a");
    expect(pickGiftWinner(entries, "3")?.userId).toBe("b");
    expect(pickGiftWinner(entries, "e")?.userId).toBe("c"); // 14 % 10 = 4
    expect(pickGiftWinner([...entries].reverse(), "e")?.userId).toBe("c");
    expect(pickGiftWinner([], "e")).toBeNull();
    // Every entry wins in proportion to its weight.
    const wins: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 1000; i++) wins[pickGiftWinner(entries, i.toString(16))!.userId]!++;
    expect(wins).toEqual({ a: 100, b: 300, c: 600 });
  });
});

describe("Pulse sale split", () => {
  it("sends the set share to buyback and burn and the rest back to drops, to the micro", async () => {
    const { splitSale } = await import("../src/flywheel");
    expect(splitSale(usd(45), 5_000)).toEqual({ buyback: usd(22.5), drops: usd(22.5) });
    expect(splitSale(1_000_001, 5_000)).toEqual({ buyback: 500_000, drops: 500_001 });
    expect(splitSale(usd(45), 10_000)).toEqual({ buyback: usd(45), drops: 0 });
    expect(splitSale(usd(45), 0)).toEqual({ buyback: 0, drops: usd(45) });
  });
});
