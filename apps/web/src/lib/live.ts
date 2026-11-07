"use client";

import { discountPct } from "@gemdex/core";
import { create } from "zustand";
import { api, getToken, WS_URL } from "./api";
import type { Drop, DropsStatus, Listing, Pull, Win } from "./types";

const FEED_MAX = 80;

type UserHandler = (event: Record<string, unknown>) => void;

interface LiveState {
  connected: boolean;
  seq: number | null;
  fresh: Listing[];
  below: Listing[];
  pulls: Pull[];
  drops: Record<string, Drop>;
  recent: Drop[];
  wins: Win[];
  status: DropsStatus | null;
  pools: { drops: number; cashback: number } | null;
  newIds: Set<string>;
  hydrate: () => Promise<void>;
  apply: (topic: string, payload: Record<string, unknown>) => void;
}

export const useLive = create<LiveState>((set, get) => ({
  connected: false,
  seq: null,
  fresh: [],
  below: [],
  pulls: [],
  drops: {},
  recent: [],
  wins: [],
  status: null,
  pools: null,
  newIds: new Set(),

  hydrate: async () => {
    const [pulse, drops] = await Promise.all([
      api<{ fresh: Listing[]; below: Listing[]; pulls: Pull[] }>("/pulse"),
      api<{ live: Drop[]; recent: Drop[]; status: DropsStatus | null; pools: { drops: number; cashback: number } }>("/drops"),
    ]);
    set({
      fresh: pulse.fresh,
      below: pulse.below,
      pulls: pulse.pulls,
      drops: Object.fromEntries(drops.live.map((d) => [d.id, d])),
      recent: drops.recent,
      status: drops.status,
      pools: drops.pools,
    });
  },

  apply: (topic, payload) => {
    const type = payload.type as string;
    if (topic === "pulls" && type === "pull") {
      const pull = payload.pull as Pull;
      set((s) => (s.pulls.some((p) => p.id === pull.id) ? s : { pulls: [pull, ...s.pulls].slice(0, FEED_MAX), newIds: new Set(s.newIds).add(pull.id) }));
    }
    if (topic === "listings" && type === "listing") {
      const raw = payload.listing as Listing;
      const listing = { ...raw, discountPct: raw.insuredValue ? discountPct(raw.price, raw.insuredValue) : null };
      set((s) => {
        if (s.fresh.some((l) => l.nft === listing.nft)) return s;
        const below = (listing.discountPct ?? 0) > 0 ? [...s.below, listing].sort((a, b) => (b.discountPct ?? 0) - (a.discountPct ?? 0)).slice(0, FEED_MAX) : s.below;
        return { fresh: [listing, ...s.fresh].slice(0, FEED_MAX), below, newIds: new Set(s.newIds).add(listing.nft) };
      });
    }
    if (topic === "listings" && type === "sold") {
      const nft = payload.nft as string;
      set((s) => ({ fresh: s.fresh.filter((l) => l.nft !== nft), below: s.below.filter((l) => l.nft !== nft) }));
    }
    if (topic === "drops" && type === "drop") {
      const drop = payload.drop as Drop;
      set((s) => {
        const drops = { ...s.drops };
        if (drop.state === "LIVE") drops[drop.id] = drop;
        else delete drops[drop.id];
        const recent = drop.state === "SETTLED" || drop.state === "DELIVERED" ? [drop, ...s.recent.filter((d) => d.id !== drop.id)].slice(0, 30) : s.recent;
        return { drops, recent };
      });
    }
    if (topic === "drops" && type === "claimed") {
      const dropId = payload.dropId as string;
      set((s) => {
        const drops = { ...s.drops };
        delete drops[dropId];
        return { drops };
      });
    }
    if (topic === "wins" && type === "win") {
      set((s) => ({ wins: [payload as unknown as Win, ...s.wins].slice(0, 30) }));
    }
    if (topic === "status" && type === "dropsStatus") {
      set({ status: payload.status as DropsStatus });
    }
    void get;
  },
}));

const userHandlers = new Set<UserHandler>();

const dropHandlers = new Set<UserHandler>();

/** Price ticks are frequent, so Pulse keeps its own store instead of sharing this one. */
export function onDropEvent(handler: UserHandler): () => void {
  dropHandlers.add(handler);
  return () => dropHandlers.delete(handler);
}

export function onUserEvent(handler: UserHandler): () => void {
  userHandlers.add(handler);
  return () => userHandlers.delete(handler);
}

let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;

export function connectStream(): void {
  if (typeof window === "undefined") return;
  if (retry) clearTimeout(retry);
  if (socket && socket.readyState <= 1) socket.close();

  const { seq } = useLive.getState();
  const params = new URLSearchParams();
  const token = getToken();
  if (token) params.set("token", token);
  if (seq !== null) params.set("lastSeq", String(seq));
  const ws = new WebSocket(`${WS_URL}/stream?${params}`);
  socket = ws;

  ws.onopen = () => {
    attempts = 0;
    useLive.setState({ connected: true });
  };
  ws.onmessage = (message) => {
    const event = JSON.parse(String(message.data)) as { seq?: number; topic: string; payload: Record<string, unknown> };
    if (event.topic === "hello") {
      if (useLive.getState().seq === null) useLive.setState({ seq: event.payload.seq as number });
      return;
    }
    if (event.seq) useLive.setState({ seq: event.seq });
    if (event.topic === "drops") dropHandlers.forEach((handler) => handler(event.payload));
    if (event.topic.startsWith("user:")) userHandlers.forEach((handler) => handler(event.payload));
    else useLive.getState().apply(event.topic, event.payload);
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    useLive.setState({ connected: false });
    // 1012: the gateway is restarting for an update and its replacement is already up, so come straight back.
    if (event.code === 1012) {
      attempts = 0;
      retry = setTimeout(connectStream, 150 + Math.random() * 350);
      return;
    }
    attempts += 1;
    retry = setTimeout(connectStream, Math.min(8000, 500 * 2 ** attempts));
  };
  ws.onerror = () => ws.close();
}
