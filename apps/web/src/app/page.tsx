"use client";

import { Lock, Sparkles, Timer } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Button, Empty, Skeleton } from "@/components/bits";
import { Board } from "@/components/Board";
import { FinalRow, PulseRow } from "@/components/market";
import { BuySizeControl } from "@/components/BuySize";
import { ColumnFilter } from "@/components/PulseFilters";
import { clock, pauseReason } from "@/lib/format";
import { useLive } from "@/lib/live";
import { phaseOf, usePulse } from "@/lib/pulse";
import { EMPTY_FILTER, filterCount, matches, usePulseFilters } from "@/lib/pulseFilters";
import { useNow } from "@/lib/ui";

const VISIBLE = 60;

function NoMatch({ column }: { column: string }) {
  const reset = usePulseFilters((s) => s.reset);
  return (
    <Empty title="No cards match">
      <p>Your filters hide every card in this column.</p>
      <div className="mt-3"><Button onClick={() => reset(column)}>Reset filters</Button></div>
    </Empty>
  );
}

export default function PulsePage() {
  const cards = usePulse((s) => s.cards);
  const ready = usePulse((s) => s.ready);
  const newPullSec = usePulse((s) => s.newPullSec);
  const filters = usePulseFilters((s) => s.filters);
  const status = useLive((s) => s.status);
  const now = useNow();
  const next = status?.nextDropAt ? (new Date(status.nextDropAt).getTime() - now) / 1000 : null;

  useEffect(() => usePulseFilters.getState().load(), []);

  const columns = useMemo(() => {
    const items = Object.values(cards);
    const inPhase = (phase: string) => items.filter((c) => phaseOf(c, now, newPullSec) === phase);
    const when = (time: string | null) => (time ? new Date(time).getTime() : 0);
    return {
      new: inPhase("new").sort((a, b) => b.number - a.number),
      // Older cards climb the column, so the top is always the next to lock.
      live: inPhase("live").sort((a, b) => a.number - b.number),
      final: inPhase("final").sort((a, b) => when(b.stoppedAt ?? b.movesUntil) - when(a.stoppedAt ?? a.movesUntil)),
    };
  }, [cards, newPullSec, now]);

  const shown = (key: keyof typeof columns) => {
    const filter = filters[key] ?? EMPTY_FILTER;
    return filterCount(filter) ? columns[key].filter((card) => matches(card, filter)) : columns[key];
  };
  const fresh = shown("new");
  const live = shown("live");
  const final = shown("final");

  const tools = (key: keyof typeof columns, title: string, rows: unknown[]) => (
    <div className="flex items-center gap-1">
      <span className="num text-[12.5px] text-faint">{rows.length === columns[key].length ? rows.length : `${rows.length}/${columns[key].length}`}</span>
      <BuySizeControl />
      <ColumnFilter column={key} title={title} cards={columns[key]} final={key === "final"} />
    </div>
  );
  const isFiltered = (key: keyof typeof columns) => filterCount(filters[key] ?? EMPTY_FILTER) > 0 && columns[key].length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h1 className="sr-only">Pulse</h1>
      <div className="flex shrink-0 items-center justify-end gap-1.5 px-3 pb-1.5 text-[13px] text-faint sm:hidden">
        <Timer size={14} className="text-gold" aria-hidden="true" />
        Next card
        <span className="num font-semibold text-gold">{status?.pausedFor ? "paused" : next !== null && next > 0 ? clock(next) : "soon"}</span>
      </div>
      <div className="min-h-0 flex-1">
        <Board
          columns={[
            {
              key: "new", title: "New Pulls", dot: "bg-teal", count: fresh.length, right: tools("new", "New Pulls", fresh),
              children: !ready ? <Skeleton /> : fresh.length > 0 ? fresh.slice(0, VISIBLE).map((card) => <PulseRow key={card.id} id={card.id} />) : isFiltered("new") ? <NoMatch column="new" /> : <Empty title={status?.pausedFor ? "New cards are paused" : "Waiting for a pull"} icon={<Sparkles size={22} aria-hidden="true" />}>{status?.pausedFor ? `Paused because ${pauseReason(status.pausedFor)}.` : "Fresh cards land here the moment a pack opens."}</Empty>,
            },
            {
              key: "live", title: "Live Prices", dot: "bg-volt", count: live.length, right: tools("live", "Live Prices", live),
              children: !ready ? <Skeleton /> : live.length > 0 ? live.slice(0, VISIBLE).map((card) => <PulseRow key={card.id} id={card.id} />) : isFiltered("live") ? <NoMatch column="live" /> : <Empty title="Nothing live yet" icon={<Timer size={22} aria-hidden="true" />}>Cards move here after their first minute. The oldest sits on top, closest to its lock.</Empty>,
            },
            {
              key: "final", title: "Final", count: final.length, right: tools("final", "Final", final),
              children: !ready ? <Skeleton /> : final.length > 0 ? final.slice(0, VISIBLE).map((card) => <FinalRow key={card.id} card={card} />) : isFiltered("final") ? <NoMatch column="final" /> : <Empty title="Nothing final yet" icon={<Lock size={22} aria-hidden="true" />}>Bought cards and locked prices land here.</Empty>,
            },
          ]}
        />
      </div>
    </div>
  );
}
