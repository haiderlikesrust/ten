"use client";

import { matchesRule, type AutoRule } from "@gemdex/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, CardThumb, Empty, Field, Grade, PageHeader, Pill, SectionTitle, inputClass } from "@/components/bits";
import { api } from "@/lib/api";
import { cardTitle, money } from "@/lib/format";
import { useMe } from "@/lib/session";
import type { AutoRuleRow, Listing } from "@/lib/types";
import { useUi } from "@/lib/ui";

const BLANK = { name: "", category: "", grader: "", minGrade: "", maxPriceUsd: "", minDiscountPct: "", search: "", dailyBudgetUsd: "" };
type Form = typeof BLANK;

/** Starting points that already make sense, so a first rule takes one click. */
const TEMPLATES: Array<{ title: string; hint: string; form: Partial<Form> }> = [
  { title: "Gem 10s below value", hint: "Any 10, 10% under insured, up to $150", form: { name: "Gem 10s below value", minGrade: "10", minDiscountPct: "10", maxPriceUsd: "150", dailyBudgetUsd: "300" } },
  { title: "Charizard steals", hint: "Any Charizard 15% under insured, up to $300", form: { name: "Charizard steals", search: "Charizard", minDiscountPct: "15", maxPriceUsd: "300", dailyBudgetUsd: "600" } },
  { title: "Cheap slabs", hint: "Anything 25% under insured, up to $25", form: { name: "Cheap slabs", minDiscountPct: "25", maxPriceUsd: "25", dailyBudgetUsd: "100" } },
  { title: "PSA 9+ under value", hint: "PSA 9 and up, 20% under insured, up to $80", form: { name: "PSA 9+ under value", grader: "PSA", minGrade: "9", minDiscountPct: "20", maxPriceUsd: "80", dailyBudgetUsd: "200" } },
];

const SAMPLE = 500;

/** The same check the worker runs on every new listing, on the form as it stands. */
function draftRule(form: Form): AutoRule {
  return {
    id: "draft", enabled: true, name: form.name, category: form.category || null, grader: form.grader || null,
    minGrade: form.minGrade ? Number(form.minGrade) : null, maxPrice: Math.round((Number(form.maxPriceUsd) || 0) * 1e6),
    minDiscountPct: Number(form.minDiscountPct) || 0, search: form.search.trim() || null, dailyBudget: Number.MAX_SAFE_INTEGER,
  };
}

function Preview({ form, ready }: { form: Form; ready: boolean }) {
  const recent = useQuery({ queryKey: ["listings", "rule-preview"], queryFn: () => api<{ rows: Listing[] }>(`/listings?limit=${SAMPLE}`), staleTime: 30_000 });
  const rows = recent.data?.rows ?? [];
  const matches = useMemo(() => (ready ? rows.filter((listing) => matchesRule(draftRule(form), listing, 0)) : []), [form, ready, rows]);
  return (
    <section className="slab min-w-0" aria-label="Rule preview">
      <SectionTitle right={ready ? <span className="num text-[12.5px] text-faint">{matches.length} of the newest {rows.length}</span> : null}>Would buy right now</SectionTitle>
      {!ready ? (
        <p className="px-3.5 pb-3.5 text-[13.5px] text-faint">Set a max price and a daily budget, and this shows which listings your rule would buy today.</p>
      ) : matches.length === 0 ? (
        <p className="px-3.5 pb-3.5 text-[13.5px] text-faint">Nothing listed right now matches. Loosen the discount or raise the max price to catch more.</p>
      ) : (
        <ul className="flex flex-col gap-1 px-2 pb-2">
          {matches.slice(0, 6).map((listing) => (
            <li key={listing.nft} className="tile grid grid-cols-[30px_minmax(0,1fr)_auto_auto] items-center gap-3 px-2 py-1.5">
              <CardThumb src={listing.image} alt="" size={30} zoom />
              <Link href={`/card/${listing.nft}`} className="flex min-w-0 items-center gap-2 hover:text-gold">
                <span className="truncate text-[13px] font-medium">{cardTitle(listing.name)}</span>
                <Grade grader={listing.grader} grade={listing.grade} />
              </Link>
              {listing.discountPct !== null && listing.discountPct > 0 ? <Pill tone="good">-{listing.discountPct}%</Pill> : <span />}
              <span className="num text-[13.5px] font-semibold">{money(listing.price, true)}</span>
            </li>
          ))}
          {matches.length > 6 ? <li className="px-2 pt-1 text-[12.5px] text-faint">and {matches.length - 6} more</li> : null}
        </ul>
      )}
    </section>
  );
}

