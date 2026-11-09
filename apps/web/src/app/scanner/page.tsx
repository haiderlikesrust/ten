"use client";

import { Search, Timer } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { CardThumb, Empty, Grade, Pill, Rarity, SectionTitle, Segmented, Skeleton, inputClass } from "@/components/bits";
import { BuySizeControl, QuickBuy } from "@/components/BuySize";
import { ago, cardTitle, clock, compactUsd, money, packLabel } from "@/lib/format";
import { useBuySize, type BuySize } from "@/lib/buySize";
import { useLive } from "@/lib/live";
import type { Listing, Pull } from "@/lib/types";
import { useNow } from "@/lib/ui";

function Reading({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 px-3.5 py-2">
      <div className="truncate text-[12px] text-faint">{label}</div>
      <div className={`num truncate text-[17px] font-semibold leading-snug ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function Discount({ pct }: { pct: number | null }) {
  if (pct === null || pct === 0) return <span className="text-faint">–</span>;
  return <Pill tone={pct > 0 ? "good" : "bad"}>{pct > 0 ? "-" : "+"}{Math.abs(pct)}%</Pill>;
}

/** The best deals on the market, shown big so they can be read from across the screen. */
function DealTile({ listing }: { listing: Listing }) {
  const name = cardTitle(listing.name);
  return (
    <article className="tile flex w-[172px] shrink-0 flex-col overflow-hidden">
      <Link href={`/card/${listing.nft}`} aria-label={name} className="relative flex h-[118px] items-center justify-center bg-ink/25">
        <CardThumb src={listing.image} alt={name} size={78} zoom />
        <span className="pixel absolute left-1.5 top-1.5 bg-teal px-1 py-[3px] text-[11px] leading-none text-[var(--ink)]">-{listing.discountPct}%</span>
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2">
        <Link href={`/card/${listing.nft}`} className="truncate text-[13px] font-semibold hover:text-gold">{name}</Link>
        <div className="flex items-center justify-between gap-1 text-[12px] text-faint">
          <Grade grader={listing.grader} grade={listing.grade} />
          <span className="num whitespace-nowrap">IV {money(listing.insuredValue, true)}</span>
        </div>
        <div className="mt-auto pt-0.5"><QuickBuy listing={listing} wide /></div>
      </div>
    </article>
  );
}

/** Rows grow with the Buy button, so the card keeps up with it. */
const TAPE_THUMB: Record<BuySize, number> = { s: 24, m: 24, l: 40 };

const TAPE = "grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[40px_minmax(0,1fr)_70px_84px_84px_64px_auto]";

function TapeRow({ listing }: { listing: Listing }) {
  const now = useNow();
  const isNew = useLive((s) => s.newIds.has(listing.nft));
  const buySize = useBuySize((s) => s.size);
  const name = cardTitle(listing.name);
  return (
    <li className={`grid items-center gap-x-3 border-b border-line/70 px-3.5 py-1 transition-colors hover:bg-raised ${TAPE} ${isNew ? "row-new" : ""}`}>
      <span className="num hidden text-[12.5px] text-faint md:block">{ago(listing.listedAt, now)}</span>
      <div className="flex min-w-0 items-center gap-2.5">
        <CardThumb src={listing.image} alt={name} size={TAPE_THUMB[buySize]} zoom />
        <div className="min-w-0">
          <Link href={`/card/${listing.nft}`} className="block truncate text-[13.5px] font-medium hover:text-gold">{name}</Link>
          <div className="flex items-center gap-1 md:hidden">
            <Grade grader={listing.grader} grade={listing.grade} />
            <Discount pct={listing.discountPct} />
          </div>
          <div className="hidden truncate text-[12px] text-faint md:block">{listing.set ?? listing.category ?? "Graded card"}</div>
        </div>
      </div>
      <div className="hidden md:block"><Grade grader={listing.grader} grade={listing.grade} /></div>
      <span className="num hidden text-right text-[13px] font-medium md:block">{money(listing.price, true)}</span>
      <span className="num hidden text-right text-[13px] text-faint md:block">{money(listing.insuredValue, true)}</span>
      <div className="hidden text-right md:block"><Discount pct={listing.discountPct} /></div>
      <QuickBuy listing={listing} />
    </li>
  );
}

function PullLine({ pull }: { pull: Pull }) {
  const now = useNow();
  const isNew = useLive((s) => s.newIds.has(pull.id));
  const name = cardTitle(pull.name);
  const buybackLeft = 72 * 3600 - (now - new Date(pull.at).getTime()) / 1000;
  return (
    <li className={`flex items-center gap-2.5 px-3.5 py-1.5 transition-colors hover:bg-raised ${isNew ? "row-new" : ""}`}>
      <CardThumb src={pull.image} alt={name} size={26} zoom />
      <div className="min-w-0 flex-1">
        <Link href={`/card/${pull.nft}`} className="block truncate text-[13px] font-medium hover:text-gold">{name}</Link>
        <div className="flex items-center gap-1.5 overflow-hidden text-[12px] text-faint">
          <Rarity rarity={pull.rarity} />
          <span className="truncate">{packLabel(pull.packType)}</span>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="num text-[13px] font-semibold">{money(pull.insuredValue, true)}</div>
        {buybackLeft > 0 ? (
          <div className="num flex items-center justify-end gap-1 whitespace-nowrap text-[12px] text-gold" title="Time left on the Collector Crypt buyback window">
            <Timer size={11} aria-hidden="true" /> {clock(buybackLeft)}
          </div>
        ) : <div className="num text-[12px] text-faint">{ago(pull.at, now)}</div>}
      </div>
    </li>
  );
}

export default function ScannerPage() {
  const fresh = useLive((s) => s.fresh);
  const below = useLive((s) => s.below);
  const pulls = useLive((s) => s.pulls);
  const [view, setView] = useState<"new" | "below">("new");
  const [search, setSearch] = useState("");
  const loading = fresh.length === 0;

  const tape = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = view === "new" ? fresh : below;
    return q ? rows.filter((listing) => listing.name.toLowerCase().includes(q)) : rows;
  }, [below, fresh, search, view]);

  const bestDiscount = below.reduce((best, listing) => Math.max(best, listing.discountPct ?? 0), 0);
  const topPull = pulls.reduce((top, pull) => Math.max(top, pull.insuredValue ?? 0), 0);
  const listed = fresh.reduce((sum, listing) => sum + listing.price, 0);

  return (
    <div className="h-full overflow-y-auto xl:overflow-hidden">
      <div className="flex min-h-full flex-col gap-2 px-2 pb-2 pt-0.5 sm:px-3 xl:h-full">
        <h1 className="sr-only">Scanner</h1>

        <section aria-label="Market readings" className="slab grid shrink-0 grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
          <Reading label="New listings in feed" value={String(fresh.length)} />
          <Reading label="Value listed in feed" value={compactUsd(listed / 1e6)} />
          <Reading label="Best discount to insured" value={bestDiscount > 0 ? `-${bestDiscount}%` : "–"} tone={bestDiscount > 0 ? "text-teal" : undefined} />
          <Reading label="Top recent pull" value={topPull > 0 ? money(topPull, true) : "–"} tone="text-gold" />
        </section>

        <section aria-label="Best deals" className="slab shrink-0">
          <SectionTitle right={<span className="text-[12.5px] text-faint">Biggest discount to insured value</span>}>Best deals</SectionTitle>
          {below.length === 0 ? (
            <div className="px-3.5 pb-3 text-[13.5px] text-faint">{loading ? "Scanning the market" : "Nothing below insured value right now."}</div>
          ) : (
            <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-1.5 pb-1.5">
              {below.slice(0, 14).map((listing) => <DealTile key={listing.nft} listing={listing} />)}
            </div>
          )}
        </section>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 xl:grid-cols-[minmax(0,1fr)_340px]">
          <section aria-label="Live listings" className="slab flex min-h-[420px] min-w-0 flex-col xl:min-h-0">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line p-1.5">
              <Segmented label="Listings" value={view} onChange={setView} options={[{ value: "new", label: "New listings" }, { value: "below", label: "Below insured" }]} />
              <div className="relative min-w-[96px] flex-1 sm:max-w-[240px]">
                <Search size={15} className="pointer-events-none absolute z-10 left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden="true" />
                <input className={`${inputClass} !h-9 pl-8`} placeholder="Filter by name" aria-label="Filter listings by name" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <div className="ml-auto"><BuySizeControl /></div>
            </div>
            <div className={`hidden shrink-0 gap-x-3 px-3.5 py-1.5 text-[12px] font-medium text-faint md:grid ${TAPE}`}>
              <span>Age</span><span>Card</span><span>Grade</span><span className="text-right">Price</span><span className="text-right">Insured</span><span className="text-right">vs insured</span><span className="min-w-[76px]" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading ? <Skeleton /> : tape.length === 0 ? <Empty title="No listings match" /> : <ul>{tape.map((listing) => <TapeRow key={listing.nft} listing={listing} />)}</ul>}
            </div>
          </section>

          <section aria-label="Fresh pulls" className="slab flex max-h-[520px] min-h-0 min-w-0 flex-col xl:max-h-none">
            <SectionTitle right={<span className="num text-[12.5px] text-faint">{pulls.length}</span>}>Fresh pulls</SectionTitle>
            <div className="min-h-0 flex-1 overflow-y-auto pb-1">
              {pulls.length === 0 ? <Skeleton rows={4} /> : <ul>{pulls.map((pull) => <PullLine key={pull.id} pull={pull} />)}</ul>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
