"use client";

import { BRAND } from "@gemdex/core";
import { useQuery } from "@tanstack/react-query";
import { Briefcase, Clock3, Copy, Download, LayoutGrid, List, Search, Share2, Truck, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button, CardThumb, Empty, Grade, Pill, Rarity, SectionTitle, Segmented, Sheet, inputClass, rarityWash } from "@/components/bits";
import { PortfolioChart } from "@/components/PortfolioChart";
import { api } from "@/lib/api";
import { ago, cardTitle, clock, money } from "@/lib/format";
import { PNL_HEIGHT, PNL_WIDTH, drawPnlCard, type PnlCardData } from "@/lib/pnlCard";
import { buildHistory, inRange, sortHoldings, splitCollection, type HistoryPoint, type HoldingSort, type SplitBy } from "@/lib/portfolio";
import { useMe, useTrade } from "@/lib/session";
import type { ActivityRow, Holding, Portfolio } from "@/lib/types";
import { useNow, useUi } from "@/lib/ui";
import { sized } from "@/lib/image";

const signed = (micros: number) => `${micros >= 0 ? "+" : ""}${money(micros)}`;
const toneOf = (micros: number) => (micros >= 0 ? "text-teal" : "text-loss");
const holdingName = (holding: Holding) => cardTitle(String(holding.card.name ?? "Graded card"));
const SOURCE: Record<string, string> = { drop: "Pulse", gacha: "Pack", market: "Market" };
const RANGES: Array<{ value: string; label: string; hours: number | null }> = [
  { value: "24h", label: "24H", hours: 24 }, { value: "7d", label: "7D", hours: 168 }, { value: "30d", label: "30D", hours: 720 }, { value: "all", label: "All", hours: null },
];

function isSellable(holding: Holding, now: number): boolean {
  return holding.status === "held" && !!holding.buybackAmount && !!holding.buybackUntil && new Date(holding.buybackUntil).getTime() > now;
}

/** Sets a sale price in one place, for both the card grid and the list. */
function ListSheet({ holding, onClose }: { holding: Holding; onClose: () => void }) {
  const { holding: act } = useTrade();
  const [price, setPrice] = useState("");
  return (
    <Sheet title="List for sale" onClose={onClose}>
      <form
        className="flex flex-col gap-3 p-5 pt-1"
        onSubmit={(event) => {
          event.preventDefault();
          const value = Number(price);
          if (value > 0) void act("list", holding.id, { price: Math.round(value * 1e6) });
          onClose();
        }}
      >
        <div className="flex items-center gap-3">
          <CardThumb src={holding.card.image} alt="" size={44} />
          <div className="min-w-0">
            <div className="truncate font-semibold">{holdingName(holding)}</div>
            <div className="num text-[13px] text-faint">Insured {money(holding.insuredValue)} · Cost {money(holding.cost)}</div>
          </div>
        </div>
        <input className={inputClass} autoFocus inputMode="decimal" placeholder="Price in USDC" aria-label="List price" value={price} onChange={(e) => setPrice(e.target.value)} />
        <Button type="submit" tone="primary" disabled={!(Number(price) > 0)}>List card</Button>
      </form>
    </Sheet>
  );
}

function HoldingActions({ holding, onList }: { holding: Holding; onList: () => void }) {
  const { holding: act } = useTrade();
  const now = useNow();
  const sellable = isSellable(holding, now);
  return (
    <div className="flex items-center gap-1">
      {sellable ? (
        <Button className="h-8 min-w-0 flex-1 px-2 text-[12.5px]" onClick={() => void act("buyback", holding.id, { inMainWallet: holding.wallet === "connected" })}>
          Sell {money(holding.buybackAmount)}
        </Button>
      ) : null}
      {/* Listing is signed by the trading wallet, so a card in the user's own wallet can't be listed from here. */}
      {holding.status === "held" && holding.wallet === "trading" ? <Button tone="ghost" className="h-8 px-2 text-[12.5px]" onClick={onList}>List</Button> : null}
      {holding.wallet === "trading" ? <Button tone="ghost" className="h-8 px-2 text-[12.5px]" onClick={() => void act("send", holding.id, { nft: holding.nft })}>Send</Button> : null}
      <a title="Ship to your door" aria-label="Ship to your door" className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center px-cut text-faint hover:bg-bone/[0.07] hover:text-bone" href={`https://collectorcrypt.com/assets/solana/${holding.nft}`} target="_blank" rel="noreferrer noopener">
        <Truck size={15} aria-hidden="true" />
      </a>
    </div>
  );
}

