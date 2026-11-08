// Gift draws (docs/FLYWHEEL.md): pure rules, safe to run anywhere. Hashing and the chain live in the worker.
import { usd, type Micros } from "./money";

export type GiftGroup = "active" | "holders" | "blasters";
export const GIFT_GROUPS: GiftGroup[] = ["active", "holders", "blasters"];

export interface GiftEntry {
  userId: string;
  wallet: string;
  weight: number;
}

const DAY_MS = 86_400_000;

/** The start of the draw slot a moment falls in. Slots line up from midnight UTC. */
export function giftSlot(at: number, intervalMin: number): number {
  const ms = intervalMin * 60_000;
  return Math.floor(at / ms) * ms;
}

/** Groups take turns, one per slot. A group with nobody eligible passes to the next. */
export function giftGroupOrder(slotAt: number, intervalMin: number): GiftGroup[] {
  const turn = Math.floor(slotAt / (intervalMin * 60_000)) % GIFT_GROUPS.length;
  return [...GIFT_GROUPS.slice(turn), ...GIFT_GROUPS.slice(0, turn)];
}

/**
 * The prize for one draw: the biggest pack tier that fits in the share of the pool a draw may spend.
 * Null means the pot rolls over to the next draw.
 */
export function giftPrize(pool: Micros, spendBps: number, tiers: readonly Micros[]): Micros | null {
  const budget = Math.min(pool, Math.floor((pool * spendBps) / 10_000));
  const fits = [...tiers].sort((a, b) => b - a).find((tier) => tier <= budget);
  return fits ?? null;
}

/** One entry per full day held at the long-holder share, plus one, so a holder who just crossed it can still win. */
export const holderWeight = (aboveSince: Date | number, now: number): number =>
  1 + Math.max(0, Math.floor((now - new Date(aboveSince).getTime()) / DAY_MS));

/** One entry per $10 spent, at least one. */
export const blasterWeight = (spend: Micros): number => Math.max(1, Math.floor(spend / usd(10)));

/** The exact text whose hash is published before the seed exists. Sorted, so it doesn't depend on query order. */
export function giftEntriesText(entries: readonly GiftEntry[]): string {
  return [...entries]
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .map((e) => `${e.userId}:${e.wallet}:${e.weight}`)
    .join("\n");
}

/**
 * The winner for a seed (hex). The seed, as a number, modulo the total weight lands on one entry,
 * counting through entries in published order. Anyone with the entries and the seed gets the same answer.
 */
export function pickGiftWinner(entries: readonly GiftEntry[], seedHex: string): GiftEntry | null {
  const ordered = [...entries]
    .filter((e) => e.weight > 0)
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  const total = ordered.reduce((sum, e) => sum + e.weight, 0);
  if (total === 0) return null;
  let at = Number(BigInt(`0x${seedHex}`) % BigInt(total));
  for (const entry of ordered) {
    if (at < entry.weight) return entry;
    at -= entry.weight;
  }
  return null;
}
