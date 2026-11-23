"use client";

import { useQuery } from "@tanstack/react-query";
import { Trophy } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CardThumb, Empty, PageHeader, Segmented } from "@/components/bits";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { api } from "@/lib/api";
import { cardTitle, money } from "@/lib/format";
import { useMe } from "@/lib/session";

type Period = "24h" | "7d" | "30d" | "all";
type Sort = "profit" | "snipes" | "best" | "volume";

interface Row {
  rank: number;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  xHandle: string | null;
  snipes: number;
  spent: number;
  value: number;
  profit: number;
  best: number;
  bestCard: { nft: string; name: string | null; image: string | null; gain: number } | null;
}

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: "24h", label: "24H" }, { value: "7d", label: "7D" }, { value: "30d", label: "30D" }, { value: "all", label: "All" },
];
const SORTS: Array<{ value: Sort; label: string }> = [
  { value: "profit", label: "Profit" }, { value: "snipes", label: "Snipes" }, { value: "best", label: "Biggest win" }, { value: "volume", label: "Volume" },
];

const signed = (micros: number) => `${micros >= 0 ? "+" : "−"}${money(Math.abs(micros))}`;
const tone = (micros: number) => (micros >= 0 ? "text-teal" : "text-loss");
const MEDAL = ["text-gold", "text-mute", "text-[#c58a52]"];

function Name({ row }: { row: Row }) {
  const inner = (
    <span className="flex min-w-0 items-center gap-2.5">
      <ProfileAvatar name={row.name} src={row.avatarUrl} size={30} />
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-semibold">{row.username ? `@${row.username}` : row.name}</span>
        {row.xHandle ? <span className="block truncate text-[12px] text-faint">x.com/{row.xHandle}</span> : null}
      </span>
    </span>
  );
  // Only someone who has set up a profile has a page to open.
  return row.username ? <Link href={`/u/${row.username}`} className="min-w-0 hover:text-gold">{inner}</Link> : inner;
}

function BestCard({ card }: { card: Row["bestCard"] }) {
  if (!card) return <span className="text-[12.5px] text-faint">–</span>;
  return (
    <Link href={`/card/${card.nft}`} className="flex min-w-0 items-center justify-end gap-2 hover:text-gold" title={card.name ?? undefined}>
      <span className="min-w-0 text-right">
        <span className="num block text-[13px] font-semibold text-teal">{signed(card.gain)}</span>
        <span className="block truncate text-[12px] text-faint">{cardTitle(card.name ?? "A card")}</span>
      </span>
      <CardThumb src={card.image} alt="" size={28} />
    </Link>
  );
}

export default function LeaderboardPage() {
  const me = useMe();
  const [period, setPeriod] = useState<Period>("7d");
  const [sort, setSort] = useState<Sort>("profit");
  const board = useQuery({
    queryKey: ["leaderboard", period, sort],
    queryFn: () => api<{ rows: Row[] }>(`/leaderboard?period=${period}&sort=${sort}`),
    refetchInterval: 30_000,
  });
  const rows = board.data?.rows ?? [];
  const grid = "grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-x-3 md:grid-cols-[40px_minmax(0,1fr)_70px_100px_110px_minmax(0,220px)]";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-2 px-2 pb-2 sm:px-3">
        <PageHeader
          title="Leaderboard"
          subtitle="Pulse snipers, ranked. Profit counts a sold card at what it sold for and a held one at its insured value, like Portfolio."
          right={<Segmented label="Period" value={period} onChange={setPeriod} options={PERIODS} />}
        />
        {me && !me.username ? (
          <Link href="/profile" className="slab flex items-center justify-between gap-3 px-4 py-3 text-[13.5px] hover:text-gold">
            <span>Pick a username and a picture so people can find you here.</span>
            <span className="font-semibold text-gold">Set up profile</span>
          </Link>
        ) : null}
        <section className="slab min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 pb-1 pt-3">
            <Segmented label="Rank by" value={sort} onChange={setSort} options={SORTS} />
            <span className="text-[12.5px] text-faint">Top 50</span>
          </div>
          {board.isLoading ? (
            <div className="px-4 py-10 text-center text-faint">Loading</div>
          ) : rows.length === 0 ? (
            <Empty title="No snipes yet" icon={<Trophy size={22} aria-hidden="true" />}>Buy a card on Pulse and you&apos;re on the board.</Empty>
          ) : (
            <div className="px-2 pb-2">
              <div className={`${grid} hidden px-2.5 pb-1.5 pt-2 text-[12px] font-medium text-faint md:grid`}>
                <span>#</span><span>Sniper</span><span className="text-right">Snipes</span><span className="text-right">Spent</span><span className="text-right">Profit</span><span className="text-right">Biggest win</span>
              </div>
              <ol className="flex flex-col gap-1">
                {rows.map((row) => (
                  <li key={`${row.rank}:${row.name}`} className={`tile ${grid} gap-y-1.5 px-2.5 py-2`}>
                    <span className={`pixel text-[15px] leading-none ${MEDAL[row.rank - 1] ?? "text-faint"}`}>{row.rank}</span>
                    <Name row={row} />
                    <span className="num text-right md:hidden">
                      <span className={`block text-[14px] font-semibold ${sort === "profit" ? tone(row.profit) : ""}`}>
                        {sort === "snipes" ? `${row.snipes} snipes` : sort === "best" ? signed(row.best) : sort === "volume" ? money(row.spent) : signed(row.profit)}
                      </span>
                      <span className="block text-[12px] text-faint">{sort === "snipes" ? signed(row.profit) : `${row.snipes} snipes`}</span>
                    </span>
                    <span className="num hidden text-right text-[13.5px] md:block">{row.snipes}</span>
                    <span className="num hidden text-right text-[13.5px] text-mute md:block">{money(row.spent)}</span>
                    <span className={`num hidden text-right text-[14px] font-semibold md:block ${tone(row.profit)}`}>{signed(row.profit)}</span>
                    <span className="hidden min-w-0 md:block"><BestCard card={row.bestCard} /></span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
