import { describe, expect, it } from "vitest";
import { generatePath, pathIndex, pickCharacter, priceAt, publicDrop, pulseView, sampleSeries, usd, type DropRow, type PathCharacter, type PathInput } from "../src/index";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const path = (character: PathCharacter, value: number, r: () => number, extra: Partial<PathInput> = {}) =>
  generatePath({ value: usd(value), min: usd(5), crash: [0.1, 0.4], seconds: 300, rng: r, character, ...extra });

describe("price path", () => {
  it("opens at the insured price, and every second has a price in whole cents", () => {
    const r = rng(1);
    for (let i = 0; i < 400; i++) {
      const value = usd(Math.floor((13 + r() * 2000) * 100) / 100);
      const points = generatePath({ value, min: usd(5), crash: [0.1, 0.4], seconds: 300, rng: r });
      expect(points).toHaveLength(300);
      expect(points[0]).toBe(value);
      for (const price of points) expect(price % 10_000).toBe(0);
    }
  });

  it("opens differently every time, not always straight up", () => {
    const r = rng(12);
    let down = 0;
    let up = 0;
    let dipped = 0;
    let quiet = 0;
    for (let i = 0; i < 1000; i++) {
      const points = path(pickCharacter(r()), 200, r);
      const early = points[20]!;
      if (early < usd(196)) down++;
      if (early > usd(204)) up++;
      if (early >= usd(196) && early <= usd(204)) quiet++;
      if (Math.min(...points.slice(0, 45)) <= usd(190)) dipped++;
    }
    expect(down).toBeGreaterThan(200);
    expect(up).toBeGreaterThan(200);
    expect(quiet).toBeGreaterThan(100);
    expect(dipped).toBeGreaterThan(250);
  });

  it("gives seven in ten cards the run up, then simmer or crash", () => {
    const r = rng(2);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10_000; i++) {
      const character = pickCharacter(r());
      counts[character] = (counts[character] ?? 0) + 1;
    }
    const share = ((counts.crash ?? 0) + (counts.simmer ?? 0)) / 10_000;
    expect(share).toBeGreaterThan(0.68);
    expect(share).toBeLessThan(0.72);
    for (const other of ["moon", "late_run", "chop", "fade"]) expect(counts[other]).toBeGreaterThan(200);
  });

  it("runs up, then crashes 60% to 90% below insured", () => {
    const r = rng(3);
    for (let i = 0; i < 300; i++) {
      const points = path("crash", 200, r);
      expect(Math.max(...points.slice(0, 130))).toBeGreaterThan(usd(220));
      const low = Math.min(...points);
      expect(low).toBeGreaterThanOrEqual(usd(20));
      expect(low).toBeLessThanOrEqual(usd(80));
    }
  });

  it("has fake bounces on the way down, not a straight line", () => {
    const r = rng(11);
    let bounced = 0;
    for (let i = 0; i < 500; i++) {
      const points = path("crash", 200, r);
      const landed = points.findIndex((price) => price <= Math.min(...points) * 1.05);
      // The fall runs from the last moment the price was at or above insured.
      const fall = points.slice(points.slice(0, landed).lastIndexOf(points.slice(0, landed).filter((price) => price >= usd(200)).at(-1)!), landed);
      let low = fall[0]!;
      let rally = 1;
      for (const price of fall) {
        low = Math.min(low, price);
        rally = Math.max(rally, price / low);
      }
      if (rally >= 1.12) bounced++;
    }
    expect(bounced).toBeGreaterThan(450);
  });

  it("can crash at any point, so nobody can plan around it", () => {
    const r = rng(9);
    // Counts the minute each card first reaches half of its insured price. A crash takes about
    // a minute to fall, so one that starts at 30 seconds gets there in the second minute.
    const byMinute = [0, 0, 0, 0, 0];
    for (let i = 0; i < 1000; i++) {
      const points = path("crash", 200, r);
      byMinute[Math.floor(points.findIndex((price) => price <= usd(100)) / 60)]!++;
    }
    for (const crashes of byMinute.slice(1)) expect(crashes).toBeGreaterThan(30);
    expect(Math.max(...byMinute)).toBeLessThan(450);
  });

  it("closes the cheap window on most crashes, so waiting for the end doesn't pay", () => {
    const r = rng(10);
    let stillCheap = 0;
    for (let i = 0; i < 1000; i++) {
      if (path("crash", 200, r).at(-1)! <= usd(100)) stillCheap++;
    }
    expect(stillCheap).toBeGreaterThan(200);
    expect(stillCheap).toBeLessThan(550);
  });

  it("simmers around its value without crashing", () => {
    const r = rng(4);
    for (let i = 0; i < 300; i++) {
      const points = path("simmer", 200, r);
      expect(Math.max(...points.slice(0, 130))).toBeGreaterThan(usd(220));
      expect(Math.min(...points)).toBeGreaterThan(usd(120));
    }
  });

  it("lets some cards finish well above insured", () => {
    const r = rng(5);
    for (let i = 0; i < 300; i++) {
      expect(path("moon", 200, r).at(-1)).toBeGreaterThan(usd(300));
      expect(path("late_run", 200, r).at(-1)).toBeGreaterThan(usd(220));
    }
  });

  it("never goes more than 90% below the open, or under the minimum", () => {
    const r = rng(6);
    for (let i = 0; i < 400; i++) {
      const value = 13 + r() * 2000;
      const points = generatePath({ value: usd(value), min: usd(5), crash: [0.1, 0.4], seconds: 300, rng: r });
      // One cent of room, because prices round down to whole cents.
      expect(Math.min(...points)).toBeGreaterThanOrEqual(Math.max(usd(5), usd(value * 0.1) - 10_000));
    }
  });

  it("stops a cheap card's crash at the minimum, without pinning it there", () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const points = path("crash", 15, r);
      expect(Math.min(...points)).toBeGreaterThanOrEqual(usd(5));
      expect(Math.min(...points)).toBeLessThanOrEqual(usd(6.5));
    }
    expect(new Set(path("crash", 15, r).slice(-60)).size).toBeGreaterThan(10);
  });

  it("has no ceiling on a shown card, and keeps a sealed pack under its own", () => {
    const r = rng(8);
    expect(path("moon", 800, r).every((price) => price >= usd(80))).toBe(true);
    expect(Math.max(...path("moon", 800, r))).toBeGreaterThan(usd(1000));
    for (let i = 0; i < 300; i++) {
      const points = generatePath({ value: usd(9.6), min: usd(5), max: usd(12), crash: [0.1, 0.4], seconds: 300, rng: r });
      expect(Math.max(...points)).toBeLessThanOrEqual(usd(12));
      expect(Math.min(...points)).toBeGreaterThanOrEqual(usd(5));
    }
  });

  it("reads the right second, and holds the last price once time runs out", () => {
    const prices = [100, 200, 300];
    expect(pathIndex(1000, 1000, 3)).toBe(0);
    expect(priceAt(prices, 1000, 2500)).toBe(200);
    expect(priceAt(prices, 1000, 999_999)).toBe(300);
    expect(priceAt(prices, 1000, 0)).toBe(100);
  });

  it("samples a series at a fixed step, so small charts hold still", () => {
    const series = sampleSeries(Array.from({ length: 21 }, (_, i) => i), 5);
    expect(series).toEqual([0, 5, 10, 15, 20]);
  });
});

