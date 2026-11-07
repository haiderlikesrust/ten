import { parseGradeNumber, parseUsd, rarityFromTier, usd, type Micros, type Rarity } from "@gemdex/core";
import type { CcListingRow, CcMachine, CcPoolCard, CcStatus, CcWinner } from "./cc-read";

export interface NormalListing {
  nft: string;
  name: string;
  category: string | null;
  set: string | null;
  year: number | null;
  grader: string | null;
  grade: string | null;
  gradeNum: number | null;
  cert: string | null;
  image: string | null;
  insuredValue: Micros | null;
  price: Micros;
  source: string;
  seller: string | null;
  sellerName: string | null;
  offers: number;
  vault: string | null;
  listedAt: Date | null;
}

/** Only USDC prices are dollars. Other marketplaces list in SOL, which a USDC wallet can't pay. */
export const isUsdcListing = (listing: { currency?: string } | null | undefined): boolean => !listing?.currency || listing.currency === "USDC";

export function normalizeListing(row: CcListingRow): NormalListing | null {
  if (!row.listing || !row.nftAddress || !isUsdcListing(row.listing)) return null;
  const listedAt = row.listing.createdAt ?? row.listedAt;
  return {
    nft: row.nftAddress,
    name: row.itemName,
    category: row.category || null,
    set: row.set || null,
    year: row.year ?? null,
    grader: row.gradingCompany ?? null,
    grade: row.grade ?? null,
    gradeNum: parseGradeNumber(row.grade, row.gradeNum),
    cert: row.gradingID ?? null,
    image: row.images?.frontS ?? row.images?.frontM ?? row.frontImage ?? null,
    insuredValue: parseUsd(row.insuredValue),
    price: usd(row.listing.price),
    source: row.listing.marketplace ?? "CC",
    seller: row.owner?.wallet ?? null,
    sellerName: row.owner?.name ?? null,
    offers: row.offers?.length ?? 0,
    vault: row.vault ?? null,
    listedAt: listedAt ? new Date(listedAt) : null,
  };
}

function trait(attrs: Array<{ trait_type: string; value: unknown }> | undefined, name: string): string | null {
  const value = attrs?.find((a) => a.trait_type === name)?.value;
  return value === undefined || value === null || value === "" ? null : String(value);
}

export interface NormalPull {
  id: string;
  nft: string;
  winner: string;
  packType: string;
  source: string | null;
  name: string;
  image: string | null;
  grader: string | null;
  grade: string | null;
  rarity: Rarity | null;
  insuredValue: Micros | null;
  at: Date;
}

export function normalizeWinner(w: CcWinner): NormalPull | null {
  if (!w.nft_address) return null;
  const content = w.nft?.content;
  const attrs = content?.metadata?.attributes;
  const file = content?.files?.[0];
  return {
    id: `${w.nft_address}:${w.created_at}`,
    nft: w.nft_address,
    winner: w.winner,
    packType: w.pack_type,
    source: w.memo_slug,
    name: content?.metadata?.name ?? "Graded card",
    image: file?.cc_cdn ?? file?.cdn_uri ?? content?.links?.image ?? null,
    grader: trait(attrs, "Grading Company"),
    grade: trait(attrs, "The Grade"),
    rarity: rarityFromTier(w.prize_tier),
    insuredValue: parseUsd(w.insuredValue),
    at: new Date(w.created_at),
  };
}

export interface NormalMachine {
  code: string;
  name: string;
  shortName: string | null;
  image: string | null;
  price: Micros;
  buybackPct: number;
  ev: Micros | null;
  odds: Record<string, number>;
  tiers: Record<string, { start: number; end: number }>;
  stock: Record<string, number>;
  turbo: boolean;
  isPublic: boolean;
  isOpen: boolean;
  menuCategory: string | null;
}

function absolute(url: string | null | undefined): string | null {
  return url && url.startsWith("http") ? url : null;
}

export function normalizeMachine(m: CcMachine, status: CcStatus | null): NormalMachine {
  const running = status ? status.machineStatus === "running" : true;
  const entry = status?.gachas?.find((g) => g.code === m.code);
  return {
    code: m.code,
    name: m.name,
    shortName: m.shortName ?? null,
    image: absolute(m.imageNobg) ?? absolute(m.thumbnailUrl) ?? absolute(m.image),
    price: usd(m.price),
    buybackPct: m.instantBuyback,
    ev: m.ev === null || m.ev === undefined ? null : usd(m.ev),
    odds: m.odds,
    tiers: m.tierRanges,
    stock: typeof m.stock === "object" && m.stock ? m.stock : {},
    turbo: !!m.turboMode,
    isPublic: m.public !== false,
    isOpen: running && (entry ? entry.isOpen === true : true),
    menuCategory: m.menuCategory ?? null,
  };
}

export interface NormalPoolCard {
  nft: string;
  machineCode: string;
  rarity: string;
  name: string;
  image: string | null;
  insuredValue: Micros;
  grader: string | null;
  grade: string | null;
}

export function normalizePoolCard(c: CcPoolCard, machineCode: string): NormalPoolCard | null {
  const insuredValue = parseUsd(c.insured_value);
  if (insuredValue === null) return null;
  return {
    nft: c.nft_address,
    machineCode,
    rarity: String(c.rarity).toLowerCase(),
    name: c.name,
    image: c.image ?? null,
    insuredValue,
    grader: trait(c.attributes, "Grading Company"),
    grade: trait(c.attributes, "The Grade"),
  };
}
