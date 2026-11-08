import { ofBps, type Micros } from "./money";

export interface FeeSplit {
  cashback: Micros;
  /** The gift pool's share (docs/FLYWHEEL.md). It comes out of what would have gone to Drops. */
  gifts: Micros;
  drops: Micros;
}

/** Splits USDC actually received. Rounding dust always goes to Drops, so the three sum exactly. */
export function splitFees(received: Micros, cashbackBps: number, giftBps = 0): FeeSplit {
  const cashback = ofBps(received, cashbackBps);
  const gifts = Math.min(ofBps(received, giftBps), received - cashback);
  return { cashback, gifts, drops: received - cashback - gifts };
}

export const FEE_STAGES = ["PENDING", "COLLECTED", "SWAPPED", "SPLIT", "DONE", "SKIPPED"] as const;
export type FeeStage = (typeof FEE_STAGES)[number];
