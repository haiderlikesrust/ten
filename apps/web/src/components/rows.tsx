"use client";

import { shortAddress } from "@gemdex/core";
import { Timer } from "lucide-react";
import Link from "next/link";
import { useLive } from "@/lib/live";
import { ago, cardTitle, clock, money, packLabel } from "@/lib/format";
import type { Pull } from "@/lib/types";
import { useNow } from "@/lib/ui";
import { CardThumb, Grade, Rarity, rarityWash } from "./bits";

export function PullRow({ pull }: { pull: Pull }) {
  const now = useNow();
  const isNew = useLive((s) => s.newIds.has(pull.id));
  const buybackLeft = 72 * 3600 - (now - new Date(pull.at).getTime()) / 1000;
  return (
    <article className={`tile flex gap-3 p-2.5 ${rarityWash(pull.rarity)} ${isNew ? "row-new" : ""}`}>
      <Link href={`/card/${pull.nft}`} aria-label={pull.name}>
        <CardThumb src={pull.image} alt={pull.name} zoom />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col">
        <Link href={`/card/${pull.nft}`} className="truncate text-[14.5px] font-bold leading-snug hover:text-gold">
          {cardTitle(pull.name)}
        </Link>
        <div className="truncate text-[12.5px] text-faint">{packLabel(pull.packType)}{pull.source && pull.source !== "cc" ? ` via ${pull.source}` : ""} · {shortAddress(pull.winner)}</div>
        <div className="mt-auto flex items-center gap-1 overflow-hidden pt-1">
          <Grade grader={pull.grader} grade={pull.grade} />
          <Rarity rarity={pull.rarity} />
          <span className="num ml-0.5 shrink-0 text-[12px] text-faint">{ago(pull.at, now)}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <div className="num text-[15px] font-bold leading-snug">{money(pull.insuredValue, true)}</div>
        <div className="text-[12px] text-faint">Insured</div>
        {buybackLeft > 0 ? (
          <div className="mt-auto flex items-center gap-1 text-gold" title="Time left on the Collector Crypt buyback window">
            <Timer size={13} aria-hidden="true" />
            <span className="num text-[12px] font-semibold">{clock(buybackLeft)}</span>
          </div>
        ) : null}
      </div>
    </article>
  );
}
