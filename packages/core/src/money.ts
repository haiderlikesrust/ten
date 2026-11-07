/** All money is integer micro-USDC (6 decimals). Never store or compare floats. */
export type Micros = number;

export const MICROS_PER_USD = 1_000_000;
const CENT = 10_000;

export function assertMicros(value: number): asserts value is Micros {
  if (!Number.isSafeInteger(value)) throw new RangeError(`not integer micros: ${value}`);
}

export function usd(amount: number): Micros {
  const micros = Math.round(amount * MICROS_PER_USD);
  assertMicros(micros);
  return micros;
}

export function toUsd(micros: Micros): number {
  return micros / MICROS_PER_USD;
}

export function floorToCents(micros: Micros): Micros {
  return Math.floor(micros / CENT) * CENT;
}

/** Portion of an amount at a rate in basis points, rounded down. */
export function ofBps(amount: Micros, rateBps: number): Micros {
  return Math.floor((amount * rateBps) / 10_000);
}

/** CC sends insured values as "85", 85 or "$258.00". */
export function parseUsd(value: unknown): Micros | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return usd(parsed);
}

export function formatUsd(micros: Micros, opts: { compact?: boolean } = {}): string {
  const value = toUsd(micros);
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (opts.compact && abs >= 1000) {
    return `${sign}$${(abs / 1000).toFixed(abs >= 10_000 ? 1 : 2).replace(/\.?0+$/, "")}K`;
  }
  const whole = Number.isInteger(abs);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}
