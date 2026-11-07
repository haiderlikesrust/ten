"use client";

import { useEffect, useRef, useState } from "react";
import { BUY_SIZES, isTallBuy, useBuySize, type BuySize } from "@/lib/buySize";
import { money } from "@/lib/format";
import { useTrade } from "@/lib/session";
import type { Listing } from "@/lib/types";
import { BOLT, Segmented } from "./bits";

/** In a table row. Large sizes stack, so the height is what grows. */
const QUICK: Record<BuySize, string> = {
  s: "h-7 min-w-[76px] gap-1 text-[12.5px]",
  m: "h-8 min-w-[88px] gap-1 text-[13.5px]",
  l: "h-14 min-w-[104px] flex-col gap-1 text-[16px]",
  xl: "h-[84px] min-w-[120px] flex-col gap-1.5 text-[20px]",
};

/** On a tile, where the button already has the full width. */
const QUICK_WIDE: Record<BuySize, string> = {
  s: "h-7 w-full gap-1 text-[12.5px]",
  m: "h-8 w-full gap-1 text-[13.5px]",
  l: "h-11 w-full gap-1.5 text-[15px]",
  xl: "h-14 w-full gap-1.5 text-[17px]",
};

/** One-click marketplace buy, with the price on the button. Follows the chosen size. */
export function QuickBuy({ listing, wide }: { listing: Listing; wide?: boolean }) {
  const { buy } = useTrade();
  const size = useBuySize((s) => s.size);
  const stacked = isTallBuy(size) && !wide;
  return (
    <button
      type="button"
      onClick={() => void buy(listing)}
      aria-label={`Buy ${listing.name} for ${money(listing.price)}`}
      className={`num flex shrink-0 items-center justify-center whitespace-nowrap px-cut bg-teal/15 px-2 font-semibold text-teal transition-colors hover:bg-teal hover:text-ink active:scale-[0.97] ${wide ? QUICK_WIDE[size] : QUICK[size]}`}
    >
      {stacked ? <span className="flex items-center gap-1">{BOLT} <span className="pixel text-[12px] uppercase leading-none">Buy</span></span> : BOLT}
      <span className={stacked ? "leading-none" : undefined}>{money(listing.price, true)}</span>
    </button>
  );
}

/** Lets each person choose how big their Buy buttons are. Remembered on this device. */
export function BuySizeControl() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const size = useBuySize((s) => s.size);
  const setSize = useBuySize((s) => s.set);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={`Buy button size, ${size.toUpperCase()}`}
        aria-expanded={open}
        title="Buy button size"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-8 items-center gap-1 px-cut px-1.5 transition-colors ${open ? "bg-volt/15 text-gold" : "text-faint hover:bg-bone/[0.07] hover:text-bone"}`}
      >
        {BOLT}
        <span className="pixel text-[11px] uppercase leading-none">{size}</span>
      </button>
      {open ? (
        <div role="dialog" aria-label="Buy button size" className="sheet slab absolute right-0 top-[calc(100%+6px)] z-30 w-[220px] p-3 [--px-line:var(--line-strong)]">
          <div className="pixel mb-2 text-[12px] uppercase leading-none">Buy button size</div>
          <Segmented label="Buy button size" value={size} onChange={setSize} options={BUY_SIZES.map(({ value, label }) => ({ value, label }))} />
          <p className="mt-2 text-[12.5px] text-faint">Applies on Pulse, Scanner and Market.</p>
        </div>
      ) : null}
    </div>
  );
}
