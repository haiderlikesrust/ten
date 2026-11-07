export interface Listing {
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
  insuredValue: number | null;
  price: number;
  source: string;
  seller: string | null;
  sellerName: string | null;
  offers: number;
  vault: string | null;
  listedAt: string | null;
  firstSeen?: string;
  discountPct: number | null;
  active?: boolean;
}

export interface Pull {
  id: string;
  nft: string;
  winner: string;
  packType: string;
  source: string | null;
  name: string;
  image: string | null;
  grader: string | null;
  grade: string | null;
  rarity: string | null;
  insuredValue: number | null;
  at: string;
}

export interface CardBits {
  name?: string;
  image?: string | null;
  grader?: string | null;
  grade?: string | null;
  rarity?: string | null;
  machine?: string;
  memo?: string;
  [key: string]: unknown;
}

export interface Drop {
  id: string;
  number: number;
  kind: "revealed" | "hidden";
  state: string;
  machineCode: string;
  price: number | null;
  packPrice: number;
  opensAt: string | null;
  expiresAt: string | null;
  insuredValue: number | null;
  rarity: string | null;
  nft: string | null;
  card: CardBits | null;
}

export interface Win {
  dropId: string;
  number: number;
  kind: "revealed" | "hidden";
  price: number;
  insuredValue: number | null;
  card: CardBits;
  machineCode: string;
  at: string;
}

export interface DropsStatus {
  nextDropAt: string | null;
  pausedFor: string | null;
  intervalSec: number | null;
  burnPerDrop: number;
  budgetPerDay: number;
  dropsBalance: number;
  spent24h: number;
}

export interface Machine {
  code: string;
  name: string;
  shortName: string | null;
  image: string | null;
  price: number;
  buybackPct: number;
  ev: number | null;
  evPct: number | null;
  odds: Record<string, number>;
  tiers: Record<string, { start: number; end: number }>;
  stock: Record<string, number>;
  turbo: boolean;
  isOpen: boolean;
  menuCategory: string | null;
  cashbackCapBps: number;
}

export interface Tier {
  name: string;
  minBalance: number;
  rateBps: number;
}

export interface Me {
  id: string;
  handle: string;
  tradingWallet: string;
  connectedWallet: string;
  holderWallet: string | null;
  isAdmin: boolean;
  strikes: number;
  settings: { quickBuy?: number[]; tradeLimitUsd?: number; autoForward?: boolean; soundOn?: boolean };
  balance: number;
  available: number;
  held: number;
  cooldownSec: number;
  tokens: number;
  tier: Tier | null;
}

export interface Meta {
  mode: "paper" | "devnet" | "mainnet";
  paper: boolean;
  minPrice: number;
  maxPrice: number;
  winCooldownSec: number;
  ttlSec: number;
  tiers: Tier[];
}

export interface Holding {
  id: string;
  nft: string;
  wallet: "trading" | "connected";
  card: CardBits;
  source: "drop" | "gacha" | "market";
  cost: number;
  insuredValue: number | null;
  buybackUntil: string | null;
  buybackAmount: number | null;
  status: string;
  listPrice: number | null;
  exitPrice: number | null;
  acquiredAt: string;
  exitedAt: string | null;
}

export interface Portfolio {
  held: Holding[];
  exited: Holding[];
  summary: { value: number; cost: number; unrealized: number; realized: number };
  days: Array<{ day: string; pnl: number }>;
  /** Trading wallet movements, oldest first. */
  wallet: Array<{ at: string; delta: number }>;
}

export interface ActivityRow {
  id: number;
  kind: string;
  title: string;
  delta: number;
  ref: string | null;
  at: string;
}

export interface AutoRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  category: string | null;
  grader: string | null;
  minGrade: number | null;
  maxPrice: number;
  minDiscountPct: number;
  search: string | null;
  dailyBudget: number;
}
