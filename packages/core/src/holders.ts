import type { HolderTier } from "./settings";

/** The lowest balance seen in the window decides the tier, which defeats flash-buying. */
export function holderBalance(snapshots: readonly number[]): number {
  return snapshots.length === 0 ? 0 : Math.min(...snapshots);
}

export function tierFor(balance: number, tiers: readonly HolderTier[]): HolderTier | null {
  let best: HolderTier | null = null;
  for (const tier of tiers) {
    if (balance >= tier.minBalance && (!best || tier.minBalance > best.minBalance)) best = tier;
  }
  return best;
}
