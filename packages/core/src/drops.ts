import { pathIndex, sampleSeries } from "./pricepath";

export type DropKind = "revealed" | "hidden";

export const DROP_STATES = [
  "PLANNED", "PACK_PAID", "OPENING", "IN_VAULT",
  "LIVE", "CLAIMED", "SETTLING", "SETTLED",
  "QUOTED", "DEBITING", "PACK_PAYING", "DELIVERED",
  "EXPIRED", "BOUGHT_BACK", "SKIPPED", "ABANDONED",
  "AWAIT_AUTO_REFUND", "REFUND_DUE", "REFUNDED", "VOID",
] as const;
export type DropState = (typeof DROP_STATES)[number];

type Table = Partial<Record<DropState, readonly DropState[]>>;

/** Revealed: the pack is bought and opened first, then the card is listed. */
export const REVEALED: Table = {
  PLANNED: ["PACK_PAID", "SKIPPED"],
  PACK_PAID: ["OPENING", "ABANDONED"],
  OPENING: ["IN_VAULT", "AWAIT_AUTO_REFUND", "BOUGHT_BACK"],
  IN_VAULT: ["LIVE", "BOUGHT_BACK"],
  LIVE: ["CLAIMED", "EXPIRED"],
  CLAIMED: ["SETTLING", "LIVE", "EXPIRED"],
  SETTLING: ["SETTLED", "LIVE", "EXPIRED"],
  EXPIRED: ["LIVE", "BOUGHT_BACK"],
  AWAIT_AUTO_REFUND: ["REFUNDED"],
};

/** Hidden: nothing exists on-chain until a winner has paid. */
export const HIDDEN: Table = {
  LIVE: ["CLAIMED", "EXPIRED"],
  CLAIMED: ["QUOTED", "VOID"],
  QUOTED: ["DEBITING", "LIVE", "VOID"],
  DEBITING: ["PACK_PAYING", "LIVE", "VOID"],
  PACK_PAYING: ["OPENING", "QUOTED", "REFUND_DUE"],
  OPENING: ["DELIVERED", "AWAIT_AUTO_REFUND"],
  AWAIT_AUTO_REFUND: ["REFUND_DUE"],
  REFUND_DUE: ["REFUNDED"],
};

export const TERMINAL: readonly DropState[] = ["SETTLED", "DELIVERED", "BOUGHT_BACK", "SKIPPED", "ABANDONED", "REFUNDED", "VOID"];

export function canTransition(kind: DropKind, from: DropState, to: DropState): boolean {
  return ((kind === "revealed" ? REVEALED : HIDDEN)[from] ?? []).includes(to);
}

export function assertTransition(kind: DropKind, from: DropState, to: DropState): void {
  if (!canTransition(kind, from, to)) throw new Error(`illegal ${kind} drop transition ${from} -> ${to}`);
}

export const CLAIM_STATES = ["won", "settled", "voided", "refunded"] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

export const MAX_PACK_PAY_ATTEMPTS = 3;
/** The Vault sells a held card back this long before its 72h window closes. */
export const BUYBACK_SAFETY_SEC = 6 * 3600;
export const BUYBACK_WINDOW_SEC = 72 * 3600;

export interface DropView {
  id: string; number: number; kind: DropKind; state: string; machineCode: string;
  price: number | null; packPrice: number; opensAt: Date | null; expiresAt: Date | null;
  insuredValue: number | null; rarity: string | null; nft: string | null; card: Record<string, unknown> | null;
}

/** What a client may see of a drop. A hidden card stays secret until it is delivered. */
export function publicDrop(d: DropView): DropView {
  const secret = d.kind === "hidden" && d.state !== "DELIVERED";
  return {
    id: d.id, number: d.number, kind: d.kind, state: d.state, machineCode: d.machineCode,
    price: d.price, packPrice: d.packPrice, opensAt: d.opensAt, expiresAt: d.expiresAt,
    insuredValue: secret ? null : d.insuredValue,
    rarity: secret ? null : d.rarity,
    nft: secret ? null : d.nft,
    card: secret ? null : d.card,
  };
}

export interface DropRow extends DropView {
  path: number[] | null;
  stoppedAt: Date | null;
  boughtBy: string | null;
}

/** The part of the price path that has already happened, and nothing after it. */
export function pastPrices(d: Pick<DropRow, "path" | "opensAt" | "stoppedAt" | "price">, now = Date.now()): number[] {
  if (!d.path?.length || !d.opensAt) return d.price === null ? [] : [d.price];
  const end = d.stoppedAt ? d.stoppedAt.getTime() : now;
  return d.path.slice(0, pathIndex(d.opensAt.getTime(), end, d.path.length) + 1);
}

/** Built field by field, so the future of the price can never be sent by accident. */
export function pulseView(d: DropRow, now = Date.now()) {
  const past = pastPrices(d, now);
  const movesUntil = d.opensAt && d.path?.length ? new Date(d.opensAt.getTime() + d.path.length * 1000) : d.expiresAt;
  return {
    ...publicDrop(d),
    price: d.stoppedAt ? d.price : past.at(-1) ?? d.price,
    openPrice: past[0] ?? d.price,
    high: past.length ? Math.max(...past) : d.price,
    low: past.length ? Math.min(...past) : d.price,
    series: sampleSeries(past),
    movesUntil,
    stoppedAt: d.stoppedAt,
    boughtBy: d.boughtBy,
  };
}
