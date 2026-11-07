import { ofBps, type Micros } from "./money";

export interface FeeSplit {
  cashback: Micros;
  drops: Micros;
}

/** Splits USDC actually received. Rounding dust always goes to Drops, so the two sum exactly. */
export function splitFees(received: Micros, cashbackBps: number): FeeSplit {
  const cashback = ofBps(received, cashbackBps);
  return { cashback, drops: received - cashback };
}

export const FEE_STAGES = ["PENDING", "COLLECTED", "SWAPPED", "SPLIT", "DONE", "SKIPPED"] as const;
export type FeeStage = (typeof FEE_STAGES)[number];
