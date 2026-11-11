"use client";

import { formatUsd } from "@gemdex/core";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api, ApiError, getToken, newKey, setToken } from "./api";
import { connectStream, onUserEvent } from "./live";
import type { Drop, Listing, Machine, Me, Meta } from "./types";
import { useUi } from "./ui";

export function useMeta() {
  return useQuery({ queryKey: ["meta"], queryFn: () => api<Meta>("/meta"), staleTime: 60_000 });
}

async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>("/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setToken(null);
      return null;
    }
    throw error;
  }
}

export function useMe() {
  const query = useQuery({
    queryKey: ["me"],
    enabled: typeof window !== "undefined" && !!getToken(),
    refetchInterval: 15_000,
    retry: false,
    queryFn: fetchMe,
  });
  return query.data ?? null;
}

/**
 * Loads the account straight after sign-in. The query above is switched off while signed out, and a switched-off
 * query ignores both invalidate and refetch, so without this the account only showed up because some other part of
 * the page happened to redraw.
 */
export async function loadMe(client: QueryClient): Promise<void> {
  // Never from cache: sign-out leaves a fresh "nobody" there.
  await client.fetchQuery({ queryKey: ["me"], queryFn: fetchMe, retry: false, staleTime: 0 });
}

export function useSignIn() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (handle: string) => api<{ token: string }>("/auth/paper", { body: { handle } }),
    onSuccess: async ({ token }) => {
      setToken(token);
      connectStream();
      await Promise.all([client.invalidateQueries(), loadMe(client)]);
      useUi.getState().setConnectOpen(false);
    },
    onError: (error) => useUi.getState().toast({ tone: "bad", title: "Could not start", detail: String((error as Error).message) }),
  });
}

/** Queries that hold one account's data. They are dropped at sign-out, so nothing of theirs stays on screen. */
const USER_QUERIES = new Set(["gifts", "portfolio", "activity", "watchlist", "rewards", "tracker", "admin"]);

export function signOut(client: QueryClient) {
  // Without this, Privy stays signed in and the wallet bridge signs straight back in on the next page load.
  void useUi.getState().wallet?.signOut().catch(() => {});
  setToken(null);
  connectStream();
  client.setQueryData(["me"], null);
  client.removeQueries({ predicate: (query) => USER_QUERIES.has(String(query.queryKey[0])) });
  useUi.getState().clearReveals();
  void client.invalidateQueries();
}

const CLAIM_MESSAGE: Record<string, string> = {
  insufficient_funds: "Not enough USDC for this card",
  minimum_balance: "Fund at least $5 to buy",
  cooldown: "Cooling down after your last buy",
  active_claim: "Your last win is still settling",
  not_found: "That card is gone",
  drops_paused: "Buying is paused right now",
  price_moved: "The price jumped, try again",
};

