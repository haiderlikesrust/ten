"use client";

import { SERIES_STEP, shortAddress } from "@gemdex/core";
import { Clock3, Lock } from "lucide-react";
import Link from "next/link";
import { memo } from "react";
import { isTallBuy, useBuySize, type BuySize } from "@/lib/buySize";
import { cardTitle, clock, money, packLabel } from "@/lib/format";
import { useLive } from "@/lib/live";
import { changePct, usePulse, type PulseCard } from "@/lib/pulse";
import { useTrade } from "@/lib/session";
import { useNow } from "@/lib/ui";
import { BOLT, CardThumb, Grade, Pill, Rarity, rarityWash } from "./bits";

/**
 * A small price chart that stays still. Every point has a fixed place on a time axis, so the
 * line grows from left to right instead of squeezing and shifting on each tick.
 */
export function Sparkline({ card, now, width = 76, height = 24 }: { card: PulseCard; now: number; width?: number; height?: number }) {
  const moveSec = usePulse((s) => s.moveSec);
  const opened = new Date(card.opensAt).getTime();
  const end = card.stoppedAt ? new Date(card.stoppedAt).getTime() : now;
  const age = Math.max(0, Math.min(moveSec, (end - opened) / 1000));
  const span = card.stoppedAt ? Math.max(age, 10) : Math.min(moveSec, Math.max(60, Math.ceil((age + 1) / 60) * 60));
  const placed = card.series.map((price, i) => [Math.min(age, i * SERIES_STEP), price] as const);
  const all = [...placed, [age, card.price] as const];
  if (all.length < 2) return <div className="shrink-0" style={{ width, height }} />;

  const prices = all.map(([, price]) => price);
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const range = Math.max(max - min, max * 0.04);
  const middle = (max + min) / 2;
  const x = (second: number) => (second / span) * width;
  const y = (price: number) => height / 2 - ((price - middle) / range) * (height - 4);
  const line = all.map(([second, price]) => `${x(second).toFixed(1)},${y(price).toFixed(1)}`).join(" ");
  const color = card.price >= card.openPrice ? "var(--teal)" : "var(--loss)";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="shrink-0 overflow-visible">
      <polygon points={`0,${height} ${line} ${x(age).toFixed(1)},${height}`} fill={color} fillOpacity="0.1" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function PctBadge({ pct, big }: { pct: number; big?: boolean }) {
  const up = pct >= 0;
  return (
    <span className={`num whitespace-nowrap font-medium ${up ? "text-teal" : "text-loss"} ${big ? "text-[15px]" : "text-[12.5px]"}`}>
      {up ? "+" : ""}{Math.abs(pct) >= 1000 ? `${(pct / 1000).toFixed(1)}K` : pct.toFixed(1)}%
    </span>
  );
}

/** A hidden drop: the sealed Tenner pack. Size is the width of the card slot it fills. */
export function SealedThumb({ size }: { size: number }) {
  return (
    <div className="flex shrink-0 items-center justify-center" style={{ width: size, height: size * 1.34 }} aria-hidden="true">
      <img src="/pack.webp" alt="" decoding="async" className="max-h-full max-w-full object-contain" />
    </div>
  );
}

export const cardName = (card: PulseCard): string => (card.kind === "hidden" && !card.card ? "Sealed pack" : cardTitle(String(card.card?.name ?? "Graded card")));

const ROW_BUY: Record<BuySize, { box: string; label: string; price?: string }> = {
  s: { box: "h-7 gap-1.5 px-2.5", label: "text-[12px]" },
  m: { box: "h-9 gap-1.5 px-3.5", label: "text-[14px]" },
  l: { box: "w-full flex-col gap-1.5", label: "text-[13px]", price: "text-[17px]" },
};

const THUMB: Record<BuySize, number> = { s: 52, m: 52, l: 52 };

const TALL_COLUMN: Record<BuySize, string> = { s: "", m: "", l: "w-[104px]" };

/** The one action on Pulse. Whoever gets here first pays this price and gets the card. */
export function BuyButton({ card, size = "small" }: { card: PulseCard; size?: "small" | "big" }) {
  const { snipe } = useTrade();
  const rowSize = useBuySize((s) => s.size);
  const buy = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    // While the live feed is down the price on this button has stopped moving, and the real one may be far higher.
    // Then the buy goes through only at this price or less. With the feed up, first click wins at the price that second.
    void snipe(card, useLive.getState().connected ? undefined : card.price);
  };
  if (size === "big") {
    return (
      <button type="button" onClick={buy} aria-label={`Buy for ${money(card.price)}`} className="flex h-12 w-full items-center justify-center gap-2 px-cut bg-volt text-[16px] font-bold text-[var(--on-volt)] transition hover:brightness-105 active:scale-[0.99]">
        {BOLT} <span className="pixel text-[14px] uppercase leading-none">Buy for</span> <span className="num">{money(card.price)}</span>
      </button>
    );
  }
  const look = ROW_BUY[rowSize];
  return (
    <button type="button" onClick={buy} aria-label={`Buy ${cardName(card)} for ${money(card.price)}`} className={`flex min-h-11 items-center justify-center px-cut bg-volt text-[var(--on-volt)] transition hover:brightness-105 active:scale-[0.97] sm:min-h-0 ${look.box}`}>
      <span className="flex items-center gap-1.5">{BOLT} <span className={`pixel uppercase leading-none ${look.label}`}>Buy</span></span>
      {look.price ? <span className={`num font-bold leading-none ${look.price}`}>{money(card.price, true)}</span> : null}
    </button>
  );
}

