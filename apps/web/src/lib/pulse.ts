"use client";

import { SERIES_STEP } from "@gemdex/core";
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "./api";
import { onDropEvent } from "./live";
import type { CardBits } from "./types";

export interface PulseCard {
  id: string;
  number: number;
  kind: "revealed" | "hidden";
  state: string;
  machineCode: string;
  price: number;
  openPrice: number;
  packPrice: number;
  opensAt: string;
  expiresAt: string;
  insuredValue: number | null;
  rarity: string | null;
  nft: string | null;
  card: CardBits | null;
  high: number;
  low: number;
  series: number[];
  movesUntil: string | null;
  stoppedAt: string | null;
  boughtBy: string | null;
}

export type PricePoint = { id: string; p: number };
type TickListener = (items: PricePoint[], at: string) => void;

const tickListeners = new Set<TickListener>();

export function onPriceTick(listener: TickListener): () => void {
  tickListeners.add(listener);
  return () => tickListeners.delete(listener);
}

interface PulseStore {
  ready: boolean;
  cards: Record<string, PulseCard>;
  newPullSec: number;
  moveSec: number;
  load: () => Promise<void>;
}

const KEEP_FINAL = 60;

export const usePulse = create<PulseStore>((set) => ({
  ready: false,
  cards: {},
  newPullSec: 60,
  moveSec: 300,
  load: async () => {
    const data = await api<{ drops: PulseCard[]; newPullSec: number; moveSec: number }>("/pulse/drops");
    set({ ready: true, cards: Object.fromEntries(data.drops.map((d) => [d.id, d])), newPullSec: data.newPullSec, moveSec: data.moveSec });
  },
}));

function applyEvent(event: Record<string, unknown>) {
  const type = event.type as string;
  if (type === "drop") {
    const card = event.drop as PulseCard;
    usePulse.setState((s) => {
      const cards = { ...s.cards };
      if (card.state === "LIVE" || card.boughtBy) cards[card.id] = card;
      else delete cards[card.id];
      return { cards };
    });
  }
  if (type === "claimed") {
    const id = event.dropId as string;
    usePulse.setState((s) => {
      const card = s.cards[id];
      if (!card) return s;
      return { cards: { ...s.cards, [id]: { ...card, state: "CLAIMED", boughtBy: event.by as string, price: event.price as number, stoppedAt: event.stoppedAt as string } } };
    });
  }
  if (type === "prices") {
    const items = event.items as PricePoint[];
    const at = new Date(event.at as string).getTime();
    usePulse.setState((s) => {
      const cards = { ...s.cards };
      for (const item of items) {
        const card = cards[item.id];
        if (!card || card.boughtBy) continue;
        const due = Math.floor((at - new Date(card.opensAt).getTime()) / 1000 / SERIES_STEP) >= card.series.length;
        cards[item.id] = { ...card, price: item.p, high: Math.max(card.high, item.p), low: Math.min(card.low, item.p), series: due ? [...card.series, item.p] : card.series };
      }
      const finals = Object.values(cards).filter((c) => c.boughtBy).sort((a, b) => b.number - a.number);
      for (const stale of finals.slice(KEEP_FINAL)) delete cards[stale.id];
      return { cards };
    });
    tickListeners.forEach((listener) => listener(items, event.at as string));
  }
}

let wired = false;

/** Loads once and stays subscribed for the life of the page. */
export function usePulseFeed() {
  useEffect(() => {
    if (wired) return;
    wired = true;
    onDropEvent(applyEvent);
    void usePulse.getState().load().catch(() => {});
    // Resync now and then, so a dropped message can only ever cost a few seconds.
    setInterval(() => void usePulse.getState().load().catch(() => {}), 60_000);
  }, []);
}

export type PulsePhase = "new" | "live" | "final";

export function phaseOf(card: PulseCard, now: number, newPullSec: number): PulsePhase {
  if (card.boughtBy || card.state !== "LIVE") return "final";
  if (card.movesUntil && now >= new Date(card.movesUntil).getTime()) return "final";
  return (now - new Date(card.opensAt).getTime()) / 1000 < newPullSec ? "new" : "live";
}

/** Against where the price opened, as a percent. */
export const changePct = (price: number, open: number): number => (open > 0 ? (price / open - 1) * 100 : 0);

/**
 * How far under the live price a limit order sits, as text such as "12%". Null once the price has reached it.
 * Compared in whole micros, never on a rounded percent: half a percent short is still not reached.
 */
export function limitGap(limit: number, price: number): string | null {
  if (!(limit > 0) || !(price > 0) || limit >= price) return null;
  const pct = (1 - limit / price) * 100;
  return pct < 1 ? "under 1%" : `${Math.round(pct)}%`;
}
