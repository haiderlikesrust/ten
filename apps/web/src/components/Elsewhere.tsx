"use client";

import { gapPct, sourceInfo, type Elsewhere } from "@gemdex/core";
import { ExternalLink } from "lucide-react";
import { money } from "@/lib/format";
import type { Listing } from "@/lib/types";

/** The cheapest ask on any other platform, the one a trader compares against. */
export function bestElsewhere(listing: Listing): Elsewhere | null {
  let best: Elsewhere | null = null;
  for (const e of listing.elsewhere ?? []) if (e.ask !== null && (best === null || e.ask < best.ask!)) best = e;
  return best;
}

/**
 * The same card's price on another platform, next to Collector Crypt's. Read-only: the link opens that platform,
 * and Tenner never buys there. Green when Collector Crypt is cheaper.
 */
export function ElsewhereCell({ listing, gapFromXl = false }: { listing: Listing; /** Shows the gap only at xl width, where it fits. */ gapFromXl?: boolean }) {
  const best = bestElsewhere(listing);
  if (!best || best.ask === null) return <span className="text-faint">–</span>;
  const info = sourceInfo(best.source);
  const gap = gapPct(listing.price, best.ask);
  const what = best.match === "cert" ? "this exact slab (same cert)" : "the same card in the same grade";
  const title = `Cheapest of ${best.asks} ${info.label} buy-it-now listing${best.asks === 1 ? "" : "s"} for ${what}, shipping included. Opens ${info.label}; Tenner can't buy there.`;
  return (
    <a href={best.askUrl ?? undefined} target="_blank" rel="noopener noreferrer nofollow sponsored" title={title} className="group inline-flex min-w-0 items-center justify-end gap-1 whitespace-nowrap text-[12.5px]">
      <span className="text-faint">{info.short}</span>
      <span className="num font-medium text-mute group-hover:text-bone">{money(best.ask, true)}</span>
      {gap !== null && gap !== 0 ? <span className={`num text-[12px] ${gapFromXl ? "hidden xl:inline" : ""} ${gap > 0 ? "text-teal" : "text-loss"}`}>{gap > 0 ? "-" : "+"}{Math.abs(gap)}%</span> : null}
      <ExternalLink size={11} className="shrink-0 text-faint group-hover:text-bone" aria-hidden="true" />
    </a>
  );
}
