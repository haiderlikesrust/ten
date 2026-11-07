import type { Holding } from "./types";

export interface HistoryPoint {
  time: number;
  /** Cards, at insured value. */
  value: number;
  /** Cards plus the trading wallet: the same number as the Net worth headline. */
  worth: number;
  pnl: number;
}

/**
 * Rebuilds net worth and profit over time from what was actually bought, sold and moved.
 * Deposits change net worth but not profit.
 */
export function buildHistory(held: Holding[], exited: Holding[], wallet: Array<{ at: string; delta: number }> = [], now = Date.now()): HistoryPoint[] {
  const events: Array<{ at: number; value: number; cost: number; realized: number; cash: number }> = [];
  for (const holding of [...held, ...exited]) {
    const value = holding.insuredValue ?? holding.cost;
    events.push({ at: new Date(holding.acquiredAt).getTime(), value, cost: holding.cost, realized: 0, cash: 0 });
    if (holding.exitedAt) events.push({ at: new Date(holding.exitedAt).getTime(), value: -value, cost: -holding.cost, realized: (holding.exitPrice ?? 0) - holding.cost, cash: 0 });
  }
  for (const move of wallet) events.push({ at: new Date(move.at).getTime(), value: 0, cost: 0, realized: 0, cash: move.delta });
  events.sort((a, b) => a.at - b.at);

  const bySecond = new Map<number, HistoryPoint>();
  let value = 0;
  let cost = 0;
  let realized = 0;
  let cash = 0;
  for (const event of events) {
    value += event.value;
    cost += event.cost;
    realized += event.realized;
    cash += event.cash;
    const time = Math.floor(event.at / 1000);
    bySecond.set(time, { time, value, worth: value + cash, pnl: value - cost + realized });
  }
  const points = [...bySecond.values()];
  const last = points[points.length - 1];
  const end = Math.floor(now / 1000);
  if (last && end > last.time) points.push({ ...last, time: end });
  return points;
}

/** Cuts history to a time range, carrying in the level from just before it starts. */
export function inRange(points: HistoryPoint[], hours: number | null, now = Date.now()): HistoryPoint[] {
  if (hours === null) return points;
  const from = Math.floor(now / 1000) - hours * 3600;
  const before = points.filter((point) => point.time < from).at(-1);
  const inside = points.filter((point) => point.time >= from);
  return before ? [{ ...before, time: from }, ...inside] : inside;
}

/** The chart library spaces points evenly, so history is resampled to keep time to scale. */
export function evenly(points: HistoryPoint[], count = 180): HistoryPoint[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || last.time <= first.time) return points;
  const step = (last.time - first.time) / (count - 1);
  const out: HistoryPoint[] = [];
  let index = 0;
  for (let i = 0; i < count; i++) {
    const time = Math.round(first.time + step * i);
    while (index + 1 < points.length && points[index + 1]!.time <= time) index += 1;
    if (out[out.length - 1]?.time !== time) out.push({ ...points[index]!, time });
  }
  return out;
}

export type SplitBy = "rarity" | "grader" | "source";

export interface Slice {
  key: string;
  label: string;
  value: number;
  count: number;
  slot: number;
}

const FIXED: Record<SplitBy, Array<[string, string]>> = {
  rarity: [["common", "Common"], ["uncommon", "Uncommon"], ["rare", "Rare"], ["epic", "Epic"]],
  grader: [["PSA", "PSA"], ["CGC", "CGC"], ["BGS", "BGS"], ["SGC", "SGC"]],
  source: [["drop", "Pulse"], ["gacha", "Packs"], ["market", "Market"]],
};

const OTHER_SLOT = 4;

/** Each group keeps one color slot for good, so nothing repaints when the collection changes. */
export function splitCollection(held: Holding[], by: SplitBy): Slice[] {
  const keyOf = (holding: Holding) => String(by === "source" ? holding.source : holding.card[by] ?? "");
  const fixed = FIXED[by];
  const slices: Slice[] = fixed.map(([key, label], slot) => ({ key, label, slot, value: 0, count: 0 }));
  const other: Slice = { key: "other", label: "Other", slot: OTHER_SLOT, value: 0, count: 0 };
  for (const holding of held) {
    const slice = slices.find((item) => item.key === keyOf(holding)) ?? other;
    slice.value += holding.insuredValue ?? holding.cost;
    slice.count += 1;
  }
  return [...slices, other].filter((slice) => slice.count > 0);
}

export type HoldingSort = "value" | "profit" | "newest" | "buyback";

const profit = (holding: Holding) => (holding.insuredValue ?? 0) - holding.cost;

export function sortHoldings(rows: Holding[], sort: HoldingSort): Holding[] {
  const closes = (holding: Holding) => (holding.buybackUntil ? new Date(holding.buybackUntil).getTime() : Number.MAX_SAFE_INTEGER);
  return [...rows].sort((a, b) => {
    if (sort === "profit") return profit(b) - profit(a);
    if (sort === "newest") return new Date(b.acquiredAt).getTime() - new Date(a.acquiredAt).getTime();
    if (sort === "buyback") return closes(a) - closes(b);
    return (b.insuredValue ?? 0) - (a.insuredValue ?? 0);
  });
}
