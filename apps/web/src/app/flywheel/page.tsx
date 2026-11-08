"use client";

import { BRAND, giftSlot, shareOfSupply } from "@gemdex/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader, SectionTitle, StatTile } from "@/components/bits";
import { PixelIcon } from "@/components/pixel";
import { GATEWAY, api } from "@/lib/api";
import { ago, clock, money, packLabel } from "@/lib/format";
import { useNow } from "@/lib/ui";

interface Draw {
  id: string;
  slotAt: string;
  group: "active" | "holders" | "blasters" | null;
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

interface Flywheel {
  pools: { drops: number; cashback: number; gifts: number; giftReserved: number; revenue: number };
  rules: {
    accessBps: number; giftHoldBps: number; giftBps: number; giftIntervalMin: number; giftTiers: number[]; activePacksPerHour: number;
    topBlasters: number; blasterDays: number; claimHours: number; platformFeeBps: number; giftsEnabled: boolean; buybackEnabled: boolean;
  };
  nextDrawAt: string;
  draws: Draw[];
  buybacks: Array<{ id: string; stage: string; usdcIn: number; tenrOut: number | null; swapSig: string | null; burnSig: string | null; at: string }>;
  totals: { usdcSpent: number; tenrBurned: number };
}

const GROUP: Record<NonNullable<Draw["group"]>, string> = { active: "Active", holders: "Long holders", blasters: "Top blasters" };
const short = (s: string | null | undefined) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "–");
const tokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