/** The large Buy sizes: fills the height of the row, however tall the card makes it. */
function TallBuy({ card, size }: { card: PulseCard; size: BuySize }) {
  return <div className={`flex shrink-0 py-2 pr-2 ${TALL_COLUMN[size]}`}><BuyButton card={card} /></div>;
}

export const PulseRow = memo(function PulseRow({ id }: { id: string }) {
  const card = usePulse((s) => s.cards[id]);
  const buySize = useBuySize((s) => s.size);
  const now = useNow();
  if (!card) return null;
  const tall = isTallBuy(buySize);
  const name = cardName(card);
  const end = card.movesUntil ? new Date(card.movesUntil).getTime() : now;
  const start = new Date(card.opensAt).getTime();
  const left = Math.max(0, (end - now) / 1000);
  const progress = Math.max(0, Math.min(100, ((end - now) / Math.max(1, end - start)) * 100));
  const nearLock = left < 45;
  const hidden = card.kind === "hidden";
  const pct = <PctBadge pct={changePct(card.price, card.openPrice)} />;
  return (
    <Link href={`/live/${card.id}`} className={`tile flex overflow-hidden ${rarityWash(card.rarity)}`}>
      <div className="flex min-w-0 flex-1 gap-2.5 p-2.5">
        {hidden ? <SealedThumb size={THUMB[buySize]} /> : <CardThumb src={card.card?.image} alt={name} size={THUMB[buySize]} zoom />}
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <div className="min-w-0 truncate text-[15px] font-semibold leading-snug">{name}</div>
            <div className="flex shrink-0 items-baseline gap-2">
              {tall ? null : <div className="num text-[16px] font-semibold leading-snug">{money(card.price, true)}</div>}
              {pct}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1 overflow-hidden">
              {hidden ? <Pill tone="warn">Hidden</Pill> : <Rarity rarity={card.rarity} />}
              <Grade grader={card.card?.grader} grade={card.card?.grade} />
            </div>
          </div>
          <div className={`flex items-center gap-x-2.5 gap-y-1 ${tall ? "flex-wrap" : ""}`}>
            <Sparkline card={card} now={now} />
            <div className="flex flex-wrap items-center gap-x-2.5">
              <span className="num whitespace-nowrap text-[12px] text-faint">IV {hidden ? "???" : money(card.insuredValue, true)}</span>
              <span className={`num flex items-center gap-1 whitespace-nowrap text-[12px] ${nearLock ? "font-medium text-loss" : "text-faint"}`}>
                <Clock3 size={11} aria-hidden="true" /> {clock(left)}
              </span>
            </div>
            {tall ? null : <div className="ml-auto shrink-0"><BuyButton card={card} /></div>}
          </div>
        </div>
      </div>
      {tall ? <TallBuy card={card} size={buySize} /> : null}
      <div className="absolute inset-x-0 bottom-0 h-[2px] bg-bone/[0.05]" role="presentation">
        <div className={`h-full transition-[width] duration-1000 ease-linear ${nearLock ? "bg-loss" : "bg-bone/30"}`} style={{ width: `${progress}%` }} />
      </div>
    </Link>
  );
});

export function FinalRow({ card }: { card: PulseCard }) {
  const buySize = useBuySize((s) => s.size);
  const now = useNow();
  const name = cardName(card);
  const hidden = card.kind === "hidden" && !card.card;
  const sold = !!card.boughtBy;
  const vsValue = card.insuredValue ? card.price / card.insuredValue : null;
  const tall = isTallBuy(buySize) && !sold;
  return (
    <Link href={`/live/${card.id}`} className={`tile flex ${rarityWash(card.rarity)}`}>
      <div className="flex min-w-0 flex-1 gap-2.5 p-2.5">
      {hidden ? <SealedThumb size={THUMB[buySize]} /> : <CardThumb src={card.card?.image} alt={name} size={THUMB[buySize]} zoom />}
      <div className="flex min-w-0 flex-1 flex-col justify-between gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 truncate text-[15px] font-semibold leading-snug">{name}</div>
          {tall ? null : <div className="num shrink-0 text-[16px] font-semibold leading-snug">{money(card.price, true)}</div>}
        </div>
        <div className="flex items-center justify-between gap-2">
          {sold ? (
            <div className="min-w-0 truncate text-[12.5px] text-faint">Bought by <span className="num font-medium text-mute">{shortAddress(card.boughtBy)}</span></div>
          ) : (
            <div className="flex min-w-0 items-center gap-1 truncate text-[12.5px] text-faint"><Lock size={11} className="shrink-0 text-gold" aria-hidden="true" /> Price locked</div>
          )}
          {vsValue !== null ? <span className={`num shrink-0 text-[12.5px] font-medium ${vsValue <= 1 ? "text-teal" : "text-loss"}`}>{vsValue.toFixed(2)}x IV</span> : null}
        </div>
        <div className={`flex items-center gap-x-2.5 gap-y-1 ${tall ? "flex-wrap" : ""}`}>
          <Sparkline card={card} now={now} />
          <div className="flex min-w-0 items-center gap-1 overflow-hidden">
            <Grade grader={card.card?.grader} grade={card.card?.grade} />
            <span className="truncate text-[12px] text-faint">{packLabel(card.machineCode)}</span>
          </div>
          {tall ? null : <div className="ml-auto shrink-0">{sold ? <Pill tone="good">Sold</Pill> : <BuyButton card={card} />}</div>}
        </div>
      </div>
      </div>
      {tall ? <TallBuy card={card} size={buySize} /> : null}
    </Link>
  );
}
