"use client";

import { useQuery } from "@tanstack/react-query";
import { Minus, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BOLT, Button, Empty, Field, PageHeader, Pill, Rarity, SectionTitle, Segmented, Sheet, Toggle, inputClass } from "@/components/bits";
import { PullRow } from "@/components/rows";
import { api } from "@/lib/api";
import { money } from "@/lib/format";
import { sized } from "@/lib/image";
import { useMediaQuery } from "@/lib/media";
import { useMe, useTrade } from "@/lib/session";
import type { Machine, Pull } from "@/lib/types";

const TIERS = ["common", "uncommon", "rare", "epic"] as const;
const BAR: Record<string, string> = { common: "bg-common", uncommon: "bg-uncommon", rare: "bg-rare", epic: "bg-epic" };
const stockTotal = (m: Machine) => Object.values(m.stock).reduce((sum, n) => sum + Number(n), 0);

/** Machines carry no game, but their codes do: pokemon_25, onepiece_50, soccer_100. */
const GAMES: Array<{ key: string; label: string; match: RegExp }> = [
  { key: "pokemon", label: "Pokemon", match: /^(pokemon|egengar)_/ },
  { key: "onepiece", label: "One Piece", match: /^onepiece_/ },
  { key: "dragonball", label: "Dragon Ball", match: /^dragonball_/ },
  { key: "tcg", label: "Other card games", match: /^(lorcana|riftbound)_/ },
  { key: "anime", label: "Anime", match: /^anime_/ },
  { key: "sports", label: "Sports", match: /^(soccer|basketball|football|baseball|sports)_/ },
  { key: "special", label: "Specials", match: /./ },
];
const gameOf = (m: Machine) => GAMES.find((game) => game.match.test(m.code))!.key;

/** EV against break-even: the tick is 100%, and the bar covers 95% to 115%. */
function EvBar({ pct }: { pct: number | null }) {
  const share = pct === null ? 0 : Math.max(0, Math.min(1, (pct - 95) / 20));
  const tone = pct === null ? "bg-faint" : pct >= 105 ? "bg-teal" : pct >= 100 ? "bg-volt" : "bg-loss";
  return (
    <span className="relative block h-1.5 w-full bg-bone/[0.08]" aria-hidden="true">
      <span className={`absolute inset-y-0 left-0 ${tone}`} style={{ width: `${share * 100}%` }} />
      <span className="absolute -inset-y-0.5 left-1/4 w-px bg-bone/50" />
    </span>
  );
}

function evTone(pct: number | null): "good" | "warn" | "plain" {
  if (pct === null) return "plain";
  return pct >= 105 ? "good" : pct >= 100 ? "warn" : "plain";
}