function DrawRow({ draw }: { draw: Draw }) {
  const [open, setOpen] = useState(false);
  const won = draw.winner && (draw.state === "drawn" || draw.state === "claimed" || draw.state === "expired");
  return (
    <li className="border-t border-line first:border-t-0">
      <button type="button" onClick={() => setOpen((o) => !o)} className="grid w-full grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-2.5 text-left hover:bg-raised" aria-expanded={open}>
        <span className="num text-[12.5px] text-faint">{new Date(draw.slotAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <span className="min-w-0 truncate">
          {won ? (
            <>
              <span className="font-semibold">{money(draw.prize, true)} {draw.machineCode ? packLabel(draw.machineCode) : ""}</span>
              <span className="text-mute"> to </span>
              <span className="num">{short(draw.winner)}</span>
              <span className="text-faint"> · {draw.group ? GROUP[draw.group] : ""}{draw.state === "expired" ? " · unclaimed, back in the pool" : draw.state === "claimed" ? " · claimed" : ""}</span>
            </>
          ) : draw.state === "committed" ? (
            <span className="text-mute">Waiting for slot <span className="num">{draw.targetSlot}</span> to seed the draw</span>
          ) : (
            <span className="text-mute">Rolled over: {draw.reason}</span>
          )}
        </span>
        <span className="text-[12.5px] text-faint">{draw.entries ? `${draw.entries} in` : ""}</span>
      </button>
      {open && draw.entriesHash ? (
        <div className="num grid gap-1 break-all px-3.5 pb-3 text-[12px] text-faint">
          <div>Entries hash <span className="text-mute">{draw.entriesHash}</span></div>
          {draw.targetSlot ? <div>Seed block: slot <span className="text-mute">{draw.targetSlot}</span>{draw.blockhash ? <> · <span className="text-mute">{draw.blockhash}</span></> : null}</div> : <div>Paper draw: seeded on the server</div>}
          {draw.seed ? <div>Seed <span className="text-mute">{draw.seed}</span></div> : null}
          <a href={`${GATEWAY}/flywheel/draws/${draw.id}`} target="_blank" rel="noreferrer noopener" className="w-fit text-rare hover:underline">Every entry, to check it yourself</a>
        </div>
      ) : null}
    </li>
  );
}

export default function FlywheelPage() {
  const now = useNow();
  const data = useQuery({ queryKey: ["flywheel"], refetchInterval: 15_000, queryFn: () => api<Flywheel>("/flywheel") });
  const f = data.data;
  // Worked out locally from the interval, so the countdown rolls over on time between refreshes.
  const next = f ? (giftSlot(now, f.rules.giftIntervalMin) + f.rules.giftIntervalMin * 60_000 - now) / 1000 : null;
  const tiers = f ? [...f.rules.giftTiers].sort((a, b) => a - b) : [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-2 px-2 pb-2 sm:px-3">
        <PageHeader title="Flywheel" subtitle={`Where ${BRAND.name}'s money goes, and how ${BRAND.tokenTicker} holders get it back.`} />

        <section className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Pools">
          <StatTile label="Pulse drops pool" value={money(f?.pools.drops, true)} />
          <StatTile label="Cashback pool" value={money(f?.pools.cashback, true)} />
          <StatTile label="Gift pool" value={money(f?.pools.gifts, true)} hint={f?.pools.giftReserved ? `${money(f.pools.giftReserved, true)} waiting to be claimed` : undefined} />
          <StatTile label="Waiting for buyback" value={money(f?.pools.revenue, true)} />
        </section>

        <section className="grid gap-2 lg:grid-cols-3" aria-label="How it works">
          <div className="slab p-4">
            <div className="flex items-center gap-2 text-gold"><PixelIcon name="star" /><span className="pixel text-[12px] uppercase">Hold to trade</span></div>
            <p className="mt-2 text-mute">
              Buying on Pulse, opening packs and claiming gifts take at least <b className="text-bone">{f ? shareOfSupply(f.rules.accessBps) : "–"}</b> of {BRAND.tokenTicker}&apos;s supply in your wallet. Checked live, every time. Browsing is open to everyone.
            </p>
          </div>
          <div className="slab p-4">
            <div className="flex items-center gap-2 text-gold"><PixelIcon name="pack" /><span className="pixel text-[12px] uppercase">Gift packs</span></div>
            <p className="mt-2 text-mute">
              Every {f?.rules.giftIntervalMin ?? 30} minutes one player wins a {tiers.length ? `${money(tiers[0], true)} to ${money(tiers.at(-1), true)}` : ""} pack, sized by the gift pool. The groups take turns:
            </p>
            <ul className="mt-2 grid gap-1 text-[13.5px] text-mute">
              <li><b className="text-bone">Active</b>: {f?.rules.activePacksPerHour ?? 10}+ packs opened or sniped in the hour before.</li>
              <li><b className="text-bone">Long holders</b>: {f ? shareOfSupply(f.rules.giftHoldBps) : "2%"}+ held, more entries per day.</li>
              <li><b className="text-bone">Top blasters</b>: the {f?.rules.topBlasters ?? 10} biggest spenders over {f?.rules.blasterDays ?? 7} days, holding {f ? shareOfSupply(f.rules.giftHoldBps) : "2%"}+.</li>
            </ul>
          </div>
          <div className="slab p-4">
            <div className="flex items-center gap-2 text-gold"><PixelIcon name="pulse" /><span className="pixel text-[12px] uppercase">Buyback and burn</span></div>
            <p className="mt-2 text-mute">
              A {f ? shareOfSupply(f.rules.platformFeeBps) : "1%"} fee on Market buys and packs buys {BRAND.tokenTicker} on the market and burns it, on a schedule, whatever the price. {f?.rules.giftBps ? `${shareOfSupply(f.rules.giftBps)} of trading fees fills the gift pool.` : ""}
            </p>
            <div className="mt-3 flex gap-4 text-[13px]">
              <span className="text-faint">Spent <b className="num text-bone">{money(f?.totals.usdcSpent, true)}</b></span>
              <span className="text-faint">Burned <b className="num text-bone">{tokens.format(f?.totals.tenrBurned ?? 0)}</b> {BRAND.tokenTicker}</span>
            </div>
          </div>
        </section>

        <section className="slab" aria-label="Gift draws">
          <SectionTitle icon={<PixelIcon name="pack" />} right={<span className="num pr-1 text-[12.5px] text-faint">Next draw in <b className="text-gold">{next !== null ? clock(next) : "–"}</b></span>}>
            Gift draws
          </SectionTitle>
          <ul className="border-t border-line">
            {(f?.draws ?? []).map((draw) => <DrawRow key={draw.id} draw={draw} />)}
            {f && f.draws.length === 0 ? <li className="px-3.5 py-3 text-mute">No draws yet. The first one runs on the next half hour.</li> : null}
          </ul>
          <p className="border-t border-line px-3.5 py-2.5 text-[12.5px] text-faint">
            Each draw publishes a hash of its entries first, then takes its seed from a Solana block that didn&apos;t exist yet. The winner is the entry the seed lands on, so anyone can check it.
          </p>
        </section>

        <section className="slab" aria-label="Buybacks">
          <SectionTitle icon={<PixelIcon name="pulse" />}>Buybacks and burns</SectionTitle>
          <ul className="border-t border-line">
            {(f?.buybacks ?? []).map((b) => (
              <li key={b.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-line px-3.5 py-2.5 first:border-t-0">
                <span className="min-w-0 truncate"><b className="num">{money(b.usdcIn, true)}</b> <span className="text-mute">bought</span> <b className="num">{b.tenrOut ? tokens.format(b.tenrOut) : "–"}</b> <span className="text-mute">{BRAND.tokenTicker}{b.stage === "DONE" ? ", burned" : ` · ${b.stage.toLowerCase()}`}</span></span>
                <span className="flex gap-3 text-[12.5px] text-faint">
                  {b.burnSig ? <a className="hover:text-bone" href={`https://solscan.io/tx/${b.burnSig}`} target="_blank" rel="noreferrer noopener">burn</a> : null}
                  {ago(b.at, now)}
                </span>
              </li>
            ))}
            {f && f.buybacks.length === 0 ? <li className="px-3.5 py-3 text-mute">No buybacks yet.</li> : null}
          </ul>
        </section>
      </div>
    </div>
  );
}
