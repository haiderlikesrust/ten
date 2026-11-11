"use client";

import { usd, type FlywheelSettings } from "@gemdex/core";
import { FlywheelSettingsForm } from "@/components/FlywheelSettingsForm";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Power, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Empty, Field, PageHeader, Pill, SectionTitle, StatTile, Toggle, inputClass } from "@/components/bits";
import { api } from "@/lib/api";
import { ago, clock, money, pauseReason } from "@/lib/format";
import { useMe } from "@/lib/session";
import type { DropsStatus } from "@/lib/types";
import { useNow, useUi } from "@/lib/ui";

interface DropSettings {
  enabled: boolean; minPrice: number; maxPrice: number; crashLo: number; crashHi: number; hiddenShare: number; intervalFloorSec: number; ttlSec: number;
  relists: number; winCooldownSec: number; dailySpendCap: number; walletFloor: number; budgetPerDayFallback: number; ladder: PackTier[];
}

interface PackTier { price: number; unlockAt: number; weight: number; enabled: boolean; machines: string[] }
/** A pack size as typed in the form: dollars and a comma list, until it is saved. */
interface TierRow { price: string; unlockAt: string; weight: string; enabled: boolean; machines: string }

const toRow = (tier: PackTier): TierRow => ({ price: String(tier.price / 1e6), unlockAt: String(tier.unlockAt / 1e6), weight: String(tier.weight), enabled: tier.enabled, machines: tier.machines.join(", ") });

/**
 * A typed number, or null when it isn't one. Blank, "10%", "30s" and "1e3" are all refused: `Number()` reads a blank
 * as 0 and the rest as NaN, which is sent as null, and either would be saved over a working setting.
 */
