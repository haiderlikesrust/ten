"use client";

import { BRAND } from "@gemdex/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gift } from "lucide-react";
import { useState } from "react";
import { Button, Empty, PageHeader, Pill, SectionTitle, inputClass } from "@/components/bits";
import { api } from "@/lib/api";
import { ago, money, packLabel } from "@/lib/format";
import { useMe, useMeta } from "@/lib/session";
import type { Portfolio, Tier } from "@/lib/types";
import { useNow, useUi } from "@/lib/ui";

interface Rewards {
  earned: number;
  packs: number;
  pool: number;
  dailyCap: number;
  tiers: Tier[];
  history: Array<{ machineCode: string; amount: number; rateBps: number; at: string }>;
}

const TIER_STYLE = ["wash-uncommon", "wash-rare", "wash-epic"];
const BLOCKS = 24;
const MONTH_MS = 30 * 86_400_000;
const tokens = (n: number) => Math.round(n).toLocaleString("en-US");

/** Like the wallet meter in the navbar: blocks fill as you close in on the next tier. */
function TierMeter({ share }: { share: number }) {
  const filled = Math.round(Math.max(0, Math.min(1, share)) * BLOCKS);
  return (
    <div className="flex gap-[3px]" role="presentation">
      {Array.from({ length: BLOCKS }, (_, i) => <span key={i} className={`h-3 flex-1 ${i < filled ? "bg-volt" : "bg-bone/10"}`} />)}
    </div>
  );
}

