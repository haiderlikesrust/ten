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
  /** The reveal on screen. The id tells one from the next, so each plays its own entrance. */
  reveal: (Reveal & { id: number }) | null;
  /** Reveals waiting behind the one on screen, oldest first. */
  revealQueue: Array<Reveal & { id: number }>;
  /** Cards with a sale, listing or send in flight. Their buttons wait instead of sending the same thing twice. */
  busy: Set<string>;
  connectOpen: boolean;
  paletteOpen: boolean;
  tourOpen: boolean;
  /** Set by the wallet bridge when real sign-in is configured. */
  wallet: { login: () => void; exportKey: () => Promise<void>; signOut: () => Promise<void>; withdraw: (to: string, amount: number) => Promise<void>; signWithMain: (base64: string, address?: string) => Promise<string> } | null;
  theme: "dark" | "light";
  toast: (toast: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
  /** A reveal joins the queue. Null closes the one on screen and shows the next. */
  setReveal: (reveal: Reveal | null) => void;
  clearReveals: () => void;
  setBusy: (ids: string[], busy: boolean) => void;
  setConnectOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setTourOpen: (open: boolean) => void;
  setTheme: (theme: "dark" | "light") => void;
}

let nextId = 1;

export const useUi = create<UiState>((set) => ({
  toasts: [],
  reveal: null,
  revealQueue: [],
  busy: new Set(),
  connectOpen: false,
  paletteOpen: false,
  tourOpen: false,
  theme: "dark",
  wallet: null,
  toast: (toast) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }));
    // Errors often say what to do next ("check your wallet before trying again"), so they stay long enough to read.
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), toast.tone === "bad" ? 12_000 : 4000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setReveal: (reveal) =>
    set((s) => {
      if (!reveal) {
        const [next, ...rest] = s.revealQueue;
        return { reveal: next ?? null, revealQueue: rest };
      }
      // Ten packs send ten reveals. Each waits its turn instead of replacing the one on screen.
      const entry = { ...reveal, id: nextId++ };
      return s.reveal ? { revealQueue: [...s.revealQueue, entry] } : { reveal: entry };
    }),
  clearReveals: () => set({ reveal: null, revealQueue: [] }),
  setBusy: (ids, busy) =>
    set((s) => {
      const next = new Set(s.busy);
      for (const id of ids) {
        if (busy) next.add(id);
        else next.delete(id);
      }
      return { busy: next };
    }),
  setConnectOpen: (connectOpen) => set({ connectOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setTourOpen: (tourOpen) => set({ tourOpen }),
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

/** How far the server's clock is ahead of this device's, in milliseconds. */
let clockOffset = 0;

/**
 * The time by the server's clock. Every deadline on the site (price lock, next card, buyback and gift timers) is a
 * server time, and a device clock can be a minute off, so they are compared against this and never Date.now().
 */
export const serverNow = (): number => Date.now() + clockOffset;

/** Called with the server's clock reading when the live feed connects. */
export function setServerClock(serverMs: number): void {
  if (!Number.isFinite(serverMs)) return;
  const offset = serverMs - Date.now();
  // The reading is as old as its trip here, so a small gap is only the network. Correcting for it would make timers jitter.
  clockOffset = Math.abs(offset) < 1500 ? 0 : offset;
}

/** Ticks once per interval so ages and countdowns stay live without a timer in every row. */
const listeners = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

export function useNow(): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    listeners.add(setNow);
    if (!timer) timer = setInterval(() => listeners.forEach((listener) => listener(serverNow())), 1000);
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