/** Wired once in the shell. Turns live account events into toasts and reveals. */
export function useUserEvents() {
  const client = useQueryClient();
  const pending = useRef(new Map<string, { paid: number; label: string }>());

  useEffect(() => {
    // One pack is a few events and a hundred packs is hundreds, and each used to refetch the account by itself.
    // What went out of date is collected here and refetched once, a moment later.
    const stale = new Set<string>();
    let flush: ReturnType<typeof setTimeout> | null = null;
    const refresh = (...keys: string[]) => {
      for (const key of keys) stale.add(key);
      flush ??= setTimeout(() => {
        flush = null;
        const due = [...stale];
        stale.clear();
        for (const key of due) void client.invalidateQueries({ queryKey: [key] });
      }, 400);
    };

    const off = onUserEvent((event) => {
      const { toast, setReveal } = useUi.getState();
      refresh("me");
      if (event.type === "gift") {
        refresh("gifts");
        toast({ tone: "win", title: "You won a gift pack", detail: "Claim it from the banner at the top" });
      }
      if (event.type === "claim") {
        if (event.state === "settled") {
          refresh("portfolio");
          const drop = event.drop as (Drop & { insuredValue: number; card: Drop["card"] }) | undefined;
          const memo = pending.current.get(String(event.dropId));
          if (drop?.card) setReveal({ card: drop.card, insuredValue: drop.insuredValue, paid: memo?.paid ?? drop.price ?? 0, rarity: drop.rarity, label: "You caught it" });
        }
        if (event.state === "voided") toast({ tone: "bad", title: "Snipe failed", detail: String(event.reason ?? "The drop went back on sale") });
        if (event.state === "refunded") toast({ tone: "info", title: "Refunded", detail: "The pack could not open, so your USDC came back" });
      }
      if (event.type === "order" && (event.state === "done" || event.state === "failed")) {
        refresh("portfolio", "activity");
        // Bought or not, the listing has changed, so Market and the card page must not keep showing its Buy button.
        if (event.kind === "market_buy") refresh("listings", "card");
        const result = (event.result ?? {}) as Record<string, unknown>;
        if (event.state === "failed") toast({ tone: "bad", title: "Order failed", detail: String(event.error ?? "") });
        else if (event.kind === "gacha_open") {
          setReveal({
            card: (result.card ?? {}) as Drop["card"] & object, insuredValue: result.insuredValue as number, paid: 0,
            rarity: result.rarity as string, label: "Pack opened", soldBack: result.turboBuyback as number | null,
          });
        } else if (event.kind === "market_buy") toast({ tone: "ok", title: "Bought", detail: String(result.name ?? "") });
        else if (event.kind === "buyback") toast({ tone: "ok", title: "Sold back" });
        else if (event.kind === "list") toast({ tone: "ok", title: "Listed" });
        else if (event.kind === "send") toast({ tone: "ok", title: "Sent to your wallet" });
      }
      if (event.type === "limitOrder") {
        void client.invalidateQueries({ queryKey: ["pulse-card", event.dropId] });
        toast(event.state === "filled" ? { tone: "win", title: "Limit order filled", detail: "Settling to your wallet" } : { tone: "bad", title: "Limit order could not fill" });
      }
      if (event.type === "cashback") toast({ tone: "ok", title: "Cashback paid" });
    });
    return () => {
      off();
      if (flush) clearTimeout(flush);
    };
  }, [client]);
  return pending;
}

/** Cards with a buy in flight, so a double click sends one request. */
const sniping = new Set<string>();

/** Pack batches being sent right now, so a second press cannot send the same one again. */
const opening = new Set<string>();

/**
 * One key per batch the user meant to open. If the answer never arrives (a dropped connection), pressing again
 * sends the same key, and the server hands back the packs it already placed instead of charging for a second batch.
 * A key is forgotten once the server has answered, or after a few minutes, when a press is a new batch again.
 */
const openKeys = new Map<string, { key: string; at: number }>();
const OPEN_KEY_MS = 5 * 60_000;

