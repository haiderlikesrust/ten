"use client";

import { shortAddress } from "@gemdex/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BadgeCheck, Clock3, Lock, X } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Button, CardThumb, Empty, Grade, Pill, Rarity, inputClass } from "@/components/bits";
import { BuyButton, PctBadge, SealedThumb, cardName } from "@/components/market";
import { MarketChart } from "@/components/MarketChart";
import { api } from "@/lib/api";
import { clock, money, packLabel } from "@/lib/format";
import { changePct, usePulse, type PulseCard } from "@/lib/pulse";
import { useMe } from "@/lib/session";
import { useNow, useUi } from "@/lib/ui";
import { sized } from "@/lib/image";

interface CardData {
  drop: PulseCard;
  prices: number[];
  limit: { id: string; maxPrice: number } | null;
}

function HeaderStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[12px] font-medium text-faint">{label}</div>
      <div className={`num truncate text-[15px] font-semibold leading-snug ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

const QUICK_DROPS = [10, 25, 50];

/** An order to buy the second the price falls to a number. Teal, like its dotted line on the chart. */
function LimitOrder({ card, limit, refresh }: { card: PulseCard; limit: CardData["limit"]; refresh: () => void }) {
  const me = useMe();
  const toast = useUi((s) => s.toast);
  const [value, setValue] = useState("");
  const set = useMutation({
    mutationFn: () => api(`/pulse/drops/${card.id}/limit`, { body: { maxPrice: Math.round(Number(value) * 1e6) } }),
    onSuccess: () => {
      setValue("");
      toast({ tone: "ok", title: "Limit order set" });
      refresh();
    },
    onError: (error) => toast({ tone: "bad", title: "Could not set that", detail: (error as Error).message }),
  });
  const clear = useMutation({ mutationFn: () => api(`/pulse/drops/${card.id}/limit`, { method: "DELETE" }), onSuccess: refresh });
  if (!me) return null;

  // How far under the live price a number sits, so it's clear how big a drop it waits for.
  const below = (micros: number) => Math.round((1 - micros / card.price) * 100);

  if (limit) {
    const gap = below(limit.maxPrice);
    return (
      <div className="flex items-center gap-3 border-t border-line pt-3">
        <div className="flex min-w-0 flex-1 items-center gap-3 px-cut border border-teal/40 bg-teal/10 px-3 py-2.5" role="status">
          <div className="min-w-0 flex-1">
            <div className="pixel text-[11px] uppercase leading-none text-teal">Limit order open</div>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
              <span className="num text-[20px] font-bold leading-none">{money(limit.maxPrice)}</span>
              <span className="num text-[12.5px] text-faint">{gap > 0 ? `${gap}% below now` : "buys at the next tick"}</span>
            </div>
          </div>
          <button type="button" aria-label="Cancel limit order" title="Cancel limit order" onClick={() => clear.mutate()} className="flex h-8 w-8 shrink-0 items-center justify-center px-cut text-mute hover:bg-bone/[0.07] hover:text-loss"><X size={16} aria-hidden="true" /></button>
        </div>
      </div>
    );
  }

  const target = Math.round(Number(value) * 1e6);
  const ready = target > 0 && !set.isPending;
  const picks = QUICK_DROPS.map((pct) => ({ pct, value: ((card.price * (1 - pct / 100)) / 1e6).toFixed(2) }));
  return (
    <form
      className="flex flex-col gap-2 border-t border-line pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) set.mutate();
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="pixel text-[12px] uppercase leading-none">Limit order</span>
        <span className="truncate text-[12px] text-faint">Buys the second it falls to your price</span>
      </div>
      <div className="flex gap-1" role="group" aria-label="Quick limit prices">
        {picks.map((pick) => (
          <button
            key={pick.pct}
            type="button"
            onClick={() => setValue(pick.value)}
            aria-pressed={value === pick.value}
            className={`num h-8 flex-1 px-cut text-[12.5px] font-semibold transition-colors ${value === pick.value ? "bg-teal/20 text-teal" : "bg-raised text-mute hover:text-bone"}`}
          >
            -{pick.pct}%
          </button>
        ))}
      </div>
      <div className="flex gap-1.5">
        <div className="relative min-w-0 flex-1">
          <span className="num pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-[14px] text-faint" aria-hidden="true">$</span>
          <input
            className={`${inputClass} num pl-6 pr-24`}
            inputMode="decimal"
            aria-label="Limit price"
            placeholder="Your price"
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
          />
          {target > 0 ? (
            <span className={`num pointer-events-none absolute right-3 top-1/2 z-10 -translate-y-1/2 text-[12px] ${below(target) > 0 ? "text-faint" : "text-gold"}`}>
              {below(target) > 0 ? `${below(target)}% below` : "buys now"}
            </span>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={!ready}
          className="pixel flex h-10 shrink-0 items-center px-cut bg-teal/15 px-4 text-[12px] uppercase leading-none text-teal transition-colors hover:bg-teal hover:text-ink disabled:cursor-not-allowed disabled:bg-raised disabled:text-faint"
        >
          Set
        </button>
      </div>
    </form>
  );
}

/** Says why a chart has stopped, in the toolbar where it can never cover the data. */
function ChartStatus({ card, locked }: { card: PulseCard; locked: boolean }) {
  if (!card.boughtBy && !locked) return null;
  return (
    <span className={`reveal flex h-9 min-w-0 items-center gap-1.5 px-cut border px-2.5 text-[13.5px] font-semibold text-bone ${card.boughtBy ? "border-teal/40 bg-teal/10" : "border-gold/40 bg-gold/10"}`}>
      {card.boughtBy ? <BadgeCheck size={16} className="shrink-0 text-teal" aria-hidden="true" /> : <Lock size={15} className="shrink-0 text-gold" aria-hidden="true" />}
      <span className="truncate">{card.boughtBy ? <>Bought by <span className="num">{shortAddress(card.boughtBy)}</span> for <span className="num">{money(card.price)}</span></> : <>Price locked at <span className="num">{money(card.price)}</span></>}</span>
    </span>
  );
}

function BuyAction({ card }: { card: PulseCard }) {
  const me = useMe();
  if (me) return <BuyButton card={card} size="big" />;
  return <Button tone="primary" className="h-14 w-full text-[15px]" onClick={() => useUi.getState().setConnectOpen(true)}>Connect to buy</Button>;
}

function BuyPanel({ card, limit, refresh }: { card: PulseCard; limit: CardData["limit"]; refresh: () => void }) {
  const me = useMe();
  const now = useNow();
  const name = cardName(card);
  const hidden = card.kind === "hidden" && !card.card;
  const sold = !!card.boughtBy;
  const moved = !!card.movesUntil && now >= new Date(card.movesUntil).getTime();
  const mine = sold && card.boughtBy === me?.connectedWallet;

  return (
    <section className="slab flex flex-col gap-3 self-start p-3.5">
      <div className="flex justify-center px-cut bg-bone/[0.04] p-3">
        {hidden ? <SealedThumb size={150} /> : card.card?.image ? <img src={sized(card.card.image as string, 180)} alt={name} className="max-h-[230px] px-cut object-contain" /> : null}
      </div>

      {sold ? (
        <div className="flex flex-col items-center gap-1.5 px-cut bg-teal/12 px-3 py-4 text-center">
          <BadgeCheck size={24} className="text-teal" aria-hidden="true" />
          <div className="text-[16px] font-bold">{mine ? "You got this card" : "Sold"}</div>
          <div className="text-mute">Bought by <span className="num font-semibold text-bone">{shortAddress(card.boughtBy)}</span></div>
          <div className="num text-[22px] font-bold">{money(card.price)}</div>
        </div>
      ) : (
        <>
          <div className="text-center">
            <div className="text-[13px] font-medium text-faint">{moved ? "Locked price" : "Price right now"}</div>
            <div className="num text-[34px] font-bold leading-tight">{money(card.price)}</div>
          </div>
          <div className="hidden lg:block"><BuyAction card={card} /></div>
          <p className="text-center text-[13px] text-faint">First click gets the card at the price that second. It goes straight to your connected wallet.</p>
          {!moved ? <LimitOrder card={card} limit={limit} refresh={refresh} /> : null}
          {me ? (
            <div className="flex justify-between text-[13px] text-faint">
              <span>Available</span>
              <span className="num text-mute">{money(me.available)}</span>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export default function LiveCardPage() {
  const { id } = useParams<{ id: string }>();
  const client = useQueryClient();
  const now = useNow();
  const query = useQuery({ queryKey: ["pulse-card", id], queryFn: () => api<CardData>(`/pulse/drops/${id}`), refetchInterval: 30_000 });
  const live = usePulse((s) => s.cards[id]);
  const moveSec = usePulse((s) => s.moveSec);

  if (query.isError) return <Empty title="Card not found">It may have been cleared after it finished.</Empty>;
  const data = query.data;
  if (!data) return <div className="p-6 text-faint">Loading card</div>;

  const card = live ?? data.drop;
  const name = cardName(card);
  const sold = !!card.boughtBy;
  const end = card.movesUntil ? new Date(card.movesUntil).getTime() : now;
  const left = Math.max(0, (end - now) / 1000);
  const locked = sold || left <= 0;
  const hidden = card.kind === "hidden" && !card.card;
  const refresh = () => void client.invalidateQueries({ queryKey: ["pulse-card", id] });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1360px] flex flex-col gap-2 px-2 pb-2 sm:px-3">
        <section className="slab p-3">
          <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
            <div className="flex min-w-0 flex-1 basis-[280px] items-center gap-3">
              <Link href="/" aria-label="Back to Pulse" className="flex h-10 w-10 shrink-0 items-center justify-center px-cut bg-raised text-mute hover:text-bone"><ArrowLeft size={18} aria-hidden="true" /></Link>
              {hidden ? <SealedThumb size={46} /> : <CardThumb src={card.card?.image} alt={name} size={46} />}
              <div className="min-w-0">
                <h1 className="truncate text-[17px] font-bold leading-tight tracking-tight sm:text-[19px]">{name}</h1>
                <div className="mt-1 flex items-center gap-1.5 overflow-hidden">
                  {hidden ? <Pill tone="warn">Hidden</Pill> : <Rarity rarity={card.rarity} />}
                  <Grade grader={card.card?.grader} grade={card.card?.grade} />
                  <span className="truncate text-[13px] text-faint">{packLabel(card.machineCode)}</span>
                </div>
              </div>
            </div>
            <dl className="order-last grid w-full grid-cols-2 gap-x-6 gap-y-2.5 border-t border-line pt-3 sm:grid-cols-4 xl:order-none xl:w-auto xl:border-0 xl:pt-0">
              <HeaderStat label="Opened at" value={money(card.openPrice, true)} />
              <HeaderStat label="Insured value" value={hidden ? "???" : money(card.insuredValue, true)} tone="text-gold" />
              <HeaderStat label="High" value={money(card.high, true)} tone="text-teal" />
              <HeaderStat label="Low" value={money(card.low, true)} tone="text-loss" />
            </dl>
            <div className="flex items-center gap-4">
              <div>
                <div className="num text-[26px] font-bold leading-none">{money(card.price)}</div>
                <div className="mt-1"><PctBadge pct={changePct(card.price, card.openPrice)} /></div>
              </div>
              <div className={`flex items-center gap-2 px-cut px-3 py-2 ${sold ? "bg-teal/12" : locked ? "bg-bone/[0.07]" : left < 45 ? "bg-loss/15" : "bg-volt/15"}`}>
                {sold ? <BadgeCheck size={18} className="text-teal" aria-hidden="true" /> : locked ? <Lock size={18} className="text-gold" aria-hidden="true" /> : <Clock3 size={18} className={left < 45 ? "text-loss" : "text-gold"} aria-hidden="true" />}
                <div>
                  <div className="text-[12px] font-medium text-mute">{sold ? "Status" : locked ? "Status" : "Locks in"}</div>
                  <div className={`num text-[17px] font-bold leading-tight ${sold || locked ? "" : left < 45 ? "text-loss" : "text-gold"}`}>{sold ? "Sold" : locked ? "Locked" : clock(left)}</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="slab relative h-[380px] min-w-0 overflow-hidden sm:h-[480px] lg:h-[calc(100dvh-262px)] lg:min-h-[460px] xl:h-[calc(100dvh-204px)]" aria-label="Chart">
            <MarketChart key={card.id} card={card} prices={data.prices} limit={data.limit?.maxPrice ?? null} moveSec={moveSec} status={<ChartStatus card={card} locked={locked} />} />
          </section>
          <BuyPanel card={card} limit={data.limit} refresh={refresh} />
        </div>
        {!sold ? (
          <div className="sticky bottom-0 z-30 -mx-2 -mb-2 flex items-center gap-3 border-t border-line bg-surface/95 px-2 py-2 backdrop-blur sm:-mx-3 sm:px-3 lg:hidden">
            <div className="min-w-0 flex-1"><BuyAction card={card} /></div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