export default function RewardsPage() {
  const me = useMe();
  const meta = useMeta();
  const client = useQueryClient();
  const setConnectOpen = useUi((s) => s.setConnectOpen);
  const toast = useUi((s) => s.toast);
  const now = useNow();
  const [paperTokens, setPaperTokens] = useState("1000000");
  const rewards = useQuery({ queryKey: ["rewards"], enabled: !!me, queryFn: () => api<Rewards>("/rewards"), refetchInterval: 20_000 });
  const portfolio = useQuery({ queryKey: ["portfolio"], enabled: !!me, queryFn: () => api<Portfolio>("/portfolio") });
  const setPaper = useMutation({
    mutationFn: () => api("/rewards/paper-tokens", { body: { tokens: Number(paperTokens.replace(/[,\s]/g, "")) } }),
    onSuccess: () => {
      void client.invalidateQueries();
      toast({ tone: "ok", title: "Paper balance set" });
    },
  });

  if (!me) {
    return (
      <Empty title={`Hold ${BRAND.tokenTicker}, earn cashback`} icon={<Gift size={22} aria-hidden="true" />}>
        <p>30% of creator fees fund USDC cashback when holders open packs.</p>
        <div className="mt-3"><Button tone="primary" onClick={() => setConnectOpen(true)}>Connect</Button></div>
      </Empty>
    );
  }

  const tiers = [...(rewards.data?.tiers ?? meta.data?.tiers ?? [])].sort((a, b) => a.minBalance - b.minBalance);
  const next = tiers.find((tier) => tier.minBalance > me.tokens) ?? null;
  const floor = [...tiers].reverse().find((tier) => tier.minBalance <= me.tokens)?.minBalance ?? 0;
  const share = next ? (me.tokens - floor) / Math.max(1, next.minBalance - floor) : 1;
  // What packs you opened here in the last 30 days cost, so each tier shows what it would have paid back.
  const packs = [...(portfolio.data?.held ?? []), ...(portfolio.data?.exited ?? [])].filter((h) => h.source === "gacha" && now - new Date(h.acquiredAt).getTime() < MONTH_MS);
  const spent = packs.reduce((sum, h) => sum + h.cost, 0);
  const history = rewards.data?.history ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-2 px-2 pb-2 sm:px-3">
        <PageHeader title="Rewards" subtitle={`Hold ${BRAND.tokenTicker} and earn USDC back every time you open a pack.`} />

        <section className="slab grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto]" aria-label="Your tier">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="pixel text-[12px] uppercase leading-none text-faint">Your tier</span>
              <span className="pixel text-[24px] uppercase leading-none">{me.tier?.name ?? "None"}</span>
              {me.tier ? <Pill tone="good">{(me.tier.rateBps / 100).toFixed(0)}% back</Pill> : null}
            </div>
            <TierMeter share={share} />
            <p className="num text-[13.5px] text-mute">
              You hold <span className="font-semibold text-bone">{tokens(me.tokens)} {BRAND.tokenTicker}</span>
              {next ? <>. Hold <span className="font-semibold text-gold">{tokens(next.minBalance - me.tokens)}</span> more to reach {next.name} at {(next.rateBps / 100).toFixed(0)}% back.</> : ". That is the top tier."}
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-x-6 gap-y-1 self-center">
            <div><dt className="text-[12px] text-faint">Cashback earned</dt><dd className="num text-[18px] font-semibold text-teal">{money(rewards.data?.earned ?? 0)}</dd></div>
            <div><dt className="text-[12px] text-faint">Packs rewarded</dt><dd className="num text-[18px] font-semibold">{rewards.data?.packs ?? 0}</dd></div>
            <div><dt className="text-[12px] text-faint">Cashback pool</dt><dd className="num text-[18px] font-semibold">{money(rewards.data?.pool, true)}</dd></div>
          </dl>
        </section>

        <section className="slab">
          <SectionTitle right={spent > 0 ? <span className="num text-[12.5px] text-faint">Your packs, last 30 days: {money(spent, true)}</span> : null}>Holder tiers</SectionTitle>
          <ul className="grid grid-cols-1 gap-2 px-3 sm:grid-cols-3">
            {tiers.map((tier, index) => {
              const active = me.tier?.name === tier.name;
              return (
                <li key={tier.name} className={`px-cut border p-4 ${TIER_STYLE[index] ?? ""} ${active ? "border-volt" : "border-line"}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-[16px] font-bold">{tier.name}</span>
                    {active ? <Pill tone="warn">Yours</Pill> : null}
                  </div>
                  <div className="num mt-2 text-[34px] font-bold leading-none">{(tier.rateBps / 100).toFixed(0)}%</div>
                  <div className="mt-1.5 text-[13.5px] text-mute">Hold {tokens(tier.minBalance)} {BRAND.tokenTicker}</div>
                  <div className="num mt-2 text-[13px] text-faint">
                    {spent > 0
                      ? <>Up to <span className="font-semibold text-teal">{money(Math.floor((spent * tier.rateBps) / 10_000))}</span> back on your last 30 days of packs</>
                      : <>{money(Math.floor((25_000_000 * tier.rateBps) / 10_000))} back on a $25 pack</>}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-col gap-1 p-4 text-[13.5px] text-mute">
            <p>Your tier uses your lowest balance across random snapshots in the last 24 hours, so hold before you open.</p>
            <p>Each machine has its own cashback cap, shown on the Gacha Desk, and there is a {money(rewards.data?.dailyCap)} daily limit per wallet.</p>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="slab self-start">
            <SectionTitle>Recent cashback</SectionTitle>
            {history.length === 0 ? (
              <p className="px-3.5 pb-3.5 text-[13.5px] text-faint">{me.tier ? "Open a pack on the Gacha Desk to earn your first cashback." : `Reach a tier, then open a pack to earn your first cashback.`}</p>
            ) : (
              <ul className="flex flex-col gap-1 px-2 pb-2">
                {history.map((row, index) => (
                  <li key={index} className="tile flex items-center gap-3 px-3 py-2">
                    <span className="num w-10 text-[12.5px] text-faint">{ago(row.at, now)}</span>
                    <span className="min-w-0 flex-1 truncate font-semibold">{packLabel(row.machineCode)}</span>
                    <span className="num text-[13px] text-faint">{(row.rateBps / 100).toFixed(1)}%</span>
                    <span className="num font-bold text-teal">+{money(row.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {meta.data?.paper ? (
            <section className="slab self-start">
              <SectionTitle>Try a tier</SectionTitle>
              <form
                className="flex flex-wrap items-center gap-2 px-4 pb-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  setPaper.mutate();
                }}
              >
                <input className={`${inputClass} num !w-44`} inputMode="numeric" aria-label="Paper token balance" value={Number(paperTokens.replace(/[,\s]/g, "")) ? tokens(Number(paperTokens.replace(/[,\s]/g, ""))) : paperTokens} onChange={(e) => setPaperTokens(e.target.value)} />
                <Button type="submit">Set paper balance</Button>
                <span className="text-[13px] text-faint">Paper only. Real tiers read your wallet.</span>
              </form>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
