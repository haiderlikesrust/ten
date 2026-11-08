"use client";

import { accessMessage } from "@gemdex/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMe, useMeta } from "@/lib/session";
import { useUi } from "@/lib/ui";
import { Button } from "./bits";
import { PixelIcon } from "./pixel";

const tokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

/**
 * Shown while a signed-in user holds less $TENR than the access minimum (docs/FLYWHEEL.md): what they
 * hold, what they need, and where to get it. Browsing works without it; buying doesn't.
 */
export function AccessBanner() {
  const me = useMe();
  const meta = useMeta().data;
  const client = useQueryClient();
  const toast = useUi((s) => s.toast);
  const access = me?.access;
  // Paper mode is for testing: one click tops the test wallet up to the minimum.
  const topUp = useMutation({
    mutationFn: () => api("/rewards/paper-tokens", { body: { tokens: Math.ceil(access?.needed ?? 0) } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["me"] });
      toast({ tone: "ok", title: "Test $TENR added" });
    },
  });
  if (!access?.enforced || access.ok) return null;

  return (
    <div role="status" className="px-box mx-2 mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2 text-[13.5px] sm:mx-3">
      <span className="text-gold"><PixelIcon name="star" /></span>
      <span className="min-w-0 flex-1">
        <span className="font-semibold text-bone">{accessMessage(access)}, open packs and win gifts.</span>{" "}
        <span className="text-mute">
          You hold <span className="num text-bone">{tokens.format(access.held)}</span> of <span className="num text-bone">{tokens.format(access.needed)}</span>.
        </span>
      </span>
      {meta?.paper ? (
        <Button tone="snipe" className="h-8 px-3 text-[12px]" disabled={topUp.isPending} onClick={() => topUp.mutate()}>
          Get test $TENR
        </Button>
      ) : meta?.tokenMint ? (
        <a href={`https://pump.fun/coin/${meta.tokenMint}`} target="_blank" rel="noreferrer noopener" className="pixel inline-flex h-8 items-center px-cut bg-volt px-3 text-[12px] uppercase leading-none text-[var(--on-volt)] hover:brightness-105">
          Buy $TENR
        </a>
      ) : null}
    </div>
  );
}
