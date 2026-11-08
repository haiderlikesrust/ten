"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import { money, packLabel } from "@/lib/format";
import { useMe } from "@/lib/session";
import { useNow, useUi } from "@/lib/ui";
import { Button } from "./bits";
import { PixelIcon } from "./pixel";

interface MyGift {
  id: string;
  prize: number | null;
  machineCode: string | null;
  expiresAt: string | null;
  claimable: boolean;
}

/** A gift pack the user won in a draw (docs/FLYWHEEL.md), waiting to be claimed. */
export function GiftBanner() {
  const me = useMe();
  const now = useNow();
  const client = useQueryClient();
  const toast = useUi((s) => s.toast);
  const gifts = useQuery({ queryKey: ["gifts"], enabled: !!me, refetchInterval: 30_000, queryFn: () => api<{ gifts: MyGift[] }>("/gifts/mine") });
  const claim = useMutation({
    mutationFn: (id: string) => api<{ orderId: string }>(`/gifts/${id}/claim`, { body: {} }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["gifts"] });
      toast({ tone: "win", title: "Opening your gift pack" });
    },
    onError: (error) => toast({ tone: "bad", title: "Couldn't claim", detail: (error as Error).message }),
  });
  const gift = gifts.data?.gifts.find((g) => g.claimable);
  if (!gift) return null;
  const left = gift.expiresAt ? Math.max(0, new Date(gift.expiresAt).getTime() - now) : 0;
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.floor((left % 3_600_000) / 60_000);

  return (
    <div role="status" className="px-box mx-2 mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2 text-[13.5px] sm:mx-3">
      <span className="text-gold"><PixelIcon name="pack" /></span>
      <span className="min-w-0 flex-1">
        <span className="font-semibold text-bone">You won a {gift.machineCode ? packLabel(gift.machineCode) : money(gift.prize, true)} pack.</span>{" "}
        <span className="text-mute">
          Claim it within <span className="num text-bone">{hours}h {minutes}m</span>. <Link href="/treasury" className="underline hover:text-bone">How draws work</Link>
        </span>
      </span>
      <Button tone="snipe" className="h-8 px-3 text-[12px]" disabled={claim.isPending} onClick={() => claim.mutate(gift.id)}>
        Claim
      </Button>
    </div>
  );
}