describe("what clients can see", () => {
  const opensAt = new Date(1_000_000);
  const path = [usd(10), usd(11), usd(12), usd(99), usd(5)];
  const row: DropRow = {
    id: "d", number: 1, kind: "revealed", state: "LIVE", machineCode: "pokemon_25", price: usd(10), packPrice: usd(25), opensAt, expiresAt: new Date(9_000_000),
    insuredValue: usd(15), rarity: "common", nft: "n", card: { name: "x" }, path, stoppedAt: null, boughtBy: null,
  };

  it("never exposes a future price", () => {
    const view = pulseView(row, opensAt.getTime() + 2500);
    const text = JSON.stringify(view);
    expect(view.price).toBe(usd(12));
    expect(view.high).toBe(usd(12));
    expect(view.series).toEqual([usd(10)]);
    expect(text).not.toContain(String(usd(99)));
    expect(text).not.toContain('"path"');
  });

  it("freezes the chart at the moment a card is bought", () => {
    const view = pulseView({ ...row, state: "CLAIMED", stoppedAt: new Date(opensAt.getTime() + 1500), boughtBy: "wallet", price: usd(11) }, opensAt.getTime() + 4000);
    expect(view.price).toBe(usd(11));
    expect(view.series).toEqual([usd(10)]);
    expect(view.boughtBy).toBe("wallet");
  });

  it("keeps a hidden card secret even with a price path", () => {
    const view = pulseView({ ...row, kind: "hidden" }, opensAt.getTime() + 1000);
    expect(view.card).toBeNull();
    expect(view.nft).toBeNull();
    expect(view.insuredValue).toBeNull();
    expect(publicDrop({ ...row, kind: "hidden" }).rarity).toBeNull();
  });
});
