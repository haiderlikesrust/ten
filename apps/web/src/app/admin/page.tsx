"use client";

import { usd, type FlywheelSettings } from "@gemdex/core";
import { FlywheelSettingsForm } from "@/components/FlywheelSettingsForm";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Power, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Empty, Field, PageHeader, Pill, SectionTitle, StatTile, inputClass } from "@/components/bits";
import { api } from "@/lib/api";
import { ago, clock, money, pauseReason } from "@/lib/format";
import { useMe } from "@/lib/session";
import type { DropsStatus } from "@/lib/types";
import { useNow, useUi } from "@/lib/ui";

interface DropSettings {
  enabled: boolean; minPrice: number; maxPrice: number; crashLo: number; crashHi: number; hiddenShare: number; intervalFloorSec: number; ttlSec: number;
  relists: number; winCooldownSec: number; dailySpendCap: number; walletFloor: number; budgetPerDayFallback: number; machineMix: Array<{ code: string; weight: number }>;
}

interface Overview {
  mode: string;
  settings: { drops: DropSettings; fees: { cashbackBps: number; minSwapUsd: number; maxSlippageBps: number }; cashback: { dailyCapPerUser: number; maxRateBps: number }; flywheel: FlywheelSettings };
  ops: { killSwitch: boolean; reconcileHold: boolean };
  status: DropsStatus | null;
  accounts: Array<{ account: string; micros: number }>;
  runs: Array<{ id: string; stage: string; usdcOut: number | null; cashback: number | null; drops: number | null; createdAt: string; error: string | null }>;
  checks: Array<{ id: number; ok: boolean; at: string; mismatches: Array<{ account: string; book: number; chain: number }> }>;
  stateCounts: Array<{ state: string; kind: string; n: number }>;
  alerts: { stuckHolds: number; openClaims: number; packs24h: number };
}

