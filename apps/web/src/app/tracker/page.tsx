"use client";

import { shortAddress } from "@gemdex/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radar, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button, CardThumb, Empty, PageHeader, Pill, Rarity, SectionTitle, Skeleton, inputClass } from "@/components/bits";
import { api } from "@/lib/api";
import { ago, cardTitle, money } from "@/lib/format";
import { useMe } from "@/lib/session";
import { useNow, useUi } from "@/lib/ui";

interface TrackerData {
  wallets: Array<{ wallet: string; label: string }>;
  feed: Array<{ kind: "pull" | "listing"; wallet: string; at: string; name: string; image: string | null; nft: string; value: number | null; rarity: string | null }>;
}

interface Puller {
  wallet: string;
  pulls: number;
  value: number;
  best: number | null;
  bestName: string | null;
  bestImage: string | null;
  bestNft: string | null;
  lastAt: string;
}

const BOARD = "grid-cols-[26px_minmax(0,1fr)_auto] md:grid-cols-[26px_128px_52px_88px_minmax(0,1fr)_92px]";

/** Who pulled the most value today. The natural first place to find someone worth following. */
function Leaderboard({ rows, loading, tracked, labels, onTrack }: { rows: Puller[]; loading: boolean; tracked: Set<string>; labels: Map<string, string>; onTrack: (wallet: string) => void }) {
  const now = useNow();
  return (
    <section className="slab min-w-0 self-start" aria-label="Top pullers">
      <SectionTitle right={<span className="text-[12.5px] text-faint">By value pulled, last 24 hours</span>}>Top pullers</SectionTitle>
      <div className={`hidden gap-x-3 px-3.5 pb-1.5 text-[12px] font-medium text-faint md:grid ${BOARD}`}>
        <span>#</span><span>Wallet</span><span className="text-right">Pulls</span><span className="text-right">Pulled</span><span>Best pull</span><span />
      </div>
      {loading ? <Skeleton rows={6} /> : rows.length === 0 ? (
        <p className="px-3.5 pb-3.5 text-[13.5px] text-faint">No pulls in the last 24 hours.</p>
      ) : (
        <ol className="flex flex-col gap-1 px-2 pb-2">
          {rows.map((row, index) => {
            const following = tracked.has(row.wallet);
            return (
              <li key={row.wallet} className={`tile grid items-center gap-x-3 px-1.5 py-1.5 md:px-1.5 ${BOARD}`}>
                <span className={`pixel text-center text-[13px] leading-none ${index < 3 ? "text-gold" : "text-faint"}`}>{index + 1}</span>
                <div className="min-w-0">
                  <div className="num truncate text-[13.5px] font-semibold">{labels.get(row.wallet) ?? shortAddress(row.wallet)}</div>
                  <div className="num truncate text-[12px] text-faint md:hidden">{row.pulls} pulls · {money(row.value, true)} · {ago(row.lastAt, now)}</div>
                  <div className="num hidden truncate text-[12px] text-faint md:block">last {ago(row.lastAt, now)} ago</div>
                </div>
                <span className="num hidden text-right text-[13px] text-mute md:block">{row.pulls}</span>
                <span className="num hidden text-right text-[13.5px] font-semibold text-teal md:block">{money(row.value, true)}</span>
                <div className="hidden min-w-0 items-center gap-2 md:flex">
                  {row.bestNft ? <Link href={`/card/${row.bestNft}`} aria-label={row.bestName ?? "Best pull"}><CardThumb src={row.bestImage} alt="" size={26} zoom /></Link> : null}
                  <span className="min-w-0 truncate text-[12.5px] text-mute">{row.bestName ? cardTitle(row.bestName) : "–"}</span>
                  <span className="num shrink-0 text-[12.5px] font-medium">{money(row.best, true)}</span>
                </div>
                <div className="flex justify-end">
                  {following ? <Pill tone="good">Tracking</Pill> : <Button className="h-8 px-2.5 text-[13px]" onClick={() => onTrack(row.wallet)}>Track</Button>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export default function TrackerPage() {
  const me = useMe();
  const client = useQueryClient();
  const setConnectOpen = useUi((s) => s.setConnectOpen);
  const toast = useUi((s) => s.toast);
  const now = useNow();
  const [wallet, setWallet] = useState("");
  const [label, setLabel] = useState("");
  const query = useQuery({ queryKey: ["tracker"], enabled: !!me, queryFn: () => api<TrackerData>("/tracker"), refetchInterval: 15_000 });
  const pullers = useQuery({ queryKey: ["pullers"], enabled: !!me, queryFn: () => api<Puller[]>("/pullers"), refetchInterval: 30_000 });

  const refresh = () => client.invalidateQueries({ queryKey: ["tracker"] });
  const add = useMutation({
    mutationFn: (target: { wallet: string; label?: string }) => api("/tracker", { body: target }),
    onSuccess: () => {
      setWallet("");
      setLabel("");
      void refresh();
    },
    onError: (error) => toast({ tone: "bad", title: (error as Error).message }),
  });
  const remove = useMutation({ mutationFn: (target: string) => api(`/tracker/${target}`, { method: "DELETE" }), onSuccess: refresh });

  if (!me) {
    return (
      <Empty title="Follow the big collectors" icon={<Radar size={22} aria-hidden="true" />}>
        <p>Connect to see today's top pullers and track any wallet's pulls and listings.</p>
        <div className="mt-3"><Button tone="primary" onClick={() => setConnectOpen(true)}>Connect</Button></div>
      </Empty>
    );
  }

  const wallets = query.data?.wallets ?? [];
  const labels = new Map(wallets.map((w) => [w.wallet, w.label]));
  const tracked = new Set(wallets.map((w) => w.wallet));
  const feed = query.data?.feed ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1360px] flex flex-col gap-2 px-2 pb-2 sm:px-3">
        <PageHeader title="Tracker" subtitle="See who is pulling the most right now, and follow any wallet's pulls and listings." />
        <form
          className="slab flex flex-wrap items-center gap-2 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate({ wallet: wallet.trim(), label });
          }}
        >
          <input className={`${inputClass} min-w-[220px] flex-[2]`} aria-label="Wallet address" value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Paste any Solana wallet to track" />
          <input className={`${inputClass} min-w-[140px] flex-1`} aria-label="Label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, optional" />
          <Button type="submit" tone="primary" className="h-10" disabled={!wallet.trim() || add.isPending}>Track wallet</Button>
        </form>

        <div className="grid grid-cols-1 gap-2 xl:grid-cols-[minmax(0,1fr)_400px]">
          <Leaderboard rows={pullers.data ?? []} loading={pullers.isLoading} tracked={tracked} labels={labels} onTrack={(target) => add.mutate({ wallet: target })} />

          <aside className="flex min-w-0 flex-col gap-2 self-start">
            <section className="slab">
              <SectionTitle right={<span className="num text-[12.5px] text-faint">{wallets.length}</span>}>Tracking</SectionTitle>
              {wallets.length === 0 ? (
                <p className="px-3.5 pb-3.5 text-[13.5px] text-faint">Nobody yet. Track someone from the leaderboard, or paste any wallet above.</p>
              ) : (
                <ul className="flex flex-col gap-0.5 px-2 pb-2">
                  {wallets.map((w) => (
                    <li key={w.wallet} className="flex items-center gap-2 px-cut px-2 py-1 hover:bg-raised">
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{w.label}</span>
                      <span className="num text-[12.5px] text-faint">{shortAddress(w.wallet)}</span>
                      <button type="button" aria-label={`Stop tracking ${w.label}`} className="flex h-7 w-7 items-center justify-center rounded-[2px] text-faint hover:bg-bone/[0.07] hover:text-loss" onClick={() => remove.mutate(w.wallet)}><X size={15} aria-hidden="true" /></button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="slab min-w-0" aria-label="Activity feed">
              <SectionTitle>Their latest</SectionTitle>
              {feed.length === 0 ? (
                <p className="px-3.5 pb-3.5 text-[13.5px] text-faint">{wallets.length === 0 ? "Pulls and listings from the wallets you track show up here." : "Nothing new from them yet."}</p>
              ) : (
                <ul className="flex flex-col gap-1 px-2 pb-2">
                  {feed.map((item) => (
                    <li key={`${item.kind}${item.nft}${item.at}`} className="tile flex items-center gap-2.5 px-2 py-1.5">
                      <Link href={`/card/${item.nft}`} aria-label={item.name}><CardThumb src={item.image} alt={item.name} size={30} zoom /></Link>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]"><span className="text-mute">{labels.get(item.wallet) ?? shortAddress(item.wallet)}</span> {item.kind === "pull" ? "pulled" : "listed"} <Link href={`/card/${item.nft}`} className="font-semibold hover:text-gold">{cardTitle(item.name)}</Link></div>
                        <div className="mt-0.5 flex items-center gap-1">
                          <Pill tone={item.kind === "pull" ? "info" : "plain"}>{item.kind === "pull" ? "Pull" : "Listing"}</Pill>
                          <Rarity rarity={item.rarity} />
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="num text-[13.5px] font-semibold">{money(item.value, true)}</div>
                        <div className="num text-[12px] text-faint">{ago(item.at, now)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
