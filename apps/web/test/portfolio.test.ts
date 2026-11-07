import { describe, expect, it } from "vitest";
import { buildHistory } from "../src/lib/portfolio";
import type { Holding } from "../src/lib/types";

const card = (at: string, cost: number, insuredValue: number, exit?: { at: string; price: number }) =>
  ({ acquiredAt: at, cost, insuredValue, exitedAt: exit?.at ?? null, exitPrice: exit?.price ?? null }) as unknown as Holding;

describe("portfolio history", () => {
  it("ends on the same net worth as the headline: wallet plus cards", () => {
    const held = [card("2026-11-07T10:05:00Z", 25e6, 40e6)];
    const wallet = [
      { at: "2026-11-07T10:00:00Z", delta: 100e6 },
      { at: "2026-11-07T10:05:00Z", delta: -25e6 },
    ];
    const history = buildHistory(held, [], wallet, Date.parse("2026-11-07T11:00:00Z"));
    const last = history.at(-1)!;
    expect(last.worth).toBe(75e6 + 40e6);
    expect(last.value).toBe(40e6);
  });

  it("moves net worth on a deposit but leaves profit alone", () => {
    const history = buildHistory([], [], [{ at: "2026-11-07T10:00:00Z", delta: 100e6 }], Date.parse("2026-11-07T11:00:00Z"));
    expect(history.at(-1)!.worth).toBe(100e6);
    expect(history.at(-1)!.pnl).toBe(0);
  });

  it("counts a card sold back as profit, and its money back in the wallet", () => {
    const sold = card("2026-11-07T10:00:00Z", 25e6, 40e6, { at: "2026-11-07T10:30:00Z", price: 34e6 });
    const wallet = [
      { at: "2026-11-07T09:59:00Z", delta: 50e6 },
      { at: "2026-11-07T10:00:00Z", delta: -25e6 },
      { at: "2026-11-07T10:30:00Z", delta: 34e6 },
    ];
    const last = buildHistory([], [sold], wallet, Date.parse("2026-11-07T11:00:00Z")).at(-1)!;
    expect(last.worth).toBe(59e6);
    expect(last.pnl).toBe(9e6);
  });
});
