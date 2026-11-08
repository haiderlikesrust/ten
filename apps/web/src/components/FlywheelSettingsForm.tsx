"use client";

import { usd, type FlywheelSettings } from "@gemdex/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useUi } from "@/lib/ui";
import { Button, Field, SectionTitle, Toggle, inputClass } from "./bits";

/** Percent fields are stored as basis points; dollar fields as micro-USDC. */
const PERCENT = ["accessBps", "giftHoldBps", "giftBps", "giftSpendBps", "platformFeeBps", "buybackMaxSlippageBps"] as const;
const COUNT = ["giftIntervalMin", "activePacksPerHour", "topBlasters", "blasterDays", "claimHours", "winCooldownHours", "buybackEveryMin"] as const;

const LABELS: Record<(typeof PERCENT)[number] | (typeof COUNT)[number] | "buybackMinUsd", string> = {
  accessBps: "Access minimum (% of supply)",
  giftHoldBps: "Long holders and blasters need (% of supply)",
  giftBps: "Gift pool share of trading fees (%)",
  giftSpendBps: "Most of the pool one draw may spend (%)",
  platformFeeBps: "Platform fee on Market and packs (%)",
  buybackMaxSlippageBps: "Buyback max slippage (%)",
  giftIntervalMin: "Minutes between draws",
  activePacksPerHour: "Packs in the hour to count as active",
  topBlasters: "Top blasters",
  blasterDays: "Days of spend for blasters",
  claimHours: "Hours to claim a gift",
  winCooldownHours: "Hours before a winner can win again",
  buybackEveryMin: "Minutes between buybacks",
  buybackMinUsd: "Smallest buyback ($)",
};

/** Admin: the $TENR flywheel's numbers (docs/FLYWHEEL.md). */
export function FlywheelSettingsForm({ settings }: { settings: FlywheelSettings }) {
  const client = useQueryClient();
  const toast = useUi((s) => s.toast);
  const [form, setForm] = useState<Record<string, string>>({});
  const [tiers, setTiers] = useState("");
  const [excluded, setExcluded] = useState("");
  const [gifts, setGifts] = useState(settings.giftsEnabled);
  const [buyback, setBuyback] = useState(settings.buybackEnabled);

  useEffect(() => {
    const next: Record<string, string> = { buybackMinUsd: String(settings.buybackMinUsd / 1e6) };
    for (const key of PERCENT) next[key] = String(settings[key] / 100);
    for (const key of COUNT) next[key] = String(settings[key]);
    setForm(next);
    setTiers(settings.giftTiers.map((t) => t / 1e6).join(", "));
    setExcluded(settings.excludedWallets.join("\n"));
    setGifts(settings.giftsEnabled);
    setBuyback(settings.buybackEnabled);
  }, [settings]);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { buybackMinUsd: usd(Number(form.buybackMinUsd)), giftsEnabled: gifts, buybackEnabled: buyback };
      for (const key of PERCENT) body[key] = Math.round(Number(form[key]) * 100);
      for (const key of COUNT) body[key] = Math.round(Number(form[key]));
      body.giftTiers = tiers.split(/[,\s]+/).map(Number).filter((n) => n > 0).map(usd).sort((a, b) => b - a);
      body.excludedWallets = excluded.split(/\s+/).map((w) => w.trim()).filter(Boolean);
      return api("/admin/settings/flywheel", { method: "PATCH", body });
    },
    onSuccess: () => {
      toast({ tone: "ok", title: "Flywheel saved" });
      void client.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error) => toast({ tone: "bad", title: (error as Error).message }),
  });

  return (
    <form className="slab" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <SectionTitle right={<Button tone="primary" type="submit" className="h-8" disabled={save.isPending}>Save</Button>}>Flywheel</SectionTitle>
      <div className="grid grid-cols-1 gap-3 px-4 pb-3 sm:grid-cols-2">
        {[...PERCENT, ...COUNT, "buybackMinUsd" as const].map((key) => (
          <Field key={key} label={LABELS[key]}>
            <input className={`${inputClass} num`} inputMode="decimal" value={form[key] ?? ""} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
          </Field>
        ))}
        <Field label="Gift pack prices ($, highest first)">
          <input className={`${inputClass} num`} value={tiers} onChange={(e) => setTiers(e.target.value)} />
        </Field>
        <Field label="Wallets that can never win (team), one per line">
          <textarea className={`${inputClass} num !h-[88px] py-2 text-[13px]`} value={excluded} onChange={(e) => setExcluded(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-4 px-4 pb-4">
        <Toggle checked={gifts} onChange={setGifts}>Gift draws on</Toggle>
        <Toggle checked={buyback} onChange={setBuyback}>Buyback and burn on</Toggle>
      </div>
    </form>
  );
}
