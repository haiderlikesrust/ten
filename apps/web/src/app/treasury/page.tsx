"use client";

import { BRAND, giftGroupOrder, giftPrize, giftSlot, shareOfSupply, type GiftGroup } from "@gemdex/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader, SectionTitle } from "@/components/bits";
import { PixelIcon, type PixelName } from "@/components/pixel";
import { GATEWAY, api } from "@/lib/api";
import { ago, clock, money, packLabel } from "@/lib/format";
import { useNow } from "@/lib/ui";

interface Draw {
  id: string;
  slotAt: string;
  group: GiftGroup | null;
  state: string;
  prize: number | null;
  machineCode: string | null;
  reason: string | null;
  entries: number;
  entriesHash: string | null;
  targetSlot: number | null;
  blockhash: string | null;
  seed: string | null;
  winner: string | null;
}

interface Treasury {
  pools: { drops: number; cashback: number; gifts: number; giftReserved: number; revenue: number };
  rules: {
    accessBps: number; giftHoldBps: number; giftBps: number; giftSpendBps: number; saleBuybackBps: number; giftIntervalMin: number; giftTiers: number[];
    activePacksPerHour: number; topBlasters: number; blasterDays: number; claimHours: number;
  };
  draws: Draw[];
  buybacks: Array<{ id: string; stage: string; usdcIn: number; tenrOut: number | null; burnSig: string | null; at: string }>;
  totals: { usdcSpent: number; tenrBurned: number };
}

/** The trading-fee split. Cashback's share lives in fee settings, so it's 30% unless changed there. */
const CASHBACK_SHARE = 0.3;

const GROUPS: Record<GiftGroup, { name: string; icon: PixelName; stat: (r: Treasury["rules"]) => string; line: (r: Treasury["rules"]) => string }> = {
  active: {
    name: "Active",
    icon: "pulse",
    stat: (r) => `${r.activePacksPerHour} packs / hr`,
    line: (r) => `Open or snipe ${r.activePacksPerHour} packs in the hour before a draw. More packs, more entries.`,
  },
  holders: {
    name: "Long holders",
    icon: "star",
    stat: (r) => `${shareOfSupply(r.giftHoldBps)} held`,
    line: () => `Hold it without a break. Every full day held adds an entry.`,
  },
  blasters: {
    name: "Top blasters",
    icon: "bot",
    stat: (r) => `Top ${r.topBlasters} spend`,
    line: (r) => `The biggest spenders over ${r.blasterDays} days, holding ${shareOfSupply(r.giftHoldBps)}. One entry per $10.`,
  },
};

const short = (s: string | null | undefined) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "–");
const tokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

/** A meter in blocks, like the wallet's HP bar. */
function Blocks({ share, tone = "bg-volt" }: { share: number; tone?: string }) {
  const filled = Math.round(Math.min(1, Math.max(0, share)) * 20);
  return (
    <div className="flex gap-[3px]" role="presentation">
      {Array.from({ length: 20 }, (_, i) => <span key={i} className={`h-3 flex-1 ${i < filled ? tone : "bg-bone/10"}`} />)}
    </div>
  );
}

