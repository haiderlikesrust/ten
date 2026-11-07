"use client";

import { formatUsd } from "@gemdex/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api, ApiError, getToken, newKey, setToken } from "./api";
import { connectStream, onUserEvent } from "./live";
import type { Drop, Listing, Machine, Me, Meta } from "./types";
import { useUi } from "./ui";

export function useMeta() {
  return useQuery({ queryKey: ["meta"], queryFn: () => api<Meta>("/meta"), staleTime: 60_000 });
}

export function useMe() {
  const query = useQuery({
    queryKey: ["me"],
    enabled: typeof window !== "undefined" && !!getToken(),
    refetchInterval: 15_000,
    retry: false,
    queryFn: async () => {
      try {
        return await api<Me>("/me");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setToken(null);
          return null;
        }
        throw error;
      }
    },
  });
  return query.data ?? null;
}

export function useSignIn() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (handle: string) => api<{ token: string }>("/auth/paper", { body: { handle } }),
    onSuccess: async ({ token }) => {
      setToken(token);
      connectStream();
      await client.invalidateQueries();
      await client.refetchQueries({ queryKey: ["me"] });
      useUi.getState().setConnectOpen(false);
    },
    onError: (error) => useUi.getState().toast({ tone: "bad", title: "Could not start", detail: String((error as Error).message) }),
  });
}

export function signOut(client: ReturnType<typeof useQueryClient>) {
  setToken(null);
  connectStream();
  client.setQueryData(["me"], null);
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
    return onUserEvent((event) => {
      const { toast, setReveal } = useUi.getState();
      void client.invalidateQueries({ queryKey: ["me"] });
      if (event.type === "claim") {
        if (event.state === "settled") {
          void client.invalidateQueries({ queryKey: ["portfolio"] });
          const drop = event.drop as (Drop & { insuredValue: number; card: Drop["card"] }) | undefined;
          const memo = pending.current.get(String(event.dropId));
          if (drop?.card) setReveal({ card: drop.card, insuredValue: drop.insuredValue, paid: memo?.paid ?? drop.price ?? 0, rarity: drop.rarity, label: "You caught it" });
        }
        if (event.state === "voided") toast({ tone: "bad", title: "Snipe failed", detail: String(event.reason ?? "The drop went back on sale") });
        if (event.state === "refunded") toast({ tone: "info", title: "Refunded", detail: "The pack could not open, so your USDC came back" });
      }
      if (event.type === "order" && (event.state === "done" || event.state === "failed")) {
        void client.invalidateQueries({ queryKey: ["portfolio"] });
        void client.invalidateQueries({ queryKey: ["activity"] });
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
      if (event.type === "autoBuy") {
        void client.invalidateQueries({ queryKey: ["pulse-card", event.dropId] });
        toast(event.state === "filled" ? { tone: "win", title: "Auto-buy hit", detail: "Settling to your wallet" } : { tone: "bad", title: "Auto-buy could not fill" });
      }
      if (event.type === "cashback") toast({ tone: "ok", title: "Cashback paid" });
      if (event.type === "autoFire") toast({ tone: "info", title: `Auto-buy: ${String(event.rule)}`, detail: String(event.name ?? "") });
    });
  }, [client]);
  return pending;
}

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
    async (drop: { id: string }) => {
      if (!guarded()) return;
      try {
        // First click wins at the price that second, so a one-click buy sends no price limit.
        const result = await api<{ status: string; reason?: string; retryInSec?: number; price?: number }>(`/drops/${drop.id}/claim`, { body: { idempotencyKey: newKey() } });
        if (result.status === "won") toast({ tone: "win", title: `You got it for ${formatUsd(result.price ?? 0)}`, detail: "Settling to your wallet" });
        else if (result.status === "lost") toast({ tone: "info", title: "Too slow", detail: "Someone beat you to it" });
        else toast({ tone: "bad", title: CLAIM_MESSAGE[result.reason ?? ""] ?? "Could not snipe", detail: result.retryInSec ? `Ready in ${result.retryInSec}s` : undefined });
        void client.invalidateQueries({ queryKey: ["me"] });
      } catch (error) {
        fail(error);
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
      try {
        await api("/orders/open", { body: { machine: machine.code, turbo: opts.turbo, count: opts.count ?? 1, idempotencyKey: newKey() } });
      } catch (error) {
        fail(error);
      }
    },
    [guarded],
  );

  const holding = useCallback(async (action: "buyback" | "list" | "send", holdingId: string, extra: { nft?: string; price?: number; inMainWallet?: boolean } = {}) => {
    try {
      const wallet = useUi.getState().wallet;
      if (action === "buyback" && extra.inMainWallet && wallet) {
        const { transaction } = await api<{ transaction: string }>(`/holdings/${holdingId}/buyback-tx`, { body: {} });
        const signedTransaction = await wallet.signWithMain(transaction);
        await api(`/holdings/${holdingId}/buyback-submit`, { body: { signedTransaction } });
        toast({ tone: "ok", title: "Sold back", detail: "USDC is on its way to your trading wallet" });
        void client.invalidateQueries({ queryKey: ["portfolio"] });
        return;
      }
      await api("/orders/holding", { body: { action, holdingId, nft: extra.nft, price: extra.price, idempotencyKey: newKey() } });
    } catch (error) {
      fail(error);
    }
  }, [client]);

  return { snipe, buy, open, holding };
}