export default function AutoPage() {
  const me = useMe();
  const client = useQueryClient();
  const setConnectOpen = useUi((s) => s.setConnectOpen);
  const toast = useUi((s) => s.toast);
  const [form, setForm] = useState(BLANK);
  const rules = useQuery({ queryKey: ["auto"], enabled: !!me, queryFn: () => api<AutoRuleRow[]>("/auto") });
  const facets = useQuery({ queryKey: ["facets"], queryFn: () => api<{ categories: Array<{ value: string }>; graders: Array<{ value: string }> }>("/listings/facets") });
  const refresh = () => client.invalidateQueries({ queryKey: ["auto"] });

  const create = useMutation({
    mutationFn: () =>
      api("/auto", {
        body: {
          name: form.name || "My rule", category: form.category, grader: form.grader, minGrade: form.minGrade ? Number(form.minGrade) : undefined,
          maxPriceUsd: Number(form.maxPriceUsd), minDiscountPct: form.minDiscountPct ? Number(form.minDiscountPct) : 0, search: form.search, dailyBudgetUsd: Number(form.dailyBudgetUsd),
        },
      }),
    onSuccess: () => {
      setForm(BLANK);
      toast({ tone: "ok", title: "Rule is live" });
      void refresh();
    },
    onError: (error) => toast({ tone: "bad", title: (error as Error).message }),
  });
  const toggle = useMutation({ mutationFn: (rule: AutoRuleRow) => api(`/auto/${rule.id}`, { method: "PATCH", body: { enabled: !rule.enabled } }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/auto/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
    onError: (error) => toast({ tone: "bad", title: "Could not delete that rule", detail: (error as Error).message }),
  });
  const set = (key: keyof Form, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const ready = Number(form.maxPriceUsd) > 0 && Number(form.dailyBudgetUsd) > 0;

  if (!me) {
    return (
      <Empty title="Let rules do the buying" icon={<Bot size={22} aria-hidden="true" />}>
        <p>Connect to create rules that buy underpriced cards the moment they list.</p>
        <div className="mt-3"><Button tone="primary" onClick={() => setConnectOpen(true)}>Connect</Button></div>
      </Empty>
    );
  }

  const list = rules.data ?? [];
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-2 px-2 pb-2 sm:px-3">
        <PageHeader title="Auto-Buy" subtitle="Rules watch every new listing and buy the moment one matches." />

        <section aria-label="Templates" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {TEMPLATES.map((template) => (
            <button
              key={template.title}
              type="button"
              onClick={() => setForm({ ...BLANK, ...template.form })}
              className="tile flex flex-col items-start gap-1 p-3 text-left transition-colors hover:bg-raised"
            >
              <span className="pixel text-[12px] uppercase leading-none text-gold">Template</span>
              <span className="text-[14.5px] font-semibold">{template.title}</span>
              <span className="text-[12.5px] text-faint">{template.hint}</span>
            </button>
          ))}
        </section>

        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[360px_minmax(0,1fr)]">
          <form
            className="slab flex flex-col gap-2.5 self-start p-4"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <h2 className="pixel text-[13px] uppercase leading-none">New rule</h2>
            <Field label="Name"><input className={inputClass} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Cheap PSA 10s" /></Field>
            <Field label="Name contains"><input className={inputClass} value={form.search} onChange={(e) => set("search", e.target.value)} placeholder="Charizard" /></Field>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Category">
                <select className={inputClass} value={form.category} onChange={(e) => set("category", e.target.value)}>
                  <option value="">Any</option>
                  {facets.data?.categories.map((c) => <option key={c.value}>{c.value}</option>)}
                </select>
              </Field>
              <Field label="Grader">
                <select className={inputClass} value={form.grader} onChange={(e) => set("grader", e.target.value)}>
                  <option value="">Any</option>
                  {facets.data?.graders.map((g) => <option key={g.value}>{g.value}</option>)}
                </select>
              </Field>
              <Field label="Min grade"><input className={inputClass} inputMode="decimal" value={form.minGrade} onChange={(e) => set("minGrade", e.target.value)} placeholder="10" /></Field>
              <Field label="Min discount %"><input className={inputClass} inputMode="decimal" value={form.minDiscountPct} onChange={(e) => set("minDiscountPct", e.target.value)} placeholder="20" /></Field>
              <Field label="Max price (USDC)"><input className={inputClass} inputMode="decimal" required value={form.maxPriceUsd} onChange={(e) => set("maxPriceUsd", e.target.value)} placeholder="200" /></Field>
              <Field label="Daily budget (USDC)"><input className={inputClass} inputMode="decimal" required value={form.dailyBudgetUsd} onChange={(e) => set("dailyBudgetUsd", e.target.value)} placeholder="500" /></Field>
            </div>
            <Button type="submit" tone="primary" className="h-11" disabled={!ready || create.isPending}>Create rule</Button>
            <p className="text-[12.5px] text-faint">Rules buy from your trading wallet with no confirmation, only within these limits.</p>
          </form>

          <div className="flex min-w-0 flex-col gap-2 self-start">
            <Preview form={form} ready={ready} />

            <section className="slab min-w-0">
              <SectionTitle right={<span className="num text-[12.5px] text-faint">{list.length}</span>}>Your rules</SectionTitle>
              {list.length === 0 ? (
                <p className="px-3.5 pb-3.5 text-[13.5px] text-faint">No rules yet. Pick a template above or build one, and it starts watching the moment you create it.</p>
              ) : (
                <ul className="flex flex-col gap-1.5 px-2 pb-2">
                  {list.map((rule) => (
                    <li key={rule.id} className="tile flex flex-wrap items-center gap-3 p-3">
                      <div className="min-w-[180px] flex-1">
                        <div className="flex items-center gap-2 text-[15px] font-bold">
                          <span className={`h-2 w-2 ${rule.enabled ? "bg-teal" : "bg-faint"}`} />
                          {rule.name}
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {rule.search ? <Pill>{rule.search}</Pill> : null}
                          {rule.category ? <Pill>{rule.category}</Pill> : null}
                          {rule.grader ? <Pill>{rule.grader}{rule.minGrade ? ` ${rule.minGrade}+` : ""}</Pill> : null}
                          {rule.minDiscountPct > 0 ? <Pill tone="good">-{rule.minDiscountPct}%+</Pill> : null}
                          <Pill>Max {money(rule.maxPrice)}</Pill>
                          <Pill>{money(rule.dailyBudget)}/day</Pill>
                        </div>
                      </div>
                      <div className="flex gap-1.5">
                        <Button className="h-9" onClick={() => toggle.mutate(rule)}>{rule.enabled ? "Pause" : "Resume"}</Button>
                        <Button tone="danger" className="h-9" onClick={() => remove.mutate(rule.id)}>Delete</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