export function useTrade() {
  const client = useQueryClient();
  const me = useMe();
  const { toast, setConnectOpen } = useUi.getState();

  const guarded = useCallback(() => {
    if (me) return true;
    setConnectOpen(true);
    return false;
  }, [me, setConnectOpen]);

  const fail = (error: unknown) => toast({ tone: "bad", title: "Could not do that", detail: error instanceof Error ? error.message : String(error) });

  const snipe = useCallback(
    async (drop: { id: string }, maxPrice?: number) => {
      if (!guarded()) return;
      if (sniping.has(drop.id)) return;
      sniping.add(drop.id);
      let won = false;
      try {
        // First click wins at the price that second, so a one-click buy sends no price limit. The one exception is
        // a caller whose price has stopped updating (the live feed is down): it passes the price it shows as the most to pay.
        const result = await api<{ status: string; reason?: string; message?: string; retryInSec?: number; price?: number }>(`/drops/${drop.id}/claim`, {
          body: { idempotencyKey: newKey(), maxPrice: maxPrice === undefined ? undefined : Math.round(maxPrice) },
        });
        won = result.status === "won";
        if (won) toast({ tone: "win", title: `You got it for ${formatUsd(result.price ?? 0)}`, detail: "Settling to your wallet" });
        else if (result.status === "lost") toast({ tone: "info", title: "Too slow", detail: "Someone beat you to it" });
        else if (result.reason === "price_moved" && maxPrice !== undefined) toast({ tone: "bad", title: "The price has gone up", detail: "Live prices are reconnecting. Try again in a moment." });
        else toast({ tone: "bad", title: result.message ?? CLAIM_MESSAGE[result.reason ?? ""] ?? "Could not snipe", detail: result.retryInSec ? `Ready in ${result.retryInSec}s` : undefined });
        void client.invalidateQueries({ queryKey: ["me"] });
      } catch (error) {
        fail(error);
      } finally {
        // A won card keeps its Buy button until the feed marks it sold. The guard stays for that moment, so a second
        // click is not answered "too slow" by the buyer's own win.
        if (won) setTimeout(() => sniping.delete(drop.id), 3000);
        else sniping.delete(drop.id);
      }
    },
    [client, guarded],
  );

  const buy = useCallback(
    async (listing: Pick<Listing, "nft" | "price" | "name">) => {
      if (!guarded()) return;
      try {
        await api("/orders/buy", { body: { nft: listing.nft, price: listing.price, idempotencyKey: newKey() } });
        toast({ tone: "info", title: "Buying", detail: listing.name.slice(0, 60) });
      } catch (error) {
        fail(error);
      }
    },
    [guarded],
  );

  const open = useCallback(
    async (machine: Pick<Machine, "code" | "shortName">, opts: { turbo?: boolean; count?: number } = {}) => {
      if (!guarded()) return;
      const count = opts.count ?? 1;
      const batch = `${machine.code}:${count}:${opts.turbo ? "turbo" : "plain"}`;
      if (opening.has(batch)) return;
      opening.add(batch);
      const kept = openKeys.get(batch);
      const idempotencyKey = kept && Date.now() - kept.at < OPEN_KEY_MS ? kept.key : newKey();
      openKeys.set(batch, { key: idempotencyKey, at: Date.now() });
      try {
        const { orderIds } = await api<{ orderIds: string[] }>("/orders/open", { body: { machine: machine.code, turbo: opts.turbo, count, idempotencyKey } });
        openKeys.delete(batch);
        // The server stops placing packs when the balance runs out, and still answers OK with the ones it placed.
        if (orderIds.length < count) toast({ tone: "info", title: `Opening ${orderIds.length} of ${count} packs`, detail: "Not enough USDC for the rest" });
        else toast({ tone: "info", title: count === 1 ? "Opening your pack" : `Opening ${count} packs`, detail: machine.shortName ?? undefined });
      } catch (error) {
        fail(error);
      } finally {
        opening.delete(batch);
      }
    },
    [guarded],
  );

  /** Resolves true when the sale, listing or send went through, false when it failed or the wallet prompt was refused. */
  const holding = useCallback(async (action: "buyback" | "list" | "send", holdingId: string, extra: { nft?: string; price?: number; inMainWallet?: boolean } = {}): Promise<boolean> => {
    const { setBusy } = useUi.getState();
    setBusy([holdingId], true);
    try {
      const wallet = useUi.getState().wallet;
      if (action === "buyback" && extra.inMainWallet && wallet) {
        const { transaction } = await api<{ transaction: string }>(`/holdings/${holdingId}/buyback-tx`, { body: {} });
        const me = client.getQueryData<{ connectedWallet?: string }>(["me"]);
        const signedTransaction = await wallet.signWithMain(transaction, me?.connectedWallet);
        await api(`/holdings/${holdingId}/buyback-submit`, { body: { signedTransaction } });
        toast({ tone: "ok", title: "Sold back", detail: "USDC is on its way to your trading wallet" });
        void client.invalidateQueries({ queryKey: ["portfolio"] });
        return true;
      }
      await api("/orders/holding", { body: { action, holdingId, nft: extra.nft, price: extra.price, idempotencyKey: newKey() } });
      return true;
    } catch (error) {
      fail(error);
      return false;
    } finally {
      setBusy([holdingId], false);
    }
  }, [client]);

  return { snipe, buy, open, holding };
}
