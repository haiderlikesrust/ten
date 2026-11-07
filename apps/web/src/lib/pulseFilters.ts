"use client";

import { create } from "zustand";
import { gradeShort } from "./format";
import type { PulseCard } from "./pulse";

export interface PulseFilter {
  q: string;
  kind: "all" | "revealed" | "hidden";
  status: "all" | "sold" | "open";
  rarities: string[];
  graders: string[];
  packs: string[];
  minGrade: string;
  minPrice: string;
  maxPrice: string;
  minValue: string;
  maxValue: string;
  belowValue: boolean;
}

export const EMPTY_FILTER: PulseFilter = {
  q: "", kind: "all", status: "all", rarities: [], graders: [], packs: [], minGrade: "", minPrice: "", maxPrice: "", minValue: "", maxValue: "", belowValue: false,
};

export const COLUMNS = ["new", "live", "final"] as const;

/** How many filters are switched on, for the badge on each column. */
export function filterCount(f: PulseFilter): number {
  const lists = [f.rarities, f.graders, f.packs].filter((list) => list.length > 0).length;
  const fields = [f.q.trim(), f.minGrade, f.minPrice || f.maxPrice, f.minValue || f.maxValue].filter(Boolean).length;
  return lists + fields + (f.kind !== "all" ? 1 : 0) + (f.status !== "all" ? 1 : 0) + (f.belowValue ? 1 : 0);
}

function gradeNumber(card: PulseCard): number | null {
  const found = gradeShort(card.card?.grader, card.card?.grade)?.match(/(\d+(?:\.\d+)?)$/);
  return found ? Number(found[1]) : null;
}

export function matches(card: PulseCard, f: PulseFilter): boolean {
  if (f.kind !== "all" && card.kind !== f.kind) return false;
  if (f.status === "sold" && !card.boughtBy) return false;
  if (f.status === "open" && card.boughtBy) return false;
  if (f.rarities.length > 0 && !f.rarities.includes(card.rarity ?? "")) return false;
  if (f.graders.length > 0 && !f.graders.includes(String(card.card?.grader ?? ""))) return false;
  if (f.packs.length > 0 && !f.packs.includes(card.machineCode)) return false;

  const q = f.q.trim().toLowerCase();
  if (q && !String(card.card?.name ?? "").toLowerCase().includes(q)) return false;

  const price = card.price / 1e6;
  if (f.minPrice && price < Number(f.minPrice)) return false;
  if (f.maxPrice && price > Number(f.maxPrice)) return false;

  // A hidden card has no public value, so a value filter cannot match it.
  const value = card.insuredValue === null ? null : card.insuredValue / 1e6;
  if ((f.minValue || f.maxValue || f.belowValue) && value === null) return false;
  if (value !== null) {
    if (f.minValue && value < Number(f.minValue)) return false;
    if (f.maxValue && value > Number(f.maxValue)) return false;
    if (f.belowValue && price >= value) return false;
  }

  if (f.minGrade) {
    const grade = gradeNumber(card);
    if (grade === null || grade < Number(f.minGrade)) return false;
  }
  return true;
}

const KEY = "gemdex.pulse.filters";

function save(filters: Record<string, PulseFilter>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(filters));
  } catch {
    // Filters still work for this visit.
  }
}

interface FilterStore {
  filters: Record<string, PulseFilter>;
  load: () => void;
  patch: (column: string, change: Partial<PulseFilter>) => void;
  reset: (column: string) => void;
  applyToAll: (column: string) => void;
}

export const usePulseFilters = create<FilterStore>((set, get) => ({
  filters: {},
  load: () => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) set({ filters: JSON.parse(saved) as Record<string, PulseFilter> });
    } catch {
      // Starts with no filters.
    }
  },
  patch: (column, change) => {
    const filters = { ...get().filters, [column]: { ...EMPTY_FILTER, ...get().filters[column], ...change } };
    set({ filters });
    save(filters);
  },
  reset: (column) => {
    const filters = { ...get().filters, [column]: EMPTY_FILTER };
    set({ filters });
    save(filters);
  },
  applyToAll: (column) => {
    const source = { ...EMPTY_FILTER, ...get().filters[column] };
    const filters = Object.fromEntries(COLUMNS.map((key) => [key, { ...source, status: key === "final" ? source.status : ("all" as const) }]));
    set({ filters });
    save(filters);
  },
}));
