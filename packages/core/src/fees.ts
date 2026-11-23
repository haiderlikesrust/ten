import type { FlywheelSettings } from "./flywheel";
import { ofBps, type Micros } from "./money";

export interface FeeSplit {
  cashback: Micros;
  /** The gift pool's share (docs/FLYWHEEL.md). It comes out of what would have gone to Drops. */
  gifts: Micros;
  drops: Micros;
  /** Goes to the buyback and burn of $TENR. Only the smart split sends any. */
  buyback: Micros;
}

/** The fixed split of USDC actually received. Rounding dust always goes to Drops, so the parts sum exactly. */
export function splitFees(received: Micros, cashbackBps: number, giftBps = 0): FeeSplit {
  const cashback = ofBps(received, cashbackBps);
  const gifts = Math.min(ofBps(received, giftBps), received - cashback);
  return { cashback, gifts, drops: received - cashback - gifts, buyback: 0 };
}

export type GrowthRamp = Pick<FlywheelSettings, "growthStartUsd" | "growthFullUsd" | "growthMaxBps">;

/**
 * How much of each fee dollar leaves Pulse and gifts at this pool size, in basis points: nothing up to the start,
 * then rising in a straight line to the most at full, and staying there.
 */
export function growthBps(pool: Micros, ramp: GrowthRamp): number {
  const most = Math.min(10_000, Math.max(0, ramp.growthMaxBps));
  if (most === 0 || pool <= ramp.growthStartUsd) return 0;
  if (pool >= ramp.growthFullUsd || ramp.growthFullUsd <= ramp.growthStartUsd) return most;
  return Math.floor((most * (pool - ramp.growthStartUsd)) / (ramp.growthFullUsd - ramp.growthStartUsd));
}

export type SmartSplitRules = GrowthRamp & Pick<FlywheelSettings, "giftBps" | "growthBuybackBps" | "buybackEnabled">;

/**
 * The smart split (docs/FLYWHEEL.md). `pool` is what the Pulse and gift pools hold now. While they are small, fees all
 * go to them; as they grow, a rising share goes to cashback and buyback. With buyback off, its part stays in Pulse
 * drops rather than piling up unspent. Dust goes to Drops, so the parts sum exactly.
 */
export function smartSplitFees(received: Micros, pool: Micros, rules: SmartSplitRules): FeeSplit {
  const growth = ofBps(received, growthBps(pool, rules));
  const buybackPart = ofBps(growth, Math.min(10_000, Math.max(0, rules.growthBuybackBps)));
  const buyback = rules.buybackEnabled ? buybackPart : 0;
  const cashback = growth - buybackPart;
  const gifts = Math.min(ofBps(received, rules.giftBps), received - cashback - buyback);
  return { cashback, gifts, buyback, drops: received - cashback - gifts - buyback };
}

/** The split in force: smart when it's on, otherwise fixed. */
export function allocateFees(received: Micros, pool: Micros, cashbackBps: number, rules: SmartSplitRules & Pick<FlywheelSettings, "smartSplit">): FeeSplit {
  return rules.smartSplit ? smartSplitFees(received, pool, rules) : splitFees(received, cashbackBps, rules.giftBps);
}

export const FEE_STAGES = ["PENDING", "COLLECTED", "SWAPPED", "SPLIT", "DONE", "SKIPPED"] as const;
export type FeeStage = (typeof FEE_STAGES)[number];
