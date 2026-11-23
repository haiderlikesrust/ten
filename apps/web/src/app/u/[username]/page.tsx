"use client";

import { useQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CardThumb, Empty, Grade, Pill, SectionTitle, StatTile } from "@/components/bits";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { api } from "@/lib/api";
import { ago, cardTitle, money } from "@/lib/format";
import { sized } from "@/lib/image";
import { useMe } from "@/lib/session";
import { useNow } from "@/lib/ui";

interface Stats { snipes: number; spent: number; value: number; profit: number; best: number }
interface PublicProfile {
  profile: { name: string; username: string | null; bio: string | null; xHandle: string | null; avatarUrl: string | null; joinedAt: string };
  stats: { allTime: Stats; week: Stats };
  best: { nft: string; name: string | null; image: string | null; cost: number; gain: number } | null;
  recent: Array<{
    nft: string; name: string; image: string | null; grader: string | null; grade: string | null; cost: number; insuredValue: number | null;
    status: string; exitPrice: number | null; at: string;
  }>;
}

const signed = (micros: number) => `${micros >= 0 ? "+" : "−"}${money(Math.abs(micros))}`;
const good = (micros: number) => (micros >= 0 ? "good" : "bad") as "good" | "bad";

export default function ProfileView() {
  const { username } = useParams<{ username: string }>();
  const me = useMe();
  const now = useNow();
  const query = useQuery({
    queryKey: ["public-profile", username],
    queryFn: () => api<PublicProfile>(`/profiles/${encodeURIComponent(username)}`),
    retry: false,
  });

  if (query.isLoading) return <div className="p-6 text-faint">Loading</div>;
  const data = query.data;
  if (!data) return <Empty title="No such profile" icon={<UserRound size={22} aria-hidden="true" />}>Nobody has picked that username.</Empty>;
  const { profile, stats, best, recent } = data;
  const mine = !!me?.username && me.username.toLowerCase() === profile.username?.toLowerCase();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-2 px-2 pb-2 sm:px-3">
        <section className="slab flex flex-wrap items-center gap-4 px-4 py-4">
          <ProfileAvatar name={profile.name} src={profile.avatarUrl} size={84} />
          <div className="min-w-0 flex-1">
            <h1 className="pixel truncate text-[22px] uppercase leading-tight">@{profile.username ?? profile.name}</h1>
            {profile.bio ? <p className="mt-1 whitespace-pre-line text-[14px] text-mute">{profile.bio}</p> : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-faint">
              <span>Joined {new Date(profile.joinedAt).toLocaleDateString([], { month: "short", year: "numeric" })}</span>
              {profile.xHandle ? (
                <a href={`https://x.com/${profile.xHandle}`} target="_blank" rel="noreferrer noopener nofollow" className="font-medium text-rare hover:underline">x.com/{profile.xHandle}</a>
              ) : null}
            </div>
          </div>
          {mine ? <Link href="/profile" className="text-[13.5px] font-semibold text-gold hover:underline">Edit profile</Link> : null}
        </section>

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label="Snipes" value={stats.allTime.snipes} />
          <StatTile label="Profit" value={signed(stats.allTime.profit)} tone={good(stats.allTime.profit)} />
          <StatTile label="Biggest win" value={stats.allTime.best > 0 ? signed(stats.allTime.best) : "–"} tone={stats.allTime.best > 0 ? "good" : undefined} />
          <StatTile label="Spent" value={money(stats.allTime.spent, true)} />
          <StatTile label="Snipes this week" value={stats.week.snipes} />
          <StatTile label="Profit this week" value={signed(stats.week.profit)} tone={good(stats.week.profit)} />
        </section>

        {best ? (
          <section className="slab">
            <SectionTitle>Best snipe</SectionTitle>
            <Link href={`/card/${best.nft}`} className="flex items-center gap-3 px-4 pb-4 hover:text-gold">
              <CardThumb src={best.image} alt="" size={64} />
              <div className="min-w-0">
                <div className="truncate text-[15px] font-semibold">{cardTitle(best.name ?? "A card")}</div>
                <div className="num text-[13px] text-faint">Paid {money(best.cost)}</div>
                <div className="num text-[16px] font-semibold text-teal">{signed(best.gain)}</div>
              </div>
            </Link>
          </section>
        ) : null}

        <section className="slab min-w-0">
          <SectionTitle right={<span className="text-[12.5px] text-faint">Latest {recent.length}</span>}>Snipes</SectionTitle>
          {recent.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] text-faint">No snipes yet.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 px-2 pb-2 sm:grid-cols-3 lg:grid-cols-6">
              {recent.map((card, i) => {
                const exited = card.status === "sold" || card.status === "bought_back";
                const gain = (exited ? card.exitPrice ?? 0 : card.insuredValue ?? card.cost) - card.cost;
                return (
                  <li key={`${card.nft}:${i}`} className="tile flex min-w-0 flex-col overflow-hidden">
                    <Link href={`/card/${card.nft}`} className="flex h-[150px] items-center justify-center bg-ink/25 p-2" aria-label={card.name}>
                      {card.image ? <img src={sized(card.image, 140)} alt="" loading="lazy" decoding="async" className="max-h-full max-w-full rounded-[2px] object-contain" /> : null}
                    </Link>
                    <div className="flex min-w-0 flex-col gap-1 p-2">
                      <span className="truncate text-[13px] font-semibold">{cardTitle(card.name)}</span>
                      <Grade grader={card.grader} grade={card.grade} />
                      <div className="flex items-baseline justify-between gap-1">
                        <span className="num text-[12.5px] text-faint">{money(card.cost)}</span>
                        <span className={`num text-[13px] font-semibold ${gain >= 0 ? "text-teal" : "text-loss"}`}>{signed(gain)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-1 text-[11.5px] text-faint">
                        <span>{ago(card.at, now)}</span>
                        {exited ? <Pill>Sold</Pill> : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