export default function AdminPage() {
  const me = useMe();
  const client = useQueryClient();
  const toast = useUi((s) => s.toast);
  const now = useNow();
  const query = useQuery({ queryKey: ["admin"], enabled: !!me?.isAdmin, queryFn: () => api<Overview>("/admin/overview"), refetchInterval: 10_000 });
  const [form, setForm] = useState<Record<string, string>>({});
  const [mix, setMix] = useState("");

  const s = query.data?.settings.drops;
  useEffect(() => {
    if (!s) return;
    setForm({
      minPrice: String(s.minPrice / 1e6), maxPrice: String(s.maxPrice / 1e6), crashLo: String(s.crashLo * 100), crashHi: String(s.crashHi * 100),
      hiddenShare: String(s.hiddenShare * 100), intervalFloorSec: String(s.intervalFloorSec), ttlSec: String(s.ttlSec), winCooldownSec: String(s.winCooldownSec),
      dailySpendCap: String(s.dailySpendCap / 1e6), walletFloor: String(s.walletFloor / 1e6), budgetPerDayFallback: String(s.budgetPerDayFallback / 1e6),
    });
    setMix(s.machineMix.map((m) => `${m.code}:${m.weight}`).join("\n"));
  }, [s?.maxPrice, s?.minPrice, s?.hiddenShare, s?.winCooldownSec]); // eslint-disable-line react-hooks/exhaustive-deps

  const ops = useMutation({
    mutationFn: (body: { killSwitch?: boolean; reconcileHold?: boolean }) => api("/admin/ops", { body }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin"] }),
  });
  const save = useMutation({
    mutationFn: () => {
      const n = (key: string) => Number(form[key]);
      return api("/admin/settings/drops", {
        method: "PATCH",
        body: {
          minPrice: usd(n("minPrice")), maxPrice: usd(n("maxPrice")), crashLo: n("crashLo") / 100, crashHi: n("crashHi") / 100, hiddenShare: n("hiddenShare") / 100,
          intervalFloorSec: n("intervalFloorSec"), ttlSec: n("ttlSec"), winCooldownSec: n("winCooldownSec"), dailySpendCap: usd(n("dailySpendCap")), walletFloor: usd(n("walletFloor")),
          budgetPerDayFallback: usd(n("budgetPerDayFallback")),
          machineMix: mix.split(/\n+/).map((line) => line.split(":")).filter(([code, weight]) => code && Number(weight) > 0).map(([code, weight]) => ({ code: code!.trim(), weight: Number(weight) })),
        },
      });
    },
    onSuccess: () => {
      toast({ tone: "ok", title: "Settings saved", detail: "Applies from the next drop" });
      void client.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error) => toast({ tone: "bad", title: (error as Error).message }),
  });

  if (!me?.isAdmin) return <Empty title="Admins only" icon={<ShieldAlert size={22} aria-hidden="true" />} />;
  const data = query.data;
  if (!data) return <div className="p-6 text-faint">Loading</div>;

  const balance = (name: string) => data.accounts.find((a) => a.account === name)?.micros ?? 0;
  const status = data.status;
  const next = status?.nextDropAt ? (new Date(status.nextDropAt).getTime() - now) / 1000 : null;
  const input = (key: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input className={inputClass} inputMode="decimal" value={form[key] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
    </Field>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-2 px-2 pb-2 sm:px-3">
        <PageHeader
          title="Operations"
          right={
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={data.mode === "mainnet" ? "bad" : "warn"}><span className="capitalize">{data.mode}</span></Pill>
              {data.ops.reconcileHold ? <Button tone="danger" onClick={() => ops.mutate({ reconcileHold: false })}>Clear reconcile hold</Button> : null}
              <Button tone={data.ops.killSwitch ? "snipe" : "danger"} onClick={() => ops.mutate({ killSwitch: !data.ops.killSwitch })}>
                <Power size={15} aria-hidden="true" /> {data.ops.killSwitch ? "Resume everything" : "Kill switch"}
              </Button>
            </div>
          }
        />

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(156px,1fr))]">
          <StatTile label="Pulse wallet" value={money(balance("drops"), true)} />
          <StatTile label="Cashback pool" value={money(balance("cashback"), true)} />
          <StatTile label="Fee wallet" value={money(balance("fee"), true)} />
          <StatTile label="Spent 24h" value={money(status?.spent24h, true)} />
          <StatTile label="Cost per card" value={money(status?.burnPerDrop)} />
          <StatTile label="Interval" value={status?.intervalSec ? `${status.intervalSec}s` : "–"} tone="warn" />
          <StatTile label="Next card" value={status?.pausedFor ? "Paused" : next !== null && next > 0 ? clock(next) : "Soon"} tone={status?.pausedFor ? "bad" : undefined} hint={pauseReason(status?.pausedFor)} />
          <StatTile label="Budget per day" value={money(status?.budgetPerDay, true)} />
          <StatTile label="Open claims" value={data.alerts.openClaims} />
          <StatTile label="Stuck holds" value={data.alerts.stuckHolds} tone={data.alerts.stuckHolds > 0 ? "bad" : undefined} />
          <StatTile label="Packs 24h" value={data.alerts.packs24h} />
        </section>

        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          <form
            className="slab min-w-0 self-start"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <SectionTitle right={<Button type="submit" tone="primary" className="h-9" disabled={save.isPending}>Save</Button>}>Pulse settings</SectionTitle>
            <div className="grid grid-cols-2 gap-2.5 px-4 pb-3 md:grid-cols-3">
              {input("minPrice", "Min price $")}
              {input("maxPrice", "Sealed pack max $")}
              {input("crashLo", "Deepest crash, % of insured")}
              {input("crashHi", "Shallowest crash, % of insured")}
              {input("hiddenShare", "Hidden share %")}
              {input("ttlSec", "Price moves for (s)")}
              {input("intervalFloorSec", "Fastest interval (s)")}
              {input("winCooldownSec", "Win cooldown (s)", "0 turns it off")}
              {input("dailySpendCap", "Daily spend cap $")}
              {input("walletFloor", "Wallet floor $")}
              {input("budgetPerDayFallback", "Fallback budget $/day")}
            </div>
            <div className="px-4 pb-4">
              <Field label="Machine mix (code:weight, one per line)">
                <textarea className={`${inputClass} num !h-[120px] py-2 text-[13px]`} value={mix} onChange={(e) => setMix(e.target.value)} />
              </Field>
            </div>
          </form>

          <div className="flex min-w-0 flex-col gap-3">
            {data.settings.flywheel ? <FlywheelSettingsForm settings={data.settings.flywheel} /> : null}
            <section className="slab">
              <SectionTitle>Fee pipeline</SectionTitle>
              {data.runs.length === 0 ? (
                <Empty title="No runs yet">Runs start once fees are worth swapping.</Empty>
              ) : (
                <ul className="flex flex-col gap-1 px-2 pb-2">
                  {data.runs.map((run) => (
                    <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-cut px-2.5 py-1.5 text-[13px] hover:bg-raised">
                      <span className="num w-9 text-faint">{ago(run.createdAt, now)}</span>
                      <Pill tone={run.stage === "DONE" ? "good" : run.stage === "SKIPPED" ? "plain" : "warn"}>{run.stage}</Pill>
                      <span className="num ml-auto text-mute">{money(run.usdcOut)}</span>
                      <span className="num text-teal">{run.cashback ? `Cashback ${money(run.cashback)}` : ""}</span>
                      <span className="num text-gold">{run.drops ? `Drops ${money(run.drops)}` : ""}</span>
                      {run.usdcOut && run.cashback !== null && run.drops !== null && run.usdcOut - run.cashback - run.drops > 0 ? <span className="num text-rare">Gifts {money(run.usdcOut - run.cashback - run.drops)}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="slab">
              <SectionTitle>Reconciliation</SectionTitle>
              {data.checks.length === 0 ? (
                <Empty title="No checks yet" />
              ) : (
                <ul className="flex flex-col gap-1 px-2 pb-2">
                  {data.checks.map((check) => (
                    <li key={check.id} className="flex items-center gap-3 px-cut px-2.5 py-1.5 text-[13px]">
                      <span className="num w-9 text-faint">{ago(check.at, now)}</span>
                      <Pill tone={check.ok ? "good" : "bad"}>{check.ok ? "Books match" : `${check.mismatches.length} mismatch`}</Pill>
                      {!check.ok ? <span className="num truncate text-faint">{check.mismatches[0]?.account}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="slab">
              <SectionTitle>Cards by state</SectionTitle>
              <div className="flex flex-wrap gap-1 px-4 pb-4">
                {data.stateCounts.map((row) => <Pill key={`${row.kind}${row.state}`}>{row.kind === "hidden" ? "Hidden" : "Revealed"} {row.state} <span className="num">{row.n}</span></Pill>)}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
