import { floorToCents, type Micros } from "./money";
import type { DropSettings } from "./settings";

type PriceRules = Pick<DropSettings, "minPrice" | "maxPrice" | "ivMargin" | "hiddenLo" | "hiddenHi">;

function bandPrice(base: Micros, lo: number, hi: number, rnd: number, min: Micros, cap: Micros): Micros {
  const share = lo + rnd * (hi - lo);
  const raw = Math.floor(base * share);
  return floorToCents(Math.max(min, Math.min(cap, raw)));
}

/**
 * Snipe price for a sealed pack. The card is unknown, so the only way to guarantee
 * "below insured value" is to stay under the lowest card the machine can give.
 */
export function hiddenPrice(commonFloor: Micros, rnd: number, rules: PriceRules): Micros | null {
  const cap = Math.min(rules.maxPrice, commonFloor - rules.ivMargin);
  if (cap < rules.minPrice) return null;
  return bandPrice(commonFloor, rules.hiddenLo, rules.hiddenHi, rnd, rules.minPrice, cap);
}

/** Share of insured value saved by the buyer, as a whole percent. */
export function discountPct(price: Micros, insuredValue: Micros): number {
  if (insuredValue <= 0) return 0;
  return Math.round((1 - price / insuredValue) * 100);
}
