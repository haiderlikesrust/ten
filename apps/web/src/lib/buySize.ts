"use client";

import { create } from "zustand";

export const BUY_SIZES = [
  { value: "s", label: "S" },
  { value: "m", label: "M" },
  { value: "l", label: "L" },
] as const;

export type BuySize = (typeof BUY_SIZES)[number]["value"];

const KEY = "gemdex.buy.size";

interface BuySizeStore {
  size: BuySize;
  load: () => void;
  set: (size: BuySize) => void;
}

export const useBuySize = create<BuySizeStore>((set) => ({
  size: "s",
  load: () => {
    try {
      const saved = localStorage.getItem(KEY);
      // XL was removed; anyone who had it gets the biggest size left.
      if (saved === "xl") set({ size: "l" });
      else if (BUY_SIZES.some((item) => item.value === saved)) set({ size: saved as BuySize });
    } catch {
      // Starts at the default size.
    }
  },
  set: (size) => {
    set({ size });
    try {
      localStorage.setItem(KEY, size);
    } catch {
      // The size still applies for this visit.
    }
  },
}));

/** Large sizes stand at the end of a row as a tall block, as high as the row itself. */
export const isTallBuy = (size: BuySize): boolean => size === "l";