function Picker({ holding, selected, onToggle }: { holding: Holding; selected: boolean; onToggle: () => void }) {
  return (
    <label className={`flex h-7 w-7 cursor-pointer items-center justify-center px-cut ${selected ? "bg-volt" : "bg-ink/70"}`} title="Select for bulk sell">
      <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--on-volt)]" checked={selected} onChange={onToggle} aria-label={`Select ${holdingName(holding)}`} />
    </label>
  );
}

function BuybackTimer({ holding }: { holding: Holding }) {
  const now = useNow();
  if (!isSellable(holding, now)) return null;
  const left = (new Date(holding.buybackUntil!).getTime() - now) / 1000;
  return <span className={`num inline-flex items-center gap-1 whitespace-nowrap text-[12px] ${left < 3600 ? "text-loss" : "text-gold"}`}><Clock3 size={11} aria-hidden="true" /> {clock(left)}</span>;
}

function CardTile({ holding, selected, onToggle, onList }: { holding: Holding; selected: boolean; onToggle: () => void; onList: () => void }) {
  const now = useNow();
  const name = holdingName(holding);
  const pnl = (holding.insuredValue ?? 0) - holding.cost;
  return (
    <article className={`tile flex w-full min-w-0 flex-col overflow-hidden ${rarityWash(holding.card.rarity)} ${selected ? "!border-volt" : ""}`}>
      <div className="relative flex h-[188px] items-center justify-center bg-ink/25 p-3">
        <Link href={`/card/${holding.nft}`} aria-label={name} className="flex h-full items-center justify-center">
          {holding.card.image ? <img src={sized(holding.card.image as string, 140)} alt="" loading="lazy" decoding="async" className="max-h-full max-w-full rounded-[2px] object-contain" /> : null}
        </Link>
        {isSellable(holding, now) ? <div className="absolute left-2 top-2"><Picker holding={holding} selected={selected} onToggle={onToggle} /></div> : null}
        {holding.status === "listed" ? <div className="absolute right-2 top-2"><Pill tone="info">Listed {money(holding.listPrice, true)}</Pill></div> : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2.5">
        <Link href={`/card/${holding.nft}`} className="truncate text-[14px] font-semibold hover:text-gold">{name}</Link>
        <div className="flex items-center gap-1 overflow-hidden">
          <Grade grader={holding.card.grader} grade={holding.card.grade} />
          <Rarity rarity={holding.card.rarity} />
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="num text-[15px] font-semibold">{money(holding.insuredValue)}</span>
          <span className={`num text-[12.5px] font-medium ${toneOf(pnl)}`}>{signed(pnl)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 text-[12px] text-faint">
          <span className="truncate">{SOURCE[holding.source]} · {holding.wallet === "connected" ? "Main wallet" : "Trading wallet"}</span>
          <BuybackTimer holding={holding} />
        </div>
        <div className="mt-auto pt-0.5"><HoldingActions holding={holding} onList={onList} /></div>
      </div>
    </article>
  );
}

function CardList({ rows, selected, onToggle, onList }: { rows: Holding[]; selected: Set<string>; onToggle: (id: string) => void; onList: (holding: Holding) => void }) {
  const now = useNow();
  return (
    <div className="px-2 pb-2">
      <div className="hidden grid-cols-[minmax(0,1fr)_92px_92px_100px_84px_196px] gap-3 px-2.5 pb-1.5 text-[12px] font-medium text-faint lg:grid">
        <span>Card</span><span className="text-right">Cost</span><span className="text-right">Value</span><span className="text-right">Profit</span><span className="text-right">Buyback</span><span />
      </div>
      <ul className="flex flex-col gap-1">
        {rows.map((holding) => {
          const name = holdingName(holding);
          const pnl = (holding.insuredValue ?? 0) - holding.cost;
          return (
            <li key={holding.id} className={`tile grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 p-1.5 lg:grid-cols-[minmax(0,1fr)_92px_92px_100px_84px_196px] ${selected.has(holding.id) ? "!border-volt" : ""}`}>
              <div className="flex min-w-0 items-center gap-2.5">
                {isSellable(holding, now) ? <Picker holding={holding} selected={selected.has(holding.id)} onToggle={() => onToggle(holding.id)} /> : null}
                <Link href={`/card/${holding.nft}`} aria-label={name}><CardThumb src={holding.card.image} alt="" size={30} /></Link>
                <div className="min-w-0">
                  <Link href={`/card/${holding.nft}`} className="block truncate text-[13.5px] font-semibold hover:text-gold">{name}</Link>
                  <div className="flex items-center gap-1 overflow-hidden text-[12px] text-faint">
                    <Grade grader={holding.card.grader} grade={holding.card.grade} />
                    <span className="truncate">{SOURCE[holding.source]}</span>
                  </div>
                </div>
              </div>
              <span className="num hidden text-right text-[13px] text-mute lg:block">{money(holding.cost)}</span>
              <span className="num text-right text-[13.5px] font-semibold">{money(holding.insuredValue)}</span>
              <span className={`num hidden text-right text-[13px] font-medium lg:block ${toneOf(pnl)}`}>{signed(pnl)}</span>
              <span className="hidden text-right lg:block"><BuybackTimer holding={holding} /></span>
              <div className="col-span-2 lg:col-span-1"><HoldingActions holding={holding} onList={() => onList(holding)} /></div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const VIZ = ["bg-viz-1", "bg-viz-2", "bg-viz-3", "bg-viz-4", "bg-viz-5"];

function Allocation({ held }: { held: Holding[] }) {
  const [by, setBy] = useState<SplitBy>("rarity");
  const slices = useMemo(() => splitCollection(held, by), [by, held]);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  return (
    <section className="slab min-w-0">
      <SectionTitle right={<Segmented label="Split collection by" value={by} onChange={setBy} options={[{ value: "rarity", label: "Rarity" }, { value: "grader", label: "Grader" }, { value: "source", label: "Source" }]} />}>Allocation</SectionTitle>
      {total === 0 ? (
        <p className="px-3.5 pb-4 text-[13px] text-faint">Your split shows up here once you hold a card.</p>
      ) : (
        <div className="px-3.5 pb-3.5">
          <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-[2px]" role="img" aria-label={slices.map((slice) => `${slice.label} ${Math.round((slice.value / total) * 100)}%`).join(", ")}>
            {slices.map((slice) => <span key={slice.key} className={VIZ[slice.slot]} style={{ width: `${(slice.value / total) * 100}%` }} title={`${slice.label}: ${money(slice.value)}`} />)}
          </div>
          <ul className="mt-2.5 flex flex-col">
            {slices.map((slice) => (
              <li key={slice.key} className="flex h-8 items-center gap-2 text-[13px]">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-[2px] ${VIZ[slice.slot]}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-mute">{slice.label} <span className="text-faint">· {slice.count}</span></span>
                <span className="num font-medium">{money(slice.value, true)}</span>
                <span className="num w-11 text-right text-faint">{((slice.value / total) * 100).toFixed(0)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function BuybackPanel({ held }: { held: Holding[] }) {
  const { holding: act } = useTrade();
  const now = useNow();
  const open = held.filter((holding) => isSellable(holding, now)).sort((a, b) => new Date(a.buybackUntil!).getTime() - new Date(b.buybackUntil!).getTime());
  return (
    <section className="slab min-w-0">
      <SectionTitle right={open.length ? <span className="num text-[12.5px] text-faint">{open.length} open</span> : null}>Buyback windows</SectionTitle>
      {open.length === 0 ? (
        <p className="px-3.5 pb-4 text-[13px] text-faint">Pulled cards can be sold back for 72 hours. Open windows show up here.</p>
      ) : (
        <ul className="flex flex-col gap-0.5 px-1.5 pb-1.5">
          {open.slice(0, 4).map((holding) => (
            <li key={holding.id} className="flex items-center gap-2.5 px-cut p-1.5 hover:bg-raised">
              <CardThumb src={holding.card.image} alt="" size={26} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{holdingName(holding)}</div>
                <BuybackTimer holding={holding} />
              </div>
              <Button className="h-8 px-2.5 text-[12.5px]" onClick={() => void act("buyback", holding.id, { inMainWallet: holding.wallet === "connected" })}>Sell {money(holding.buybackAmount, true)}</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Color shows profit or loss, and depth shows size, so a big day stands out from a small one. */
function Calendar({ days }: { days: Portfolio["days"] }) {
  const today = useMemo(() => new Date(), []);
  const map = new Map(days.map((d) => [d.day, d.pnl]));
  const biggest = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));
  const cells = Array.from({ length: 84 }, (_, i) => {
    const date = new Date(today.getTime() - (83 - i) * 86_400_000);
    const key = date.toISOString().slice(0, 10);
    return { key, pnl: map.get(key) ?? null };
  });
  const net = days.reduce((sum, d) => sum + d.pnl, 0);
  return (
    <section className="slab min-w-0">
      <SectionTitle right={<span className="text-[12.5px] text-faint">12 weeks</span>}>Realized PnL</SectionTitle>
      <div className="no-scrollbar grid auto-cols-fr grid-flow-col grid-rows-7 gap-[3px] overflow-x-auto px-3.5" role="img" aria-label={`Realized profit by day, ${signed(net)} in total`}>
        {cells.map((cell) => {
          const depth = cell.pnl === null ? 0 : 0.3 + 0.7 * (Math.abs(cell.pnl) / biggest);
          return <span key={cell.key} title={cell.pnl === null ? cell.key : `${cell.key}: ${signed(cell.pnl)}`} className={`aspect-square min-w-[10px] rounded-[2px] ${cell.pnl === null ? "bg-raised" : cell.pnl >= 0 ? "bg-teal" : "bg-loss"}`} style={cell.pnl === null ? undefined : { opacity: depth }} />;
        })}
      </div>
      <div className="flex items-center justify-between px-3.5 py-3 text-[12.5px] text-faint">
        <span>Net over all sales</span>
        <span className={`num font-semibold ${toneOf(net)}`}>{signed(net)}</span>
      </div>
    </section>
  );
}

/** Shows the card first. Saving or copying it is the viewer's choice. */
function PnlSheet({ data, onClose }: { data: PnlCardData; onClose: () => void }) {
  const toast = useUi((s) => s.toast);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    drawPnlCard(data)
      .then((drawn) => current && setCanvas(drawn))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [data]);

  const download = () => {
    if (!canvas) return;
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = `${BRAND.name.toLowerCase()}-pnl.png`;
    link.click();
  };
  const copy = () => {
    canvas?.toBlob((blob) => {
      if (!blob) return;
      navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(
        () => toast({ tone: "ok", title: "Copied to clipboard" }),
        () => toast({ tone: "bad", title: "Could not copy", detail: "Use Download instead" }),
      );
    });
  };

  return (
    <Sheet title="Your PnL card" onClose={onClose} wide>
      <div className="flex flex-col gap-3 p-4 pt-0">
        {/* Near-square, like the art, and capped in height so the whole card fits on screen. */}
        <div className="mx-auto w-full overflow-hidden px-cut bg-raised" style={{ aspectRatio: `${PNL_WIDTH} / ${PNL_HEIGHT}`, maxWidth: `calc(64dvh * ${PNL_WIDTH} / ${PNL_HEIGHT})` }}>
          {canvas ? (
            <img src={canvas.toDataURL("image/png")} alt="Your profit and loss card" className="h-full w-full" />
          ) : (
            <div className="flex h-full items-center justify-center text-[13.5px] text-faint">{failed ? "Could not draw your card. Close this and try again." : "Drawing your card"}</div>
          )}
        </div>
        <div className="flex items-center justify-end gap-1.5">
          <Button tone="ghost" onClick={copy} disabled={!canvas}><Copy size={15} aria-hidden="true" /> Copy</Button>
          <Button tone="snipe" onClick={download} disabled={!canvas}><Download size={15} aria-hidden="true" /> Download</Button>
        </div>
      </div>
    </Sheet>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 px-3.5 py-2.5">
      <div className="truncate text-[12px] text-faint">{label}</div>
      <div className={`num truncate text-[15px] font-semibold ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function Overview({ data, held, exited, balance, handle }: { data: Portfolio | undefined; held: Holding[]; exited: Holding[]; balance: number; handle: string }) {
  const now = useNow();
  const [mode, setMode] = useState<"value" | "pnl">("value");
  const [range, setRange] = useState("all");
  const [hovered, setHovered] = useState<HistoryPoint | null>(null);
  const [sharing, setSharing] = useState(false);
  const summary = data?.summary ?? { value: 0, cost: 0, unrealized: 0, realized: 0 };
  const total = summary.unrealized + summary.realized;
  const invested = summary.cost + exited.reduce((sum, h) => sum + h.cost, 0);
  const wins = exited.filter((h) => (h.exitPrice ?? 0) > h.cost).length;
  const instant = held.filter((h) => isSellable(h, now)).reduce((sum, h) => sum + (h.buybackAmount ?? 0), 0);

  const wallet = data?.wallet;
  const history = useMemo(() => buildHistory(held, exited, wallet), [held, exited, wallet]);
  const hours = RANGES.find((item) => item.value === range)?.hours ?? null;
  const points = useMemo(() => inRange(history, hours), [history, hours]);

  return (
    <section className="slab min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 p-3.5 pb-2">
        <div className="min-w-0">
          <h1 className="pixel text-[13px] uppercase leading-none text-faint">Net worth</h1>
          <div className="num mt-2 text-[32px] font-semibold leading-none tracking-tight">{money(balance + summary.value)}</div>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-[13px]">
            {hovered ? (
              <span className="num text-mute">{new Date(hovered.time * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}: {money(hovered.worth)} net worth, {signed(hovered.pnl)} profit</span>
            ) : (
              <>
                <span className={`num font-semibold ${toneOf(total)}`}>{signed(total)}{invested > 0 ? ` (${total >= 0 ? "+" : ""}${((total / invested) * 100).toFixed(1)}%)` : ""}</span>
                <span className="text-faint">all time</span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Segmented label="Chart" value={mode} onChange={setMode} options={[{ value: "value", label: "Value" }, { value: "pnl", label: "Profit" }]} />
          <Segmented label="Time range" value={range} onChange={setRange} options={RANGES.map(({ value, label }) => ({ value, label }))} />
          <Button className="h-9 px-2.5 text-[13px]" onClick={() => setSharing(true)}><Share2 size={14} aria-hidden="true" /> Share PnL</Button>
        </div>
      </div>
      <div className="relative h-[220px] lg:h-[260px]">
        {points.length >= 2 ? (
          <PortfolioChart points={points} mode={mode} onHover={setHovered} />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-[13.5px] text-faint">{history.length > 0 ? "No changes in this time range." : "Your chart starts with your first deposit or card."}</div>
        )}
      </div>
      <div className="grid grid-cols-2 divide-line border-t border-line sm:grid-cols-3 sm:divide-x xl:grid-cols-6">
        <Figure label="Trading wallet" value={money(balance)} />
        <Figure label="Collection" value={money(summary.value)} />
        <Figure label="Cost basis" value={money(summary.cost)} />
        <Figure label="Unrealized" value={signed(summary.unrealized)} tone={toneOf(summary.unrealized)} />
        <Figure label={exited.length ? `Realized · ${Math.round((wins / exited.length) * 100)}% won` : "Realized"} value={signed(summary.realized)} tone={toneOf(summary.realized)} />
        <Figure label="Sell back now" value={money(instant)} />
      </div>
      {sharing ? <PnlSheet data={{ handle, value: summary.value, unrealized: summary.unrealized, realized: summary.realized, invested, cards: held.length, history }} onClose={() => setSharing(false)} /> : null}
    </section>
  );
}

export default function PortfolioPage() {
  const me = useMe();
  const setConnectOpen = useUi((s) => s.setConnectOpen);
  const [tab, setTab] = useState<"holdings" | "history" | "activity">("holdings");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState<HoldingSort>("value");
  const [search, setSearch] = useState("");
  const [wallet, setWallet] = useState<"all" | "connected" | "trading">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [listing, setListing] = useState<Holding | null>(null);
  const { holding: act } = useTrade();
  const now = useNow();
  const query = useQuery({ queryKey: ["portfolio"], enabled: !!me, queryFn: () => api<Portfolio>("/portfolio"), refetchInterval: 20_000 });
  const activity = useQuery({ queryKey: ["activity"], enabled: !!me && tab === "activity", queryFn: () => api<ActivityRow[]>("/activity") });

  const held = useMemo(() => query.data?.held ?? [], [query.data]);
  const exited = useMemo(() => query.data?.exited ?? [], [query.data]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const shown = held.filter((h) => (wallet === "all" || h.wallet === wallet) && (!q || String(h.card.name ?? "").toLowerCase().includes(q)));
    return sortHoldings(shown, sort);
  }, [held, search, sort, wallet]);

  if (!me) {
    return (
      <Empty title="No wallet connected" icon={<Briefcase size={22} aria-hidden="true" />}>
        <p>Connect to see your cards, profit and loss, and buyback timers.</p>
        <div className="mt-3"><Button tone="primary" onClick={() => setConnectOpen(true)}>Connect</Button></div>
      </Empty>
    );
  }

  const sellable = held.filter((h) => isSellable(h, now));
  const picked = sellable.filter((h) => selected.has(h.id));
  const pickedTotal = picked.reduce((sum, h) => sum + (h.buybackAmount ?? 0), 0);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1360px] grid grid-cols-1 gap-2 px-2 pb-2 sm:px-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 xl:col-start-1">
          <Overview data={query.data} held={held} exited={exited} balance={me.balance} handle={me.handle} />
        </div>

        <aside className="grid min-w-0 content-start gap-2 md:grid-cols-2 xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:grid-cols-1" aria-label="Collection breakdown">
          <Allocation held={held} />
          <BuybackPanel held={held} />
          <div className="md:col-span-2 xl:col-span-1"><Calendar days={query.data?.days ?? []} /></div>
        </aside>

        <section className="slab min-w-0 xl:col-start-1" aria-label="Your cards">
          <div className="flex flex-wrap items-center gap-2 p-2">
            <Segmented
              label="Portfolio view"
              value={tab}
              onChange={setTab}
              options={[
                { value: "holdings", label: `Cards ${held.length}` },
                { value: "history", label: `Sold ${exited.length}` },
                { value: "activity", label: "Activity" },
              ]}
            />
            {tab === "holdings" && held.length > 0 ? (
              <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5">
                <div className="relative min-w-[150px] flex-1 sm:max-w-[220px]">
                  <Search size={15} className="pointer-events-none absolute z-10 left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden="true" />
                  <input className={`${inputClass} !h-9 pl-8`} placeholder="Filter cards" aria-label="Filter cards" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <select className={`${inputClass} !h-9 !w-auto`} aria-label="Wallet" value={wallet} onChange={(e) => setWallet(e.target.value as typeof wallet)}>
                  <option value="all">All wallets</option>
                  <option value="connected">Main wallet</option>
                  <option value="trading">Trading wallet</option>
                </select>
                <select className={`${inputClass} !h-9 !w-auto`} aria-label="Sort cards" value={sort} onChange={(e) => setSort(e.target.value as HoldingSort)}>
                  <option value="value">Highest value</option>
                  <option value="profit">Most profit</option>
                  <option value="newest">Newest</option>
                  <option value="buyback">Buyback ending</option>
                </select>
                <Segmented label="Layout" value={view} onChange={setView} options={[{ value: "grid", label: <LayoutGrid size={15} aria-label="Grid" /> }, { value: "list", label: <List size={15} aria-label="List" /> }]} />
              </div>
            ) : null}
          </div>

          {tab === "holdings" && picked.length > 0 ? (
            <div className="mx-2 mb-2 flex items-center gap-2 px-cut bg-volt/12 px-3 py-1.5">
              <span className="text-[13.5px] font-medium">{picked.length} selected</span>
              <button type="button" className="text-[13px] text-mute underline-offset-2 hover:underline" onClick={() => setSelected(new Set(sellable.map((h) => h.id)))}>Select all {sellable.length}</button>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  tone="snipe"
                  className="h-8 text-[13px]"
                  onClick={() => {
                    // One at a time: cards in the user's own wallet each open a wallet prompt, and they can't all be open at once.
                    const batch = [...picked];
                    setSelected(new Set());
                    void (async () => {
                      for (const h of batch) await act("buyback", h.id, { inMainWallet: h.wallet === "connected" });
                    })();
                  }}
                >
                  Sell back <span className="num text-[14px] font-bold">{money(pickedTotal)}</span>
                </Button>
                <button type="button" aria-label="Clear selection" onClick={() => setSelected(new Set())} className="flex h-8 w-8 items-center justify-center px-cut text-mute hover:bg-bone/[0.07] hover:text-bone"><X size={15} aria-hidden="true" /></button>
              </div>
            </div>
          ) : null}

          {tab === "holdings" ? (
            held.length === 0 ? (
              <Empty title="No cards yet" icon={<Briefcase size={22} aria-hidden="true" />}>Buy a card on <Link href="/" className="font-semibold text-gold underline">Pulse</Link> or open a <Link href="/gacha" className="font-semibold text-gold underline">pack</Link>.</Empty>
            ) : rows.length === 0 ? (
              <Empty title="No cards match" />
            ) : view === "grid" ? (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,196px),1fr))] gap-1.5 px-2 pb-2">
                {rows.map((holding) => (
                  <li key={holding.id} className="flex min-w-0">
                    <CardTile holding={holding} selected={selected.has(holding.id)} onToggle={() => toggle(holding.id)} onList={() => setListing(holding)} />
                  </li>
                ))}
              </ul>
            ) : (
              <CardList rows={rows} selected={selected} onToggle={toggle} onList={setListing} />
            )
          ) : null}

          {tab === "history" ? (
            exited.length === 0 ? (
              <Empty title="Nothing sold yet">Cards you sell or send back show up here with their profit.</Empty>
            ) : (
              <ul className="flex flex-col gap-1 px-2 pb-2">
                {exited.map((h) => {
                  const pnl = (h.exitPrice ?? 0) - h.cost;
                  return (
                    <li key={h.id} className="tile flex items-center gap-3 p-1.5">
                      <CardThumb src={h.card.image} alt="" size={30} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-semibold">{holdingName(h)}</div>
                        <div className="num truncate text-[12px] text-faint">{money(h.cost)} → {money(h.exitPrice)}{h.exitedAt ? ` · ${ago(h.exitedAt, now)} ago` : ""}</div>
                      </div>
                      <span className={`num text-right text-[13.5px] font-semibold ${toneOf(pnl)}`}>{signed(pnl)}</span>
                    </li>
                  );
                })}
              </ul>
            )
          ) : null}

          {tab === "activity" ? (
            (activity.data ?? []).length === 0 ? (
              <Empty title="No activity yet" />
            ) : (
              <ul className="flex flex-col px-1.5 pb-1.5">
                {activity.data!.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 px-cut px-2.5 py-1.5 hover:bg-raised">
                    <span className="num w-9 shrink-0 text-[12.5px] text-faint">{ago(row.at, now)}</span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px]">{row.title}</span>
                    <span className={`num text-[13.5px] font-medium ${row.delta >= 0 ? "text-teal" : "text-mute"}`}>{row.delta !== 0 ? signed(row.delta) : ""}</span>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>
      </div>
      {listing ? <ListSheet holding={listing} onClose={() => setListing(null)} /> : null}
    </div>
  );
}
