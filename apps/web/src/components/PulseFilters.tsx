"use client";

import { Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { packLabel } from "@/lib/format";
import { useMediaQuery } from "@/lib/media";
import type { PulseCard } from "@/lib/pulse";
import { EMPTY_FILTER, filterCount, usePulseFilters, type PulseFilter } from "@/lib/pulseFilters";
import { Button, Segmented, Sheet, Toggle, inputClass } from "./bits";

const RARITIES = ["common", "uncommon", "rare", "epic"];
const STATUS_BAR = 60;

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={`h-7 min-h-11 shrink-0 px-cut px-2.5 text-[13px] font-medium capitalize transition-colors sm:min-h-0 ${active ? "bg-bone text-ink" : "bg-raised text-mute hover:bg-raised-2 hover:text-bone"}`}>
      {children}
    </button>
  );
}

/** One line per filter: the label on the left, the control on the right. */
function Row({ label, name, top, children }: { label: string; name?: string; top?: boolean; children: ReactNode }) {
  return (
    <div role="group" aria-label={name ?? label} className={`grid min-w-0 grid-cols-[60px_minmax(0,1fr)] gap-2 ${top ? "items-start" : "items-center"}`}>
      <span className={`text-[12.5px] font-medium text-faint ${top ? "pt-1.5" : ""}`}>{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Range({ low, high, onLow, onHigh, label }: { low: string; high: string; onLow: (value: string) => void; onHigh: (value: string) => void; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <input className={`${inputClass} !h-9`} inputMode="decimal" placeholder="Min" aria-label={`${label} minimum`} value={low} onChange={(e) => onLow(e.target.value)} />
      <span className="text-faint">to</span>
      <input className={`${inputClass} !h-9`} inputMode="decimal" placeholder="Max" aria-label={`${label} maximum`} value={high} onChange={(e) => onHigh(e.target.value)} />
    </div>
  );
}

function FilterForm({ column, title, cards, final, onDone }: { column: string; title: string; cards: PulseCard[]; final?: boolean; onDone: () => void }) {
  const filter = usePulseFilters((s) => s.filters[column]) ?? EMPTY_FILTER;
  const patch = usePulseFilters((s) => s.patch);
  const reset = usePulseFilters((s) => s.reset);
  const applyToAll = usePulseFilters((s) => s.applyToAll);
  const set = (change: Partial<PulseFilter>) => patch(column, change);
  const flip = (key: "rarities" | "graders" | "packs", value: string) => set({ [key]: filter[key].includes(value) ? filter[key].filter((item) => item !== value) : [...filter[key], value] });

  // Offers what is on the board now, plus anything already picked.
  const graders = useMemo(() => [...new Set([...cards.map((c) => String(c.card?.grader ?? "")).filter(Boolean), ...filter.graders])].sort(), [cards, filter.graders]);
  const packs = useMemo(() => [...new Set([...cards.map((c) => c.machineCode), ...filter.packs])].sort(), [cards, filter.packs]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3.5 pt-1">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute z-10 left-3 top-1/2 -translate-y-1/2 text-faint" aria-hidden="true" />
          <input className={`${inputClass} !h-9 pl-9`} placeholder="Card name" aria-label={`Search ${title}`} value={filter.q} onChange={(e) => set({ q: e.target.value })} />
        </div>
        <Row label="Type">
          <Segmented label="Type" value={filter.kind} onChange={(kind) => set({ kind })} options={[{ value: "all", label: "All" }, { value: "revealed", label: "Shown" }, { value: "hidden", label: "Hidden" }]} />
        </Row>
        {final ? (
          <Row label="Status">
            <Segmented label="Status" value={filter.status} onChange={(status) => set({ status })} options={[{ value: "all", label: "All" }, { value: "sold", label: "Sold" }, { value: "open", label: "For sale" }]} />
          </Row>
        ) : null}
        <Row label="Rarity" top>
          <div className="flex flex-wrap gap-1">
            {RARITIES.map((rarity) => <Chip key={rarity} active={filter.rarities.includes(rarity)} onClick={() => flip("rarities", rarity)}>{rarity}</Chip>)}
          </div>
        </Row>
        {graders.length > 0 ? (
          <Row label="Grader" top>
            <div className="flex flex-wrap gap-1">
              {graders.map((grader) => <Chip key={grader} active={filter.graders.includes(grader)} onClick={() => flip("graders", grader)}>{grader}</Chip>)}
            </div>
          </Row>
        ) : null}
        {packs.length > 0 ? (
          <Row label="Pack" top>
            <div className="flex flex-wrap gap-1">
              {packs.map((pack) => <Chip key={pack} active={filter.packs.includes(pack)} onClick={() => flip("packs", pack)}>{packLabel(pack)}</Chip>)}
            </div>
          </Row>
        ) : null}
        <Row label="Grade" name="Lowest grade">
          <input className={`${inputClass} !h-9`} inputMode="decimal" placeholder="Lowest, such as 9" aria-label="Lowest grade" value={filter.minGrade} onChange={(e) => set({ minGrade: e.target.value })} />
        </Row>
        <Row label="Price">
          <Range label="Price" low={filter.minPrice} high={filter.maxPrice} onLow={(minPrice) => set({ minPrice })} onHigh={(maxPrice) => set({ maxPrice })} />
        </Row>
        <Row label="Insured" name="Insured value">
          <Range label="Insured value" low={filter.minValue} high={filter.maxValue} onLow={(minValue) => set({ minValue })} onHigh={(maxValue) => set({ maxValue })} />
        </Row>
        <Toggle checked={filter.belowValue} onChange={(belowValue) => set({ belowValue })}>Priced below insured value</Toggle>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-t border-line p-2">
        <Button tone="ghost" className="h-8 px-2 text-[13px]" onClick={() => reset(column)}>Reset</Button>
        <Button tone="ghost" className="h-8 px-2 text-[13px]" onClick={() => applyToAll(column)}>Use on all</Button>
        <Button className="ml-auto h-8 text-[13px]" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

/** The filter button in a column's header. Each column keeps its own filters. */
export function ColumnFilter({ column, title, cards, final }: { column: string; title: string; cards: PulseCard[]; final?: boolean }) {
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState(480);
  const box = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery("(min-width: 640px)");
  const count = filterCount(usePulseFilters((s) => s.filters[column]) ?? EMPTY_FILTER);

  useEffect(() => {
    if (!open || !wide) return;
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
  }, [open, wide]);

  const form = <FilterForm column={column} title={title} cards={cards} final={final} onDone={() => setOpen(false)} />;
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={`Filter ${title}${count ? `, ${count} on` : ""}`}
        aria-expanded={open}
        title={`Filter ${title}`}
        onClick={() => {
          // Fits between the button and the bottom bar, whatever else is on the screen.
          if (box.current) setRoom(window.innerHeight - box.current.getBoundingClientRect().bottom - STATUS_BAR);
          setOpen((v) => !v);
        }}
        className={`flex h-8 min-h-11 min-w-11 items-center justify-center gap-1 px-cut px-2 text-[13px] font-medium transition-colors sm:min-h-0 sm:min-w-0 ${open || count ? "bg-volt/15 text-gold" : "text-faint hover:bg-bone/[0.07] hover:text-bone"}`}
      >
        <SlidersHorizontal size={15} aria-hidden="true" />
        {count ? <span className="num">{count}</span> : null}
      </button>
      {open && wide ? (
        <div role="dialog" aria-label={`Filter ${title}`} style={{ maxHeight: room }} className="sheet slab absolute right-0 top-[calc(100%+6px)] z-30 flex w-[320px] flex-col [--px-line:var(--line-strong)]">
          <div className="flex h-10 shrink-0 items-center justify-between pl-3.5 pr-1.5">
            <span className="pixel truncate text-[13px] uppercase leading-none">Filter {title}</span>
            <button type="button" aria-label="Close filters" onClick={() => setOpen(false)} className="flex h-8 min-h-11 min-w-11 w-8 items-center justify-center px-cut text-faint hover:bg-bone/[0.07] hover:text-bone sm:min-h-0 sm:min-w-0"><X size={16} aria-hidden="true" /></button>
          </div>
          {form}
        </div>
      ) : null}
      {open && !wide ? <Sheet title={`Filter ${title}`} onClose={() => setOpen(false)}>{form}</Sheet> : null}
    </div>
  );
}