function MachineDetail({ machine }: { machine: Machine }) {
  const { open } = useTrade();
  const me = useMe();
  const [turbo, setTurbo] = useState(false);
  const [count, setCount] = useState(1);
  const recent = useQuery({ queryKey: ["pulls", machine.code], queryFn: () => api<Pull[]>(`/pulls?packType=${machine.code}&limit=8`), refetchInterval: 15_000 });
  const total = machine.price * count;
  const short = me ? me.available < total : false;
  const loss = machine.ev !== null ? machine.price - Math.floor((machine.ev * machine.buybackPct) / 100) : null;

  return (
    <div className="flex flex-col gap-3.5 p-4 pt-1">
      <div className="flex gap-3.5">
        {machine.image ? <img src={sized(machine.image, 104)} alt="" className="h-[104px] w-[104px] shrink-0 object-contain" /> : null}
        <div className="min-w-0">
          <div className="text-[16px] font-bold leading-tight">{machine.name}</div>
          <div className="num mt-1.5 text-[26px] font-bold leading-none">{money(machine.price)}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Pill tone={machine.isOpen ? "good" : "bad"}>{machine.isOpen ? "Open" : "Closed"}</Pill>
            <Pill tone={evTone(machine.evPct)}>EV {machine.evPct ?? "–"}%</Pill>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[13px] font-semibold text-mute">Odds by tier</div>
        <ul className="flex flex-col gap-2">
          {TIERS.map((tier) => {
            const odds = machine.odds[tier] ?? 0;
            const range = machine.tiers[tier];
            return (
              <li key={tier} className="grid grid-cols-[104px_1fr_46px_92px] items-center gap-2">
                <Rarity rarity={tier} />
                <span className="h-2 overflow-hidden bg-bone/[0.08]"><span className={`block h-full ${BAR[tier]}`} style={{ width: `${Math.max(3, odds * 100)}%` }} /></span>
                <span className="num text-right text-[13px] font-semibold">{(odds * 100).toFixed(odds < 0.1 ? 1 : 0)}%</span>
                <span className="num text-right text-[12.5px] text-faint">{range ? `$${range.start}-$${range.end}` : "–"}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-[13px]">
        {[
          ["Instant buyback", `${machine.buybackPct}%`],
          ["Open and sell back", loss !== null ? `-${money(loss)} avg` : "–"],
          ["Stock", stockTotal(machine).toLocaleString("en-US")],
          ["Max holder cashback", `${(machine.cashbackCapBps / 100).toFixed(1)}%`],
        ].map(([label, value]) => (
          <div key={label} className="px-cut bg-raised px-3 py-2">
            <dt className="text-[12.5px] text-faint">{label}</dt>
            <dd className="num font-semibold">{value}</dd>
          </div>
        ))}
      </dl>

      <div>
        <div className="mb-1.5 text-[13px] font-semibold text-mute">Packs</div>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center px-cut bg-raised">
            <button type="button" aria-label="One pack fewer" disabled={count <= 1} onClick={() => setCount((n) => Math.max(1, n - 1))} className="flex h-10 w-9 items-center justify-center text-mute hover:text-bone disabled:opacity-40"><Minus size={15} aria-hidden="true" /></button>
            <input className="num h-10 w-10 bg-transparent text-center text-[15px] font-semibold outline-none" inputMode="numeric" aria-label="Number of packs" value={count} onChange={(e) => setCount(Math.max(1, Math.min(100, Number(e.target.value.replace(/\D/g, "")) || 1)))} />
            <button type="button" aria-label="One pack more" disabled={count >= 100} onClick={() => setCount((n) => Math.min(100, n + 1))} className="flex h-10 w-9 items-center justify-center text-mute hover:text-bone disabled:opacity-40"><Plus size={15} aria-hidden="true" /></button>
          </div>
          {[5, 10, 25].map((n) => (
            <button key={n} type="button" onClick={() => setCount(n)} className={`num h-10 flex-1 px-cut text-[13px] font-semibold transition-colors ${count === n ? "bg-bone text-ink" : "bg-raised text-mute hover:text-bone"}`}>{n}</button>
          ))}
        </div>
      </div>
      {machine.turbo ? <Toggle checked={turbo} onChange={setTurbo}>Turbo: sell Commons back automatically at {machine.buybackPct}%</Toggle> : null}
      <Button tone="snipe" className="h-12 text-[14px]" disabled={!machine.isOpen || short} onClick={() => void open(machine, { turbo, count })}>
        {BOLT} {short ? "Not enough USDC" : <>Open for <span className="num text-[17px] font-bold">{money(total)}</span></>}
      </Button>
      <p className="text-[12.5px] text-faint">Cards go to your connected wallet. Each roll is provably random.</p>

      <div>
        <div className="mb-1.5 text-[13px] font-semibold text-mute">Recent pulls</div>
        {(recent.data ?? []).length === 0 ? <div className="text-faint">None yet</div> : <div className="flex flex-col gap-1.5">{recent.data!.slice(0, 5).map((pull) => <PullRow key={pull.id} pull={pull} />)}</div>}
      </div>
    </div>
  );
}

function MachineTile({ machine, selected, onSelect }: { machine: Machine; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} className={`tile flex items-center gap-3 p-2.5 text-left transition-colors hover:bg-raised ${selected ? "!border-volt" : ""} ${machine.isOpen ? "" : "opacity-60"}`}>
      <div className="flex h-[64px] w-[52px] shrink-0 items-center justify-center">
        {machine.image ? <img src={sized(machine.image, 52)} alt="" loading="lazy" decoding="async" className="max-h-full max-w-full object-contain" /> : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13.5px] font-semibold">{machine.shortName ?? machine.name}</span>
          <span className="num shrink-0 text-[15px] font-bold">{money(machine.price, true)}</span>
        </div>
        <EvBar pct={machine.evPct} />
        <div className="flex items-center justify-between text-[12px]">
          <span className={`num font-medium ${(machine.evPct ?? 0) >= 105 ? "text-teal" : (machine.evPct ?? 0) >= 100 ? "text-gold" : "text-loss"}`}>EV {machine.evPct ?? "–"}%</span>
          <span className="num text-faint">{machine.isOpen ? `${machine.buybackPct}% buyback` : "Closed"}</span>
        </div>
      </div>
    </button>
  );
}

export default function GachaPage() {
  const query = useQuery({ queryKey: ["machines"], queryFn: () => api<Machine[]>("/machines"), refetchInterval: 20_000 });
  const [selected, setSelected] = useState<string>("pokemon_25");
  const [sheet, setSheet] = useState(false);
  const [sort, setSort] = useState<"ev" | "price" | "buyback">("ev");
  const [search, setSearch] = useState("");
  const [game, setGame] = useState("all");
  const wide = useMediaQuery("(min-width: 1024px)");
  useEffect(() => {
    if (wide) setSheet(false);
  }, [wide]);
  const rows = useMemo(() => {
    const list = (query.data ?? []).filter((m) => `${m.name} ${m.code}`.toLowerCase().includes(search.toLowerCase()) && (game === "all" || gameOf(m) === game));
    return [...list].sort((a, b) => (sort === "price" ? a.price - b.price : sort === "buyback" ? b.buybackPct - a.buybackPct : (b.evPct ?? 0) - (a.evPct ?? 0)));
  }, [query.data, sort, search, game]);
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of query.data ?? []) out.set(gameOf(m), (out.get(gameOf(m)) ?? 0) + 1);
    return out;
  }, [query.data]);
  const groups = GAMES.map((g) => ({ ...g, machines: rows.filter((m) => gameOf(m) === g.key) })).filter((g) => g.machines.length > 0);
  const machine = (query.data ?? []).find((m) => m.code === selected) ?? rows[0];

  return (
    <div className="grid h-full grid-cols-1 gap-2 px-2 pb-2 sm:px-3 lg:grid-cols-[minmax(0,1fr)_400px]">
      <section className="flex min-h-0 min-w-0 flex-col gap-3" aria-label="Machines">
        <PageHeader
          title="Gacha Desk"
          right={
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <div className="relative min-w-0 flex-1 sm:w-[200px] sm:flex-none">
                <Search size={16} className="pointer-events-none absolute z-10 left-3 top-1/2 -translate-y-1/2 text-faint" aria-hidden="true" />
                <input className={`${inputClass} pl-9`} placeholder="Filter machines" aria-label="Filter machines" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <Segmented label="Sort machines" value={sort} onChange={setSort} options={[{ value: "ev", label: "Best EV" }, { value: "price", label: "Cheapest" }, { value: "buyback", label: "Buyback" }]} />
            </div>
          }
        />
        <div className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto" role="tablist" aria-label="Games">
          {[{ key: "all", label: "All", n: query.data?.length ?? 0 }, ...GAMES.map((g) => ({ key: g.key, label: g.label, n: counts.get(g.key) ?? 0 })).filter((g) => g.n > 0)].map((g) => (
            <button key={g.key} type="button" role="tab" aria-selected={game === g.key} onClick={() => setGame(g.key)} className={`flex h-8 shrink-0 items-center gap-1.5 px-cut px-2.5 text-[13px] font-medium transition-colors ${game === g.key ? "bg-surface text-gold" : "text-mute hover:bg-bone/[0.06] hover:text-bone"}`}>
              {g.label} <span className="num text-[12px] text-faint">{g.n}</span>
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-1">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              {game === "all" ? (
                <h2 className="pixel mb-1.5 flex items-center gap-2 px-0.5 text-[12px] uppercase leading-none text-mute">{group.label} <span className="num text-faint">{group.machines.length}</span></h2>
              ) : null}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-1.5">
                {group.machines.map((m) => (
                  <MachineTile
                    key={m.code}
                    machine={m}
                    selected={wide && machine?.code === m.code}
                    onSelect={() => {
                      setSelected(m.code);
                      if (!wide) setSheet(true);
                    }}
                  />
                ))}
              </div>
            </section>
          ))}
          {query.isSuccess && rows.length === 0 ? <Empty title="No machines match" /> : null}
        </div>
      </section>

      {wide && machine ? (
        <aside className="slab flex min-h-0 flex-col overflow-hidden" aria-label={machine.name}>
          <SectionTitle>{machine.shortName ?? machine.code}</SectionTitle>
          <div className="min-h-0 flex-1 overflow-y-auto"><MachineDetail key={machine.code} machine={machine} /></div>
        </aside>
      ) : null}

      {sheet && machine ? (
        <Sheet title={machine.shortName ?? machine.name} onClose={() => setSheet(false)}>
          <MachineDetail key={machine.code} machine={machine} />
        </Sheet>
      ) : null}
    </div>
  );
}
