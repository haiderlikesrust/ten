/** Single source of truth for product naming. Change the names here only. */
export const BRAND = {
  name: "Tenner",
  tagline: "The trading terminal for graded cards",
  dropsName: "Pulse",
  dropVerb: "Buy",
  tokenTicker: "$TENR",
  /** Written into every on-chain memo, so our transactions are easy to find and audit. */
  memoPrefix: "tenner",
} as const;
