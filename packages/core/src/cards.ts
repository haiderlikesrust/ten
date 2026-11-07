import type { Micros } from "./money";

export type Rarity = "common" | "uncommon" | "rare" | "epic";
export const RARITIES: readonly Rarity[] = ["common", "uncommon", "rare", "epic"];

export function rarityFromTier(tier: number | null | undefined): Rarity | null {
  return tier === 1 ? "epic" : tier === 2 ? "rare" : tier === 3 ? "uncommon" : tier === 4 ? "common" : null;
}

export interface CardSummary {
  nft: string;
  name: string;
  category: string | null;
  set: string | null;
  year: number | null;
  grader: string | null;
  grade: string | null;
  gradeNum: number | null;
  cert: string | null;
  image: string | null;
  insuredValue: Micros | null;
}

/** "GEM-MT 10" -> 10, "NM-MT 8.5" -> 8.5 */
export function parseGradeNumber(grade: string | null | undefined, explicit?: number | null): number | null {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  const match = String(grade ?? "").match(/(\d+(?:\.\d+)?)\s*$/);
  return match ? Number(match[1]) : null;
}

export function shortAddress(address: string | null | undefined): string {
  if (!address) return "";
  return address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Links a card to the certificate lookup run by its grader. */
export function certUrl(grader: string | null, cert: string | null): string | null {
  if (!grader || !cert) return null;
  const g = grader.toUpperCase();
  if (g === "PSA") return `https://www.psacard.com/cert/${encodeURIComponent(cert)}`;
  if (g === "CGC") return `https://www.cgccards.com/certlookup/${encodeURIComponent(cert)}/`;
  if (g === "BGS" || g === "BECKETT") return "https://www.beckett.com/grading/card-lookup";
  return null;
}
