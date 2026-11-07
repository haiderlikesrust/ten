"use client";

import { useEffect, useState } from "react";
import { create } from "zustand";
import type { CardBits } from "./types";

export interface Toast {
  id: number;
  tone: "ok" | "bad" | "win" | "info";
  title: string;
  detail?: string;
}

export interface Reveal {
  card: CardBits;
  insuredValue: number | null;
  paid: number;
  rarity: string | null;
  label: string;
  soldBack?: number | null;
}

interface UiState {
  toasts: Toast[];
  reveal: Reveal | null;
  connectOpen: boolean;
  paletteOpen: boolean;
  /** Set by the wallet bridge when real sign-in is configured. */
  wallet: { login: () => void; exportKey: () => Promise<void>; signOut: () => Promise<void>; withdraw: (to: string, amount: number) => Promise<void>; signWithMain: (base64: string) => Promise<string> } | null;
  theme: "dark" | "light";
  toast: (toast: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
  setReveal: (reveal: Reveal | null) => void;
  setConnectOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setTheme: (theme: "dark" | "light") => void;
}

let nextId = 1;

export const useUi = create<UiState>((set) => ({
  toasts: [],
  reveal: null,
  connectOpen: false,
  paletteOpen: false,
  theme: "dark",
  wallet: null,
  toast: (toast) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), toast.tone === "bad" ? 6000 : 4000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setReveal: (reveal) => set({ reveal }),
  setConnectOpen: (connectOpen) => set({ connectOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("gemdex.theme", theme);
    } catch {
      // The choice simply lasts for this visit.
    }
    set({ theme });
  },
}));

/** Ticks once per interval so ages and countdowns stay live without a timer in every row. */
const listeners = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    listeners.add(setNow);
    if (!timer) timer = setInterval(() => listeners.forEach((listener) => listener(Date.now())), 1000);
    return () => {
      listeners.delete(setNow);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return now;
}
