"use client";

import { BRAND, shortAddress } from "@gemdex/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BOLT, Button, CardThumb, CertLink, Empty, Grade, Pill, SectionTitle, Stat } from "@/components/bits";
import { QuickBuy } from "@/components/BuySize";
import { api } from "@/lib/api";
import { sized } from "@/lib/image";
import { baseChartOptions, chartColors, formatPrice, withAlpha } from "@/lib/chart";
import { ago, cardTitle, money } from "@/lib/format";
import { useMe, useTrade } from "@/lib/session";
import type { Listing } from "@/lib/types";
import { useUi } from "@/lib/ui";

interface CardData {
  nft: string;
  listing: Listing | null;
  detail: Record<string, string | number | boolean | null> | null;
  market: { listing: { price: number } | null; owner: { wallet?: string; name?: string } | null } | null;
  sales: Array<{ id: number; price: number; soldAt: string; buyer: string | null; source: string }>;
  points: Array<{ at: string; ask: number | null; insuredValue: number | null }>;
  comps: Listing[];
  pulse: Array<{ number: number; price: number | null; boughtBy: string | null; at: string }>;
}

/** Holds its space while the photo loads, so the page doesn't jump, and links the original. */
function CardPhoto({ src, full, alt }: { src: string; full: string | null; alt: string }) {
  const img = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (img.current?.complete) setLoaded(true);
  }, [src]);
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative flex h-[52dvh] w-full items-center justify-center px-cut bg-bone/[0.04] lg:h-[460px]">
        {loaded ? null : <span className="pixel absolute text-[11px] uppercase leading-none text-faint">Loading photo</span>}
        <img ref={img} src={src} alt={alt} onLoad={() => setLoaded(true)} className={`max-h-full max-w-full object-contain transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`} />
      </div>
      {full ? <a href={full} target="_blank" rel="noreferrer noopener" className="text-[12.5px] text-faint underline-offset-2 hover:text-bone hover:underline">Open full-size photo</a> : null}
    </div>
  );
}

