import { discountPct } from "./pricing";
import type { Micros } from "./money";

export interface AutoRule {
  id: string;
  enabled: boolean;
  name: string;
  category: string | null;
  grader: string | null;
  minGrade: number | null;
  maxPrice: Micros;
  /** Smallest discount to insured value, in whole percent. */
  minDiscountPct: number;
  search: string | null;
  /** Total the rule may spend in 24 hours. */
  dailyBudget: Micros;
}

export interface RuleListing {
  name: string;
  category: string | null;
  grader: string | null;
  gradeNum: number | null;
  price: Micros;
  insuredValue: Micros | null;
}

export function matchesRule(rule: AutoRule, listing: RuleListing, spent24h: Micros): boolean {
  if (!rule.enabled) return false;
  if (listing.price > rule.maxPrice) return false;
  if (spent24h + listing.price > rule.dailyBudget) return false;
  if (rule.category && listing.category !== rule.category) return false;
  if (rule.grader && listing.grader?.toUpperCase() !== rule.grader.toUpperCase()) return false;
  if (rule.minGrade !== null && (listing.gradeNum === null || listing.gradeNum < rule.minGrade)) return false;
  if (rule.search && !listing.name.toLowerCase().includes(rule.search.toLowerCase())) return false;
  if (rule.minDiscountPct > 0) {
    if (listing.insuredValue === null) return false;
    if (discountPct(listing.price, listing.insuredValue) < rule.minDiscountPct) return false;
  }
  return true;
}