function DrawRow({ draw }: { draw: Draw }) {
  const [open, setOpen] = useState(false);
  const won = draw.winner && ["drawn", "claimed", "expired"].includes(draw.state);
  return (
    <li className="border-t border-line first:border-t-0">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="grid w-full grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-2.5 text-left hover:bg-raised">
        <span className="num whitespace-nowrap text-[12.5px] text-faint">{new Date(draw.slotAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <span className="min-w-0 truncate text-[13.5px]">
          {won ? (
            <>
              <b>{draw.machineCode ? packLabel(draw.machineCode) : money(draw.prize, true)} pack</b>
              <span className="text-mute"> to </span>
              <span className="num">{short(draw.winner)}</span>
              {draw.state === "expired" ? <span className="text-faint"> · unclaimed, back in the pool</span> : draw.state === "claimed" ? <span className="text-faint"> · claimed</span> : null}
            </>
          ) : draw.state === "committed" ? (
            <span className="text-mute">Waiting for slot <span className="num">{draw.targetSlot}</span> to seed it</span>
          ) : (
            <span className="text-mute">Rolled over · {draw.reason?.toLowerCase()}</span>
          )}
        </span>
        <span className="text-[12px] text-faint">{draw.group ? GROUPS[draw.group].name : ""}</span>
      </button>
      {open && draw.entriesHash ? (
        <div className="num grid gap-1 break-all px-3.5 pb-3 text-[12px] text-faint">
          <div>{draw.entries} {draw.entries === 1 ? "entry" : "entries"} · hash <span className="text-mute">{draw.entriesHash}</span></div>
          {draw.targetSlot ? <div>Seed block: slot <span className="text-mute">{draw.targetSlot}</span>{draw.blockhash ? <> · <span className="text-mute">{draw.blockhash}</span></> : null}</div> : <div>Seeded on the server (test mode)</div>}
          {draw.seed ? <div>Seed <span className="text-mute">{draw.seed}</span></div> : null}
          <a href={`${GATEWAY}/flywheel/draws/${draw.id}`} target="_blank" rel="noreferrer noopener" className="w-fit text-rare hover:underline">Every entry, to check it yourself</a>
        </div>
      ) : null}
    </li>
  );
}

export default function TreasuryPage() {
  const now = useNow();
  const data = useQuery({ queryKey: ["treasury"], refetchInterval: 15_000, queryFn: () => api<Treasury>("/flywheel") });
  const t = data.data;
  const r = t?.rules;

  const total = t ? t.pools.drops + t.pools.cashback + t.pools.gifts + t.pools.giftReserved + t.pools.revenue : null;
  const giftShare = r ? r.giftBps / 10_000 : 0.2;
  const burnShare = Math.round((r?.saleBuybackBps ?? 5_000) / 100);
  const split = [
    { label: "Pulse drops", share: Math.max(0, 1 - CASHBACK_SHARE - giftShare), pool: t?.pools.drops, tone: "bg-gold", text: "text-gold" },
    { label: "Cashback", share: CASHBACK_SHARE, pool: t?.pools.cashback, tone: "bg-teal", text: "text-teal" },
    { label: "Gift pool", share: giftShare, pool: t ? t.pools.gifts + t.pools.giftReserved : undefined, tone: "bg-rare", text: "text-rare" },
  ];

  // The next draw, worked out locally so the countdown rolls over on time.
  const nextSlot = r ? giftSlot(now, r.giftIntervalMin) + r.giftIntervalMin * 60_000 : null;
  const next = nextSlot !== null ? (nextSlot - now) / 1000 : null;
  const turn = r && nextSlot !== null ? giftGroupOrder(nextSlot, r.giftIntervalMin)[0]! : null;
  const prize = t && r ? giftPrize(t.pools.gifts, r.giftSpendBps, r.giftTiers) : null;
  const smallest = r ? Math.min(...r.giftTiers) : 0;
  const needed = r && r.giftSpendBps > 0 ? Math.ceil((smallest * 10_000) / r.giftSpendBps) : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-2 px-2 pb-2 sm:px-3">
        <PageHeader title="Treasury" subtitle={`Where trading fees and Pulse sales go: drops, cashback, gifts, and burning ${BRAND.tokenTicker}.`} />

        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="slab p-4 sm:p-5" aria-label="Treasury">
            <div className="pixel text-[12px] uppercase leading-none text-faint">In the treasury</div>
            <div className="num mt-2 text-[40px] font-bold leading-none tracking-tight">{total === null ? "–" : money(total)}</div>
            <div className="mt-5 text-[12.5px] text-faint">Every $1 of trading fees</div>
            <div className="mt-1.5 flex h-4 gap-[3px]" role="presentation">
              {split.map((s) => <span key={s.label} className={s.tone} style={{ width: `${s.share * 100}%` }} />)}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {split.map((s) => (
                <div key={s.label} className="px-cut bg-raised px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[12.5px] text-mute"><span className={`h-2 w-2 ${s.tone}`} />{s.label} <span className={`num ml-auto font-semibold ${s.text}`}>{Math.round(s.share * 100)}%</span></div>
                  <div className="num mt-1 text-[18px] font-semibold">{money(s.pool, true)}</div>
                </div>
              ))}
            </div>
            <div className="mt-5 text-[12.5px] text-faint">Every $1 winners pay on Pulse</div>
            <div className="mt-1.5 flex h-4 gap-[3px]" role="presentation">
              <span className="bg-gold" style={{ width: `${100 - burnShare}%` }} />
              <span className="bg-cherry" style={{ width: `${burnShare}%` }} />
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="px-cut bg-raised px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-[12.5px] text-mute"><span className="h-2 w-2 bg-gold" />Back into Pulse drops <span className="num ml-auto font-semibold text-gold">{100 - burnShare}%</span></div>
                <div className="mt-1 text-[12.5px] text-faint">Keeps cards dropping.</div>
              </div>
              <div className="px-cut bg-raised px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-[12.5px] text-mute"><span className="h-2 w-2 bg-cherry" />Buyback and burn <span className="num ml-auto font-semibold text-cherry">{burnShare}%</span></div>
                <div className="mt-1 text-[12.5px] text-faint">Waiting for the next buyback <b className="num text-bone">{money(t?.pools.revenue, true)}</b></div>
              </div>
            </div>
          </section>

          <section className="slab flex flex-col p-4 sm:p-5" aria-label="Next gift draw">
            <div className="flex items-center gap-2 text-gold"><PixelIcon name="pack" /><span className="pixel text-[12px] uppercase leading-none">Next gift draw</span></div>
            <div className="num mt-3 text-[44px] font-bold leading-none tracking-tight">{next === null ? "–" : clock(next)}</div>
            <div className="mt-1.5 text-[13.5px] text-mute">{turn ? <><b className="text-bone">{GROUPS[turn].name}</b>&apos;s turn</> : null}</div>
            <div className="mt-5">
              {prize ? (
                <div className="px-cut bg-raised px-3 py-2.5">
                  <div className="text-[12.5px] text-faint">Prize</div>
                  <div className="num text-[20px] font-semibold text-gold">{money(prize, true)} pack</div>
                </div>
              ) : (
                <div>
                  <div className="mb-1.5 flex text-[12.5px] text-faint">Pool filling <span className="num ml-auto text-mute">{money(t?.pools.gifts, true)} / {money(needed, true)}</span></div>
                  <Blocks share={needed ? (t?.pools.gifts ?? 0) / needed : 0} tone="bg-rare" />
                  <div className="mt-1.5 text-[12.5px] text-faint">The first {money(smallest, true)} pack unlocks at {money(needed, true)}. Until then each draw rolls over.</div>
                </div>
              )}
            </div>
            {turn && r ? <p className="mt-auto pt-4 text-[12.5px] text-faint">{GROUPS[turn].line(r)}</p> : null}
          </section>
        </div>

        <section className="grid gap-2 sm:grid-cols-3" aria-label="How to win">
          {(["active", "holders", "blasters"] as const).map((group) => (
            <div key={group} className={`slab p-4 ${turn === group ? "ring-1 ring-gold" : ""}`}>
              <div className="flex items-center gap-2 text-gold"><PixelIcon name={GROUPS[group].icon} /><span className="pixel text-[12px] uppercase leading-none">{GROUPS[group].name}</span>{turn === group ? <span className="pixel ml-auto text-[10px] uppercase text-gold">Up next</span> : null}</div>
              <div className="pixel mt-3 text-[20px] uppercase leading-none text-bone">{r ? GROUPS[group].stat(r) : "–"}</div>
              <p className="mt-2 text-[13px] text-mute">{r ? GROUPS[group].line(r) : ""}</p>
            </div>
          ))}
        </section>
        <div className="px-box flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-mute">
          <span className="text-gold"><PixelIcon name="star" /></span>
          <span>Every feature on {BRAND.name} (Pulse, packs, Market, limit orders and gifts) takes at least <b className="text-bone">{r ? shareOfSupply(r.accessBps) : "–"}</b> of {BRAND.tokenTicker}&apos;s supply, checked live every time. Winners have {r?.claimHours ?? 24} hours to claim.</span>
        </div>

        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="slab self-start" aria-label="Gift draws">
            <SectionTitle icon={<PixelIcon name="pack" />}>Gift draws</SectionTitle>
            <ul className="border-t border-line">
              {(t?.draws ?? []).map((draw) => <DrawRow key={draw.id} draw={draw} />)}
              {t && t.draws.length === 0 ? <li className="px-3.5 py-3 text-mute">The first draw runs on the next half hour.</li> : null}
            </ul>
            <p className="border-t border-line px-3.5 py-2.5 text-[12px] text-faint">
              Each draw publishes a hash of its entries, then takes its seed from a Solana block that didn&apos;t exist yet. Open a draw to check it.
            </p>
          </section>

          <section className="slab self-start" aria-label="Buyback and burn">
            <SectionTitle icon={<PixelIcon name="pulse" />}>Buyback and burn</SectionTitle>
            <div className="grid grid-cols-2 gap-2 border-t border-line p-3.5">
              <div className="px-cut bg-raised px-3 py-2.5"><div className="text-[12px] text-faint">Spent</div><div className="num text-[18px] font-semibold">{money(t?.totals.usdcSpent, true)}</div></div>
              <div className="px-cut bg-raised px-3 py-2.5"><div className="text-[12px] text-faint">Burned</div><div className="num text-[18px] font-semibold">{tokens.format(t?.totals.tenrBurned ?? 0)}</div></div>
            </div>
            <p className="px-3.5 pb-3 text-[13px] text-mute">{burnShare}% of every dollar winners pay on Pulse, for cards and sealed packs, buys {BRAND.tokenTicker} at market every few minutes and burns it. The rest refills the drops pool.</p>
            <ul className="border-t border-line">
              {(t?.buybacks ?? []).map((b) => (
                <li key={b.id} className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[13px] first:border-t-0">
                  <span className="num min-w-0 flex-1 truncate">{money(b.usdcIn, true)} → {b.tenrOut ? tokens.format(b.tenrOut) : "–"} <span className="text-faint">{b.stage === "DONE" ? "burned" : b.stage.toLowerCase()}</span></span>
                  {b.burnSig ? <a className="text-faint hover:text-bone" href={`https://solscan.io/tx/${b.burnSig}`} target="_blank" rel="noreferrer noopener">tx</a> : null}
                  <span className="text-[12px] text-faint">{ago(b.at, now)}</span>
                </li>
              ))}
              {t && t.buybacks.length === 0 ? <li className="px-3.5 py-2.5 text-[13px] text-faint">No buybacks yet.</li> : null}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