/** Other listed copies of this card, in any grade, cheapest first. */
function SameCard({ comps }: { comps: Listing[] }) {
  return (
    <section className="slab min-w-0">
      <SectionTitle right={<span className="num text-[12.5px] text-faint">{comps.length}</span>}>Same card on the market</SectionTitle>
      {comps.length === 0 ? (
        <p className="px-3.5 pb-3.5 text-[13.5px] text-faint">No other copies are listed right now.</p>
      ) : (
        <ul className="flex flex-col gap-1 px-2 pb-2">
          {comps.map((comp) => (
            <li key={comp.nft} className="tile grid grid-cols-[30px_minmax(0,1fr)_auto_auto] items-center gap-3 px-2.5 py-1.5">
              <Link href={`/card/${comp.nft}`} aria-label={cardTitle(comp.name)}><CardThumb src={comp.image} alt="" size={30} zoom /></Link>
              <Link href={`/card/${comp.nft}`} className="flex min-w-0 items-center gap-2 hover:text-gold">
                <Grade grader={comp.grader} grade={comp.grade} />
                <span className="num truncate text-[12.5px] text-faint">IV {money(comp.insuredValue, true)}</span>
              </Link>
              {comp.discountPct !== null && comp.discountPct !== 0 ? <Pill tone={comp.discountPct > 0 ? "good" : "bad"}>{comp.discountPct > 0 ? "-" : "+"}{Math.abs(comp.discountPct)}%</Pill> : <span />}
              <QuickBuy listing={comp} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PriceChart({ data }: { data: CardData }) {
  const box = useRef<HTMLDivElement>(null);
  const theme = useUi((s) => s.theme);
  useEffect(() => {
    if (!box.current) return;
    let removed = false;
    let cleanup = () => {};
    void import("lightweight-charts").then(({ createChart, LineStyle }) => {
      if (removed || !box.current) return;
      const colors = chartColors();
      const chart = createChart(box.current, baseChartOptions(colors, false) as never);
      const unique = (rows: Array<{ time: number; value: number }>) => {
        const map = new Map(rows.map((row) => [row.time, row]));
        return [...map.values()].sort((a, b) => a.time - b.time) as never[];
      };
      const toTime = (at: string) => Math.floor(new Date(at).getTime() / 1000);
      const ask = chart.addAreaSeries({ lineColor: colors.up, topColor: withAlpha(colors.up, 0.28), bottomColor: withAlpha(colors.up, 0), lineWidth: 2, title: "Ask", priceFormat: { type: "custom", formatter: formatPrice, minMove: 0.01 } });
      const insured = chart.addLineSeries({ color: colors.gold, lineWidth: 1, lineStyle: LineStyle.Dashed, title: "Insured", lastValueVisible: false, priceLineVisible: false });
      ask.setData(unique(data.points.filter((p) => p.ask).map((p) => ({ time: toTime(p.at), value: p.ask! / 1e6 }))));
      insured.setData(unique(data.points.filter((p) => p.insuredValue).map((p) => ({ time: toTime(p.at), value: p.insuredValue! / 1e6 }))));
      const sold = chart.addLineSeries({ color: colors.bone, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 3, lastValueVisible: false, priceLineVisible: false, title: "Sold" });
      sold.setData(unique(data.sales.map((s) => ({ time: toTime(s.soldAt), value: s.price / 1e6 }))));
      chart.timeScale().fitContent();
      cleanup = () => chart.remove();
    });
    return () => {
      removed = true;
      cleanup();
    };
  }, [data, theme]);
  return <div ref={box} className="h-[320px] w-full" role="img" aria-label="Ask, insured value and recorded sales over time" />;
}

export default function CardPage() {
  const { nft } = useParams<{ nft: string }>();
  const query = useQuery({ queryKey: ["card", nft], queryFn: () => api<CardData>(`/cards/${nft}`) });
  const { buy } = useTrade();
  const me = useMe();
  const toast = useUi((s) => s.toast);
  const client = useQueryClient();
  const watched = useQuery({ queryKey: ["watchlist"], enabled: !!me, queryFn: () => api<Array<{ nft: string }>>("/watchlist") });
  const watching = !!watched.data?.some((row) => row.nft === nft);
  const watch = useMutation({
    mutationFn: () => api<{ watching: boolean }>(`/watchlist/${nft}`, { method: "POST" }),
    onSuccess: ({ watching: now }) => {
      toast({ tone: "info", title: now ? "Added to watchlist" : "Removed from watchlist" });
      void client.invalidateQueries({ queryKey: ["watchlist"] });
    },
    onError: (error) => toast({ tone: "bad", title: "Could not change the watchlist", detail: (error as Error).message }),
  });

  if (query.isError) return <Empty title="Card not found">It may have been redeemed or burned.</Empty>;
  const data = query.data;
  if (!data) return <div className="p-6 text-faint">Loading card</div>;

  const d = data.detail ?? {};
  const listing = data.listing;
  const name = String(d.itemName ?? listing?.name ?? "Graded card");
  // The medium photo is plenty at this size. The original can run to several MB.
  const photos = d.images as unknown as { frontM?: string; frontS?: string } | null;
  const photo = photos?.frontM ?? listing?.image ?? (d.frontImage ? String(d.frontImage) : null);
  const full = d.frontImage ? String(d.frontImage) : null;
  const history = [
    ...data.sales.map((sale) => ({ key: `s${sale.id}`, at: sale.soldAt, price: sale.price, buyer: sale.buyer, where: "Market" })),
    ...data.pulse.map((sale) => ({ key: `p${sale.number}`, at: sale.at, price: sale.price ?? 0, buyer: sale.boughtBy, where: `Pulse #${sale.number}` })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const charted = data.points.length + data.sales.length > 1;
  const iv = listing?.insuredValue ?? (d.insuredValue ? Number(d.insuredValue) * 1e6 : null);
  const owner = data.market?.owner;
  const grader = (d.gradingCompany as string) ?? listing?.grader ?? null;
  const grade = (d.grade as string) ?? listing?.grade ?? null;
  const cert = (d.gradingID as string) ?? listing?.cert ?? null;
  const pop = d.population as unknown as { gradePopulation?: number; totalPopulation?: number; gemRate?: number } | null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1360px] grid grid-cols-1 gap-2 px-2 pb-2 sm:px-3 lg:grid-cols-[360px_minmax(0,1fr)]">
        <section className="slab self-start p-4">
          {photo ? <CardPhoto src={sized(photo, 320)!} full={full} alt={name} /> : null}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Grade grader={grader} grade={grade} />
            {d.vault ? <Pill>{String(d.vault)}</Pill> : null}
            {d.category ? <Pill>{String(d.category)}</Pill> : null}
          </div>
          <div className="mt-2.5"><CertLink grader={grader} cert={cert} /></div>
        </section>

        <div className="flex min-w-0 flex-col gap-3">
          <section className="slab p-4 sm:p-5">
            <h1 className="text-[22px] font-bold leading-tight tracking-tight sm:text-[26px]">{cardTitle(name)}</h1>
            <p className="mt-1 text-[15px] text-mute">{String(d.set ?? listing?.set ?? "")}{d.year ? ` · ${String(d.year)}` : ""}</p>
            <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat label="Ask" value={listing ? money(listing.price) : "Not listed"} />
              <Stat label="Insured value" value={money(iv)} />
              <Stat label="Against insured" value={listing?.discountPct != null ? `${listing.discountPct > 0 ? "-" : "+"}${Math.abs(listing.discountPct)}%` : "–"} tone={listing?.discountPct != null ? (listing.discountPct > 0 ? "good" : "bad") : undefined} />
              <Stat label="Same grade" value={pop?.gradePopulation != null ? `${pop.gradePopulation.toLocaleString("en-US")} of ${pop.totalPopulation?.toLocaleString("en-US") ?? "?"}` : "–"} hint={pop?.gemRate != null ? `Gem rate ${Math.round(pop.gemRate * 100)}%` : undefined} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {listing?.active !== false && listing ? <Button tone="snipe" className="h-11" onClick={() => void buy(listing)}>{BOLT} Buy for <span className="num text-[16px] font-bold">{money(listing.price)}</span></Button> : null}
              <Button className="h-11" disabled={!me} onClick={() => watch.mutate()}><Eye size={16} aria-hidden="true" /> {watching ? "Watching" : "Watch"}</Button>
              <a href={`https://collectorcrypt.com/assets/solana/${nft}`} target="_blank" rel="noreferrer noopener" className="inline-flex h-11 items-center px-cut bg-raised px-3.5 font-semibold hover:bg-raised-2">Make an offer</a>
            </div>
            {owner?.wallet ? <p className="mt-3 text-[13px] text-faint">Held by {owner.name ? `@${owner.name}` : shortAddress(owner.wallet)}</p> : null}
          </section>

          <SameCard comps={data.comps} />

          <section className="slab min-w-0 overflow-hidden">
            <SectionTitle right={charted ? <span className="text-[12.5px] text-faint">Ask, insured, recorded sales</span> : null}>Price history</SectionTitle>
            {charted ? <div className="px-2 pb-2"><PriceChart data={data} /></div> : null}
            {history.length === 0 ? (
              <p className="px-3.5 pb-3.5 text-[13.5px] text-faint">
                {charted ? "No sales recorded yet." : `No history yet. Collector Crypt publishes no sales history, so ${BRAND.name} records its own as this card trades.`}
              </p>
            ) : (
              <ul className="flex flex-col gap-1 px-2 pb-2">
                {history.map((sale) => (
                  <li key={sale.key} className="tile grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2">
                    <span className="truncate text-[13px] text-faint"><span className="text-mute">{sale.where}</span> · {ago(sale.at)} ago · <span className="num">{shortAddress(sale.buyer)}</span></span>
                    <span />
                    <span className="num font-semibold">{money(sale.price)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
