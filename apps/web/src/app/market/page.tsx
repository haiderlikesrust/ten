"use client";

import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, CardThumb, Empty, Field, Grade, Pill, Segmented, Sheet, inputClass } from "@/components/bits";
import { BuySizeControl, QuickBuy } from "@/components/BuySize";
import { useBuySize, type BuySize } from "@/lib/buySize";
import { api } from "@/lib/api";
import { ago, cardTitle, money } from "@/lib/format";
import { useTrade } from "@/lib/session";
import type { Listing } from "@/lib/types";
import { useNow } from "@/lib/ui";

interface Filters {
  search: string;
  category: string;
  grader: string;
  minGrade: string;
  minPrice: string;
  maxPrice: string;
  minDiscount: string;
  source: string;
  sort: string;
}

const EMPTY: Filters = { search: "", category: "", grader: "", minGrade: "", minPrice: "", maxPrice: "", minDiscount: "", source: "", sort: "newest" };
const PRESET_KEY = "gemdex.presets";
const SORTS = [
  { value: "newest", label: "Newest" },
  { value: "discount", label: "Best discount" },
  { value: "price_asc", label: "Cheapest" },
  { value: "price_desc", label: "Priciest" },
  { value: "value_desc", label: "Top value" },
];

function loadPresets(): Array<{ name: string; filters: Filters }> {
  try {
    return JSON.parse(localStorage.getItem(PRESET_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function savePresets(presets: Array<{ name: string; filters: Filters }>) {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  } catch {
    // Presets are a convenience, so a refusal is fine.
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return current;
}

/** Rows grow with the Buy button, and each one is 4px taller than it paints. */
const ROW_HEIGHT: Record<BuySize, number> = { s: 60, m: 60, l: 76, xl: 104 };
const THUMB: Record<BuySize, number> = { s: 32, m: 32, l: 44, xl: 64 };

const COLUMNS = "md:grid-cols-[var(--thumb)_minmax(0,1fr)_76px_52px_76px_76px_44px_auto] xl:grid-cols-[var(--thumb)_minmax(0,1.3fr)_minmax(0,1fr)_84px_60px_84px_84px_52px_124px]";

function MarketRow({ listing }: { listing: Listing }) {
  const now = useNow();
  const buySize = useBuySize((s) => s.size);
  const discount = listing.discountPct;
  const name = cardTitle(listing.name);
  const set = listing.set ?? listing.category;
  return (
    <div className={`tile grid h-full grid-cols-[var(--thumb)_minmax(0,1fr)_auto] items-center gap-x-3 px-2.5 ${COLUMNS}`}>
      <Link href={`/card/${listing.nft}`} aria-label={name}>
        <CardThumb src={listing.image} alt={name} size={THUMB[buySize]} zoom />
      </Link>
      <div className="min-w-0">
        <Link href={`/card/${listing.nft}`} className="block truncate text-[14px] font-semibold hover:text-gold">{name}</Link>
        <div className="truncate text-[12.5px] text-faint xl:hidden">{set}</div>
        <div className="mt-1 flex items-center gap-1 md:hidden">
          <Grade grader={listing.grader} grade={listing.grade} />
          {discount !== null && discount !== 0 ? <Pill tone={discount > 0 ? "good" : "bad"}>{discount > 0 ? "-" : "+"}{Math.abs(discount)}%</Pill> : null}
        </div>
      </div>
      <div className="hidden min-w-0 truncate text-[13px] text-faint xl:block">{set}</div>
      <div className="hidden md:block"><Grade grader={listing.grader} grade={listing.grade} /></div>
      <div className="num hidden text-[13px] text-faint md:block">{listing.year ?? "–"}</div>
      <div className="num hidden text-right text-[13px] text-mute md:block">{money(listing.insuredValue, true)}</div>
      <div className="hidden text-right md:block">
        {discount !== null && discount !== 0 ? <Pill tone={discount > 0 ? "good" : "bad"}>{discount > 0 ? "-" : "+"}{Math.abs(discount)}%</Pill> : <span className="text-faint">–</span>}
      </div>
      <div className="num hidden text-right text-[12.5px] text-faint md:block">{ago(listing.listedAt, now)}</div>
      <div className="flex justify-end"><QuickBuy listing={listing} /></div>
    </div>
  );
}

export default function MarketPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [presets, setPresets] = useState<Array<{ name: string; filters: Filters }>>([]);
  const [sheet, setSheet] = useState(false);
  const debounced = useDebounced(filters, 250);
  const parent = useRef<HTMLDivElement>(null);
  useEffect(() => setPresets(loadPresets()), []);

  const facets = useQuery({
    queryKey: ["facets"],
    queryFn: () => api<{ categories: Array<{ value: string; n: number }>; graders: Array<{ value: string; n: number }> }>("/listings/facets"),
  });
  const query = useQuery({
    queryKey: ["listings", debounced],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "500" });
      for (const [key, value] of Object.entries(debounced)) if (value) params.set(key, value);
      return api<{ rows: Listing[]; total: number }>(`/listings?${params}`);
    },
    refetchInterval: 20_000,
  });
  const rows = query.data?.rows ?? [];
  const buySize = useBuySize((s) => s.size);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => ROW_HEIGHT[buySize], overscan: 8 });
  useEffect(() => virtual.measure(), [buySize, virtual]);
  const update = (key: keyof Filters, value: string) => setFilters((f) => ({ ...f, [key]: value }));
  const activeCount = Object.entries(filters).filter(([key, value]) => key !== "sort" && key !== "search" && value).length;
  const active = activeCount > 0 || !!filters.search;

  const fields = (
    <>
      <Field label="Category">
        <select className={inputClass} value={filters.category} onChange={(e) => update("category", e.target.value)}>
          <option value="">All</option>
          {facets.data?.categories.map((c) => <option key={c.value} value={c.value}>{c.value}</option>)}
        </select>
      </Field>
      <Field label="Grader">
        <select className={inputClass} value={filters.grader} onChange={(e) => update("grader", e.target.value)}>
          <option value="">All</option>
          {facets.data?.graders.map((g) => <option key={g.value} value={g.value}>{g.value}</option>)}
        </select>
      </Field>
      <Field label="Min grade"><input className={inputClass} inputMode="decimal" value={filters.minGrade} onChange={(e) => update("minGrade", e.target.value)} placeholder="9" /></Field>
      <Field label="Min price"><input className={inputClass} inputMode="decimal" value={filters.minPrice} onChange={(e) => update("minPrice", e.target.value)} placeholder="$0" /></Field>
      <Field label="Max price"><input className={inputClass} inputMode="decimal" value={filters.maxPrice} onChange={(e) => update("maxPrice", e.target.value)} placeholder="$500" /></Field>
      <Field label="Min discount"><input className={inputClass} inputMode="decimal" value={filters.minDiscount} onChange={(e) => update("minDiscount", e.target.value)} placeholder="10%" /></Field>
    </>
  );

  return (
    <div className="flex h-full flex-col gap-2 px-2 pb-2 pt-0.5 sm:px-3">
      <section className="slab z-10 shrink-0 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="pixel hidden px-1.5 text-[16px] uppercase leading-none md:block">Market</h1>
          <div className="relative min-w-[180px] flex-1">
            <Search size={15} className="pointer-events-none absolute z-10 left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden="true" />
            <input aria-label="Search cards" className={`${inputClass} !h-9 pl-8`} value={filters.search} onChange={(e) => update("search", e.target.value)} placeholder="Search Charizard, Luffy, 151" />
          </div>
          <div className="hidden items-center gap-1.5 xl:flex">
            <select aria-label="Category" className={`${inputClass} !h-9 !w-[168px]`} value={filters.category} onChange={(e) => update("category", e.target.value)}>
              <option value="">All categories</option>
              {facets.data?.categories.map((c) => <option key={c.value} value={c.value}>{c.value}</option>)}
            </select>
            <select aria-label="Grader" className={`${inputClass} !h-9 !w-[128px]`} value={filters.grader} onChange={(e) => update("grader", e.target.value)}>
              <option value="">All graders</option>
              {facets.data?.graders.map((g) => <option key={g.value} value={g.value}>{g.value}</option>)}
            </select>
            <input aria-label="Min grade" className={`${inputClass} !h-9 !w-[96px]`} inputMode="decimal" value={filters.minGrade} onChange={(e) => update("minGrade", e.target.value)} placeholder="Min grade" />
            <input aria-label="Min price" className={`${inputClass} !h-9 !w-[92px]`} inputMode="decimal" value={filters.minPrice} onChange={(e) => update("minPrice", e.target.value)} placeholder="Min $" />
            <input aria-label="Max price" className={`${inputClass} !h-9 !w-[92px]`} inputMode="decimal" value={filters.maxPrice} onChange={(e) => update("maxPrice", e.target.value)} placeholder="Max $" />
            <input aria-label="Min discount" className={`${inputClass} !h-9 !w-[112px]`} inputMode="decimal" value={filters.minDiscount} onChange={(e) => update("minDiscount", e.target.value)} placeholder="Min discount" />
          </div>
          <Button className="h-9 xl:hidden" onClick={() => setSheet(true)}>
            <SlidersHorizontal size={15} aria-hidden="true" /> Filters{activeCount > 0 ? <span className="num rounded-[2px] bg-volt px-1.5 text-[12px] font-bold text-[var(--on-volt)]">{activeCount}</span> : null}
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Segmented label="Sort" value={filters.sort} onChange={(value) => update("sort", value)} options={SORTS} />
          <span className="num text-[13px] text-faint">{query.data ? `${query.data.total.toLocaleString("en-US")} cards` : "Loading"}</span>
          {presets.map((preset) => (
            <button key={preset.name} type="button" onClick={() => setFilters(preset.filters)} className="h-7 rounded-[2px] bg-raised px-2.5 text-[13px] font-medium text-mute hover:text-bone">{preset.name}</button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            {active ? (
              <>
                <Button tone="ghost" className="h-8 text-[13px]" onClick={() => setFilters(EMPTY)}>Clear</Button>
                <Button
                  className="h-8 text-[13px]"
                  onClick={() => {
                    const name = filters.search || filters.category || `Preset ${presets.length + 1}`;
                    const next = [...presets.filter((p) => p.name !== name), { name, filters }].slice(-8);
                    setPresets(next);
                    savePresets(next);
                  }}
                >
                  Save preset
                </Button>
              </>
            ) : null}
            <BuySizeControl />
          </div>
        </div>
      </section>

      <section className="slab flex min-h-0 flex-1 flex-col p-1.5" aria-label="Listings" style={{ "--thumb": `${THUMB[buySize] + 6}px` } as CSSProperties}>
      <div className={`hidden h-7 shrink-0 items-center gap-x-3 px-2.5 text-[12px] font-medium text-faint md:grid ${COLUMNS}`}>
        <span /><span>Card</span><span className="hidden xl:block">Set</span><span>Grade</span><span>Year</span><span className="text-right">Insured</span><span className="text-right">vs insured</span><span className="text-right">Age</span><span className="text-right">Buy</span>
      </div>

      <div ref={parent} className="min-h-0 flex-1 overflow-y-auto">
        {query.isSuccess && rows.length === 0 ? (
          <Empty title="No cards match" icon={<Search size={22} aria-hidden="true" />}>Loosen a filter, or clear them all.</Empty>
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((item) => (
              <div key={item.key} style={{ position: "absolute", top: 0, left: 0, right: 0, height: item.size - 4, transform: `translateY(${item.start}px)` }}>
                <MarketRow listing={rows[item.index]!} />
              </div>
            ))}
          </div>
        )}
      </div>
      </section>

      {sheet ? (
        <Sheet title="Filters" onClose={() => setSheet(false)}>
          <div className="grid grid-cols-2 gap-2 px-5 pb-5">
            {fields}
            <Button tone="primary" className="col-span-2 h-11" onClick={() => setSheet(false)}>Show {query.data?.total.toLocaleString("en-US") ?? ""} cards</Button>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