function typedNumber(raw: string | undefined, max: number): number | null {
  const text = (raw ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return n <= max ? n : null;
}

/** How each Pulse setting is typed and stored: dollars as micro-USDC, percents as a share from 0 to 1, the rest whole. */
const FIELDS = {
  minPrice: "usd", maxPrice: "usd", crashLo: "pct", crashHi: "pct", hiddenShare: "pct", ttlSec: "whole", intervalFloorSec: "whole", winCooldownSec: "whole",
  dailySpendCap: "usd", walletFloor: "usd", budgetPerDayFallback: "usd",
} as const;
type FieldKey = keyof typeof FIELDS;
const FIELD_KEYS = Object.keys(FIELDS) as FieldKey[];
const FIELD_LABEL: Record<FieldKey, string> = {
  minPrice: "Min price", maxPrice: "Sealed pack max", crashLo: "Deepest crash", crashHi: "Shallowest crash", hiddenShare: "Hidden share", ttlSec: "Price moves for",
  intervalFloorSec: "Fastest interval", winCooldownSec: "Win cooldown", dailySpendCap: "Daily spend cap", walletFloor: "Wallet floor", budgetPerDayFallback: "Fallback budget",
};

const showField = (key: FieldKey, stored: number): string => String(FIELDS[key] === "usd" ? stored / 1e6 : FIELDS[key] === "pct" ? Math.round(stored * 1e4) / 100 : stored);

function readField(key: FieldKey, raw: string | undefined): number | null {
  const kind = FIELDS[key];
  const n = typedNumber(raw, kind === "usd" ? 1e9 : kind === "pct" ? 100 : 1e7);
  if (n === null) return null;
  if (kind === "usd") return Math.round(n * 1e6);
  if (kind === "pct") return n / 100;
  return Number.isInteger(n) ? n : null;
}

/** Whether two ladders say the same thing. Compared field by field: the database hands a saved one back with its fields in another order. */
function sameLadder(a: PackTier[], b: PackTier[]): boolean {
  const flat = (tier: PackTier) => [tier.price, tier.unlockAt, tier.weight, tier.enabled, tier.machines.join(",")].join("|");
  return a.length === b.length && a.every((tier, i) => flat(tier) === flat(b[i]!));
}

function fromRow(row: TierRow): PackTier | null {
  const price = typedNumber(row.price, 1e6);
  const unlockAt = typedNumber(row.unlockAt, 1e9);
  const weight = typedNumber(row.weight, 1e6);
  const machines = row.machines.split(/[\s,]+/).map((code) => code.trim().toLowerCase()).filter(Boolean);
  if (price === null || unlockAt === null || weight === null || !(price > 0) || machines.length === 0 || machines.some((code) => !/^[a-z0-9_]{1,40}$/.test(code))) return null;
  return { price: Math.round(price * 1e6), unlockAt: Math.round(unlockAt * 1e6), weight, enabled: row.enabled, machines };
}

/**
 * Which pack sizes Pulse opens, and when. Admin only: nothing here is shown to users, so a size switched off
 * simply stops dropping. The status line reads the pool as it is now, before packs already promised.
 */
function PackLadder({ rows, setRows, free }: { rows: TierRow[]; setRows: (rows: TierRow[]) => void; free: number }) {
  const patch = (index: number, change: Partial<TierRow>) => setRows(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const tiers = rows.map(fromRow);
  const open = tiers.map((tier) => !!tier && tier.enabled && tier.weight > 0 && free >= tier.unlockAt && free >= tier.price);
  const openWeight = tiers.reduce((sum, tier, i) => sum + (open[i] ? tier!.weight : 0), 0);
  return (
    <div className="px-4 pb-4">
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <span className="text-[12.5px] font-medium text-mute">Pack sizes</span>
        <Button type="button" className="h-8" onClick={() => setRows([...rows, { price: "", unlockAt: "", weight: "5", enabled: true, machines: "" }])}>Add size</Button>
      </div>
      <p className="pb-2.5 text-[12.5px] text-faint">
        A size opens once the Pulse pool's free money reaches its amount. Open sizes are mixed by weight, and one over $100 never drops twice in a row. Users never see this list.
      </p>
      <ul className="flex flex-col gap-2">
        {rows.map((row, index) => {
          const tier = tiers[index];
          const status = !tier ? "Needs a price, an amount, a weight and a machine" : !tier.enabled ? "Off" : tier.weight === 0 ? "Weight 0, never picked" : open[index] ? `Open, about ${Math.round((tier.weight / openWeight) * 100)}% of drops` : `Locked until ${money(Math.max(tier.unlockAt, tier.price), true)} free`;
          return (
            <li key={index} className="tile flex flex-col gap-2 p-2.5">
              <div className="grid grid-cols-3 items-end gap-2">
                <Field label="Pack $"><input className={`${inputClass} num`} inputMode="decimal" value={row.price} onChange={(e) => patch(index, { price: e.target.value })} /></Field>
                <Field label="Opens at $"><input className={`${inputClass} num`} inputMode="decimal" value={row.unlockAt} onChange={(e) => patch(index, { unlockAt: e.target.value })} /></Field>
                <Field label="Weight"><input className={`${inputClass} num`} inputMode="decimal" value={row.weight} onChange={(e) => patch(index, { weight: e.target.value })} /></Field>
              </div>
              <Field label="Machines, comma separated">
                <input className={`${inputClass} num text-[13px]`} value={row.machines} onChange={(e) => patch(index, { machines: e.target.value })} />
              </Field>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Toggle checked={row.enabled} onChange={(enabled) => patch(index, { enabled })}>On</Toggle>
                <span className={`text-[12.5px] ${open[index] ? "text-teal" : "text-faint"}`}>{status}</span>
                <button type="button" onClick={() => setRows(rows.filter((_, i) => i !== index))} className="ml-auto text-[12.5px] text-faint hover:text-loss">Remove</button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface Overview {
  mode: string;
  settings: { drops: DropSettings; fees: { cashbackBps: number; minSwapUsd: number; maxSlippageBps: number }; cashback: { dailyCapPerUser: number; maxRateBps: number }; flywheel: FlywheelSettings };
  ops: { killSwitch: boolean; reconcileHold: boolean; armedUntil: string | null; armedBy: string[] };
  status: DropsStatus | null;
  accounts: Array<{ account: string; micros: number }>;
  runs: Array<{ id: string; stage: string; usdcOut: number | null; cashback: number | null; drops: number | null; createdAt: string; error: string | null }>;
  checks: Array<{ id: number; ok: boolean; at: string; mismatches: Array<{ account: string; book: number; chain: number }> }>;
  stateCounts: Array<{ state: string; kind: string; n: number }>;
  alerts: { stuckHolds: number; openClaims: number; packs24h: number };
  moves: TreasuryMove[];
  treasuryWallets: { drops: string; cashback: string; feePayer: string } | null;
}

interface TreasuryMove { id: string; signature: string; wallet: string; state: string; amount: number | null; reason: string | null; createdAt: string }

/**
 * Money an admin sends into or out of the Drops or Cashback wallet by hand never reaches the books on its own, and
 * Pulse only spends what the books hold. Recording the transfer here books exactly what the chain shows moved.
 */
function TreasuryTransfers({ data, now }: { data: Overview; now: number }) {
  const client = useQueryClient();
  const toast = useUi((s) => s.toast);
  const [wallet, setWallet] = useState<"drops" | "cashback">("drops");
  const [signature, setSignature] = useState("");
  const record = useMutation({
    mutationFn: () => api("/admin/treasury-moves", { body: { wallet, signature: signature.trim() } }),
    onSuccess: () => {
      setSignature("");
      toast({ tone: "ok", title: "Transfer recorded", detail: "It reaches the books once the worker reads it, within a minute" });
      void client.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error) => toast({ tone: "bad", title: "Could not record that", detail: (error as Error).message }),
  });
  const addresses = data.treasuryWallets;
  const copy = (value: string) => void navigator.clipboard.writeText(value).then(() => toast({ tone: "ok", title: "Copied" }));
  return (
    <section className="slab">
      <SectionTitle>Treasury transfers</SectionTitle>
      <p className="px-4 text-[13px] text-mute">
        Funding Pulse or cashback, or sweeping spare money out? Send USDC yourself, then paste the transaction signature here. The books follow exactly what moved. Tenner's own transfers are booked by themselves.
      </p>
      {addresses ? (
        <div className="flex flex-col gap-1 px-4 pt-3">
          {([["Drops (Pulse pool)", addresses.drops], ["Cashback", addresses.cashback], ["Fee Payer (SOL only)", addresses.feePayer]] as const).map(([label, address]) => (
            <div key={label} className="flex items-center gap-2 text-[13px]">
              <span className="w-[150px] shrink-0 text-faint">{label}</span>
              <span className="num min-w-0 flex-1 truncate">{address}</span>
              <button type="button" aria-label={`Copy the ${label} address`} title="Copy address" onClick={() => copy(address)} className="flex h-7 w-7 shrink-0 items-center justify-center px-cut text-mute hover:bg-raised hover:text-bone">
                <Copy size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <form
        className="flex flex-wrap gap-2 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (signature.trim()) record.mutate();
        }}
      >
        <select className={`${inputClass} w-auto`} aria-label="Wallet" value={wallet} onChange={(e) => setWallet(e.target.value as "drops" | "cashback")}>
          <option value="drops">Drops</option>
          <option value="cashback">Cashback</option>
        </select>
        <input className={`${inputClass} num min-w-[200px] flex-1`} aria-label="Transaction signature" placeholder="Transaction signature" value={signature} onChange={(e) => setSignature(e.target.value)} />
        <Button type="submit" tone="primary" disabled={!signature.trim() || record.isPending}>Record</Button>
      </form>
      {data.moves.length > 0 ? (
        <ul className="flex flex-col gap-1 px-2 pb-2">
          {data.moves.map((move) => (
            <li key={move.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-cut px-2.5 py-1.5 text-[13px]">
              <span className="num w-9 text-faint">{ago(move.createdAt, now)}</span>
              <Pill tone={move.state === "BOOKED" ? "good" : move.state === "REFUSED" ? "bad" : "warn"}>{move.state === "BOOKED" ? "Booked" : move.state === "REFUSED" ? "Refused" : "Reading"}</Pill>
              <span className="text-mute">{move.wallet === "drops" ? "Drops" : "Cashback"}</span>
              <span className="num truncate text-faint">{move.signature.slice(0, 10)}…</span>
              {move.amount !== null ? <span className={`num ml-auto ${move.amount > 0 ? "text-teal" : "text-loss"}`}>{move.amount > 0 ? "+" : "-"}{money(Math.abs(move.amount))}</span> : null}
              {move.reason ? <span className="w-full pl-12 text-[12.5px] text-faint">{move.reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default function AdminPage() {
  const me = useMe();
  const client = useQueryClient();
  const toast = useUi((s) => s.toast);
  const now = useNow();
  const query = useQuery({ queryKey: ["admin"], enabled: !!me?.isAdmin, queryFn: () => api<Overview>("/admin/overview"), refetchInterval: 10_000 });
  const [form, setForm] = useState<Record<string, string>>({});
  const [ladder, setLadder] = useState<TierRow[]>([]);
  // True from the first edit until a save or a discard. The page refetches every 10 seconds, and a refetch must
  // never wipe what is being typed; while nothing is being typed, every change made elsewhere shows at once.
  const [dirty, setDirty] = useState(false);

  const s = query.data?.settings.drops;
  const stored = s ? JSON.stringify(s) : "";
  useEffect(() => {
    if (!s || dirty) return;
    setForm(Object.fromEntries(FIELD_KEYS.map((key) => [key, showField(key, s[key])])));
    setLadder(s.ladder.map(toRow));
  }, [stored, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const ops = useMutation({
    mutationFn: (body: { killSwitch?: boolean; reconcileHold?: boolean }) => api("/admin/ops", { body }),
    // Returning the refetch keeps the buttons disabled until the page shows the new state. A second click
    // before then would read the old state and switch it straight back.
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin"] }),
    onError: (error) => toast({ tone: "bad", title: "Could not change that", detail: (error as Error).message }),
  });
  // Mainnet signs nothing until an admin arms it, and each arm lasts two hours.
  const arm = useMutation({
    mutationFn: (action: "arm" | "disarm") => api<Overview["ops"]>(`/admin/${action}`, { body: {} }),
    onSuccess: (_next, action) => {
      toast(action === "disarm" ? { tone: "ok", title: "Disarmed", detail: "Nothing signs until an admin arms again" } : { tone: "ok", title: "Armed for 2 hours" });
      void client.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error) => toast({ tone: "bad", title: (error as Error).message }),
  });
  const save = useMutation({
    mutationFn: async () => {
      if (!s) throw new Error("Settings have not loaded yet");
      // Only what changed is sent, so a save never puts back a setting someone else changed in the meantime.
      const body: Record<string, unknown> = {};
      for (const key of FIELD_KEYS) {
        const value = readField(key, form[key]);
        if (value === null) throw new Error(`${FIELD_LABEL[key]} needs a plain number, with no % or letters`);
        if (Math.abs(value - s[key]) > 1e-9) body[key] = value;
      }
      const tiers = ladder.map(fromRow);
      if (tiers.length === 0 || tiers.some((tier) => !tier)) throw new Error("Each pack size needs a price, an amount, a weight and at least one machine");
      const sorted = [...(tiers as PackTier[])].sort((a, b) => a.price - b.price);
      if (sameLadder(sorted, s.ladder) === false) body.ladder = sorted;
      if (Object.keys(body).length === 0) return false;
      await api("/admin/settings/drops", { method: "PATCH", body });
      return true;
    },
    onSuccess: async (changed) => {
      // Reload first, then let the form follow the server again, so it never flashes the old values.
      await client.invalidateQueries({ queryKey: ["admin"] });
      setDirty(false);
      toast(changed ? { tone: "ok", title: "Settings saved", detail: "Applies from the next drop" } : { tone: "info", title: "Nothing changed" });
    },
    onError: (error) => toast({ tone: "bad", title: (error as Error).message }),
  });

  if (!me?.isAdmin) return <Empty title="Admins only" icon={<ShieldAlert size={22} aria-hidden="true" />} />;
  const data = query.data;
  if (!data) return <div className="p-6 text-faint">Loading</div>;

  const balance = (name: string) => data.accounts.find((a) => a.account === name)?.micros ?? 0;
  const armedUntil = data.ops.armedUntil ? new Date(data.ops.armedUntil).getTime() : 0;
  const armed = armedUntil > now && data.ops.armedBy.length > 0;
  const status = data.status;
  const next = status?.nextDropAt ? (new Date(status.nextDropAt).getTime() - now) / 1000 : null;
  const input = (key: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input
        className={inputClass}
        inputMode="decimal"
        value={form[key] ?? ""}
        onChange={(e) => {
          setDirty(true);
          setForm((f) => ({ ...f, [key]: e.target.value }));
        }}
      />
    </Field>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1360px] flex flex-col gap-2 px-2 pb-2 sm:px-3">
        <PageHeader
          title="Operations"
          right={
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={data.mode === "mainnet" ? "bad" : "warn"}><span className="capitalize">{data.mode}</span></Pill>
              {data.mode === "mainnet" ? (
                <>
                  <Pill tone={armed ? "good" : "bad"}>{armed ? `Armed until ${new Date(armedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Not armed"}</Pill>
                  <Button tone="primary" disabled={arm.isPending} onClick={() => arm.mutate("arm")}>{armed ? "Renew arm" : "Arm"}</Button>
                  {armed ? <Button disabled={arm.isPending} onClick={() => arm.mutate("disarm")}>Disarm</Button> : null}
                </>
              ) : null}
              {data.ops.reconcileHold ? <Button tone="danger" disabled={ops.isPending} onClick={() => ops.mutate({ reconcileHold: false })}>Clear reconcile hold</Button> : null}
              <Button tone={data.ops.killSwitch ? "snipe" : "danger"} disabled={ops.isPending} onClick={() => ops.mutate({ killSwitch: !data.ops.killSwitch })}>
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
            <SectionTitle
              right={
                <span className="flex items-center gap-2">
                  {dirty && !save.isPending ? <button type="button" onClick={() => setDirty(false)} className="text-[12.5px] text-faint hover:text-bone">Discard changes</button> : null}
                  <Button type="submit" tone="primary" className="h-9" disabled={save.isPending}>Save</Button>
                </span>
              }
            >
              Pulse settings
            </SectionTitle>
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
              {input("walletFloor", "Wallet floor $", "Kept back, never spent")}
              {input("budgetPerDayFallback", "Fallback budget $/day")}
            </div>
            <PackLadder
              rows={ladder}
              setRows={(rows) => {
                setDirty(true);
                setLadder(rows);
              }}
              free={balance("drops") - (readField("walletFloor", form.walletFloor) ?? 0)}
            />
          </form>

          <div className="flex min-w-0 flex-col gap-3">
            {data.mode !== "paper" ? <TreasuryTransfers data={data} now={now} /> : null}
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
