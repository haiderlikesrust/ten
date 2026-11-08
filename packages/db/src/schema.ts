import { sql } from "drizzle-orm";
import {
  bigint, bigserial, boolean, check, doublePrecision, index, integer, jsonb, pgTable, primaryKey,
  serial, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const micros = (name: string) => bigint(name, { mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

// Identity ------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  privyDid: text("privy_did").unique(),
  /** Lets the worker ask Privy for a signature. The key itself never leaves Privy. */
  privyWalletId: text("privy_wallet_id"),
  handle: text("handle").notNull(),
  /** Funds snipes. Key is exportable by the user. */
  tradingWallet: text("trading_wallet").notNull().unique(),
  /** Login wallet. Won cards are delivered here. */
  connectedWallet: text("connected_wallet").notNull(),
  /** One signature-verified wallet counts toward holder tier. */
  holderWallet: text("holder_wallet").unique(),
  isAdmin: boolean("is_admin").notNull().default(false),
  strikes: integer("strikes").notNull().default(0),
  lastWinAt: ts("last_win_at"),
  settings: jsonb("settings").$type<UserSettings>().notNull().default({}),
  createdAt: createdAt(),
});

export interface UserSettings {
  quickBuy?: number[];
  tradeLimitUsd?: number;
  autoForward?: boolean;
  soundOn?: boolean;
}

// Money ---------------------------------------------------------------------

/** Internal book of record. Accounts: user:<id>, drops, cashback, fee, cc, world. */
export const balances = pgTable("balances", {
  account: text("account").primaryKey(),
  micros: micros("micros").notNull().default(0),
}, (t) => [check("no_negative_balance", sql`${t.account} in ('cc','world') or ${t.micros} >= 0`)]);

export const ledgerBatches = pgTable("ledger_batches", {
  ref: text("ref").primaryKey(),
  reason: text("reason").notNull(),
  createdAt: createdAt(),
});

export const ledgerEntries = pgTable("ledger_entries", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ref: text("ref").notNull().references(() => ledgerBatches.ref),
  account: text("account").notNull(),
  delta: micros("delta").notNull(),
  createdAt: createdAt(),
}, (t) => [index("ledger_account_idx").on(t.account, t.id), index("ledger_ref_idx").on(t.ref)]);

export const holds = pgTable("holds", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  amount: micros("amount").notNull(),
  ref: text("ref").notNull(),
  status: text("status").$type<"active" | "captured" | "released">().notNull().default("active"),
  createdAt: createdAt(),
}, (t) => [index("holds_active_idx").on(t.userId).where(sql`${t.status} = 'active'`)]);

// Wild Drops ----------------------------------------------------------------

export const drops = pgTable("drops", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: serial("number").notNull(),
  kind: text("kind").$type<"revealed" | "hidden">().notNull(),
  state: text("state").notNull(),
  machineCode: text("machine_code").notNull(),
  packPrice: micros("pack_price").notNull(),
  price: micros("price"),
  commonFloor: micros("common_floor").notNull(),
  insuredValue: micros("insured_value"),
  nft: text("nft"),
  rarity: text("rarity"),
  card: jsonb("card").$type<Record<string, unknown>>(),
  /** One price per second, drawn at the start. Never sent to clients beyond the current second. */
  path: jsonb("path").$type<number[]>(),
  /** The chart stops here, the moment someone buys. */
  stoppedAt: ts("stopped_at"),
  boughtBy: text("bought_by"),
  simBuyer: boolean("sim_buyer").notNull().default(false),
  memo: text("memo"),
  soldBackFor: micros("sold_back_for"),
  relists: integer("relists").notNull().default(0),
  packPayAttempts: integer("pack_pay_attempts").notNull().default(0),
  opensAt: ts("opens_at"),
  expiresAt: ts("expires_at"),
  buybackDeadline: ts("buyback_deadline"),
  winnerClaimId: uuid("winner_claim_id"),
  nextRunAt: ts("next_run_at").notNull().defaultNow(),
  leaseUntil: ts("lease_until"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("drops_state_idx").on(t.state, t.nextRunAt),
  index("drops_live_idx").on(t.expiresAt).where(sql`${t.state} = 'LIVE'`),
]);

export const claims = pgTable("claims", {
  id: uuid("id").primaryKey().defaultRandom(),
  dropId: uuid("drop_id").notNull().references(() => drops.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  idempotencyKey: text("idempotency_key").notNull(),
  deliverTo: text("deliver_to").notNull(),
  price: micros("price").notNull(),
  holdId: uuid("hold_id").notNull().references(() => holds.id),
  state: text("state").notNull().default("won"),
  settleBy: ts("settle_by").notNull(),
  reason: text("reason"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("claims_idem_idx").on(t.userId, t.idempotencyKey),
  uniqueIndex("claims_one_active_idx").on(t.userId).where(sql`${t.state} = 'won'`),
  index("claims_drop_idx").on(t.dropId),
]);

/** A user asking to buy a card if its price falls to their number. */
export const dropLimits = pgTable("drop_limits", {
  id: uuid("id").primaryKey().defaultRandom(),
  dropId: uuid("drop_id").notNull().references(() => drops.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  maxPrice: micros("max_price").notNull(),
  state: text("state").$type<"open" | "filled" | "failed" | "cancelled">().notNull().default("open"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("drop_limits_one_idx").on(t.dropId, t.userId).where(sql`${t.state} = 'open'`),
  index("drop_limits_open_idx").on(t.state, t.dropId),
]);

export const chainTx = pgTable("chain_tx", {
  id: uuid("id").primaryKey().defaultRandom(),
  purpose: text("purpose").notNull(),
  ref: text("ref").notNull(),
  attempt: integer("attempt").notNull().default(1),
  signature: text("signature").notNull(),
  raw: text("raw").notNull(),
  status: text("status").$type<"signed" | "sent" | "confirmed" | "failed" | "dead">().notNull().default("signed"),
  deadlineAt: ts("deadline_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("chain_tx_attempt_idx").on(t.purpose, t.ref, t.attempt),
  index("chain_tx_open_idx").on(t.status).where(sql`${t.status} in ('signed','sent')`),
]);

export const ccPacks = pgTable("cc_packs", {
  memo: text("memo").primaryKey(),
  dropId: uuid("drop_id"),
  userId: uuid("user_id"),
  machineCode: text("machine_code").notNull(),
  price: micros("price").notNull(),
  deliverTo: text("deliver_to").notNull(),
  turbo: boolean("turbo").notNull().default(false),
  raw: text("raw").notNull(),
  state: text("state").$type<"reserved" | "paid" | "opened" | "refunded">().notNull().default("reserved"),
  nft: text("nft"),
  rarity: text("rarity"),
  insuredValue: micros("insured_value"),
  roll: bigint("roll", { mode: "number" }),
  buybackAmount: micros("buyback_amount"),
  createdAt: createdAt(),
  openedAt: ts("opened_at"),
}, (t) => [index("cc_packs_user_idx").on(t.userId, t.createdAt)]);

// Fees and cashback ---------------------------------------------------------

/** The gateway never signs, so every user trade is a job the worker carries out. */
export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  kind: text("kind").$type<"market_buy" | "gacha_open" | "buyback" | "list" | "send">().notNull(),
  params: jsonb("params").$type<Record<string, unknown>>().notNull(),
  state: text("state").$type<"queued" | "running" | "done" | "failed">().notNull().default("queued"),
  step: text("step").notNull().default("start"),
  holdId: uuid("hold_id"),
  memo: text("memo"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  error: text("error"),
  idempotencyKey: text("idempotency_key").notNull(),
  nextRunAt: ts("next_run_at").notNull().defaultNow(),
  leaseUntil: ts("lease_until"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("orders_idem_idx").on(t.userId, t.idempotencyKey),
  index("orders_due_idx").on(t.state, t.nextRunAt),
]);

export const feeRuns = pgTable("fee_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  stage: text("stage").notNull().default("PENDING"),
  cardsIn: doublePrecision("cards_in"),
  usdcOut: micros("usdc_out"),
  cashback: micros("cashback"),
  drops: micros("drops"),
  error: text("error"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const cashbackAccruals = pgTable("cashback_accruals", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  memo: text("memo").notNull().unique(),
  machineCode: text("machine_code").notNull(),
  packPrice: micros("pack_price").notNull(),
  rateBps: integer("rate_bps").notNull(),
  amount: micros("amount").notNull(),
  status: text("status").$type<"accrued" | "paid" | "skipped">().notNull().default("accrued"),
  createdAt: createdAt(),
  paidAt: ts("paid_at"),
}, (t) => [index("cashback_user_idx").on(t.userId, t.createdAt)]);

export const holderSnapshots = pgTable("holder_snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  wallet: text("wallet").notNull(),
  balance: doublePrecision("balance").notNull(),
  takenAt: ts("taken_at").notNull().defaultNow(),
}, (t) => [index("holder_wallet_idx").on(t.wallet, t.takenAt)]);

// Market data ---------------------------------------------------------------

export const listings = pgTable("listings", {
  nft: text("nft").primaryKey(),
  name: text("name").notNull(),
  category: text("category"),
  set: text("set"),
  year: integer("year"),
  grader: text("grader"),
  grade: text("grade"),
  gradeNum: doublePrecision("grade_num"),
  cert: text("cert"),
  image: text("image"),
  insuredValue: micros("insured_value"),
  price: micros("price").notNull(),
  source: text("source").notNull(),
  seller: text("seller"),
  sellerName: text("seller_name"),
  offers: integer("offers").notNull().default(0),
  vault: text("vault"),
  listedAt: ts("listed_at"),
  firstSeen: ts("first_seen").notNull().defaultNow(),
  lastSeen: ts("last_seen").notNull().defaultNow(),
  active: boolean("active").notNull().default(true),
}, (t) => [
  index("listings_active_idx").on(t.active, t.listedAt),
  index("listings_price_idx").on(t.active, t.price),
  index("listings_seller_idx").on(t.seller),
]);

/** CC has no sales history endpoint, so we record our own from day one. */
export const sales = pgTable("sales", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  nft: text("nft").notNull(),
  name: text("name").notNull(),
  price: micros("price").notNull(),
  insuredValue: micros("insured_value"),
  seller: text("seller"),
  buyer: text("buyer"),
  source: text("source").notNull(),
  soldAt: ts("sold_at").notNull().defaultNow(),
}, (t) => [index("sales_nft_idx").on(t.nft, t.soldAt), index("sales_time_idx").on(t.soldAt)]);

export const pricePoints = pgTable("price_points", {
  nft: text("nft").notNull(),
  at: ts("at").notNull().defaultNow(),
  ask: micros("ask"),
  insuredValue: micros("insured_value"),
}, (t) => [primaryKey({ columns: [t.nft, t.at] })]);

export const machines = pgTable("machines", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  shortName: text("short_name"),
  image: text("image"),
  price: micros("price").notNull(),
  buybackPct: integer("buyback_pct").notNull(),
  ev: micros("ev"),
  odds: jsonb("odds").$type<Record<string, number>>().notNull(),
  tiers: jsonb("tiers").$type<Record<string, { start: number; end: number }>>().notNull(),
  stock: jsonb("stock").$type<Record<string, number>>().notNull(),
  turbo: boolean("turbo").notNull().default(false),
  isPublic: boolean("is_public").notNull().default(true),
  isOpen: boolean("is_open").notNull().default(true),
  menuCategory: text("menu_category"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Real cards in a machine, used by paper mode so simulated pulls look and price like the real thing. */
export const poolCards = pgTable("pool_cards", {
  nft: text("nft").primaryKey(),
  machineCode: text("machine_code").notNull(),
  rarity: text("rarity").notNull(),
  name: text("name").notNull(),
  image: text("image"),
  insuredValue: micros("insured_value").notNull(),
  grader: text("grader"),
  grade: text("grade"),
  usedAt: ts("used_at"),
}, (t) => [index("pool_pick_idx").on(t.machineCode, t.rarity, t.usedAt)]);

export const pulls = pgTable("pulls", {
  id: text("id").primaryKey(),
  nft: text("nft").notNull(),
  winner: text("winner").notNull(),
  packType: text("pack_type").notNull(),
  source: text("source"),
  name: text("name").notNull(),
  image: text("image"),
  grader: text("grader"),
  grade: text("grade"),
  rarity: text("rarity"),
  insuredValue: micros("insured_value"),
  at: ts("at").notNull(),
}, (t) => [index("pulls_time_idx").on(t.at), index("pulls_winner_idx").on(t.winner, t.at)]);

// User features -------------------------------------------------------------

export const holdings = pgTable("holdings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  nft: text("nft").notNull(),
  wallet: text("wallet").$type<"trading" | "connected">().notNull(),
  card: jsonb("card").$type<Record<string, unknown>>().notNull(),
  source: text("source").$type<"drop" | "gacha" | "market">().notNull(),
  cost: micros("cost").notNull(),
  insuredValue: micros("insured_value"),
  buybackUntil: ts("buyback_until"),
  buybackAmount: micros("buyback_amount"),
  status: text("status").$type<"held" | "listed" | "sold" | "bought_back">().notNull().default("held"),
  listPrice: micros("list_price"),
  exitPrice: micros("exit_price"),
  acquiredAt: ts("acquired_at").notNull().defaultNow(),
  exitedAt: ts("exited_at"),
}, (t) => [index("holdings_user_idx").on(t.userId, t.status)]);

export const activity = pgTable("activity", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  delta: micros("delta").notNull().default(0),
  ref: text("ref"),
  at: ts("at").notNull().defaultNow(),
}, (t) => [index("activity_user_idx").on(t.userId, t.id)]);

export const autoRules = pgTable("auto_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  category: text("category"),
  grader: text("grader"),
  minGrade: doublePrecision("min_grade"),
  maxPrice: micros("max_price").notNull(),
  minDiscountPct: integer("min_discount_pct").notNull().default(0),
  search: text("search"),
  dailyBudget: micros("daily_budget").notNull(),
  createdAt: createdAt(),
});

export const autoFires = pgTable("auto_fires", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ruleId: uuid("rule_id").notNull().references(() => autoRules.id),
  nft: text("nft").notNull(),
  price: micros("price").notNull(),
  at: ts("at").notNull().defaultNow(),
}, (t) => [uniqueIndex("auto_fire_once_idx").on(t.ruleId, t.nft)]);

export const watchlist = pgTable("watchlist", {
  userId: uuid("user_id").notNull().references(() => users.id),
  nft: text("nft").notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.nft] })]);

export const trackedWallets = pgTable("tracked_wallets", {
  userId: uuid("user_id").notNull().references(() => users.id),
  wallet: text("wallet").notNull(),
  label: text("label").notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.wallet] })]);

// Ops -----------------------------------------------------------------------

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const reconcileRuns = pgTable("reconcile_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ok: boolean("ok").notNull(),
  mismatches: jsonb("mismatches").$type<Array<{ account: string; book: number; chain: number }>>().notNull(),
  at: ts("at").notNull().defaultNow(),
});

/** Every realtime event, in order. Clients resume from their last seq. */
export const outbox = pgTable("outbox", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  topic: text("topic").notNull(),
  payload: jsonb("payload").notNull(),
  at: ts("at").notNull().defaultNow(),
});

/** Paper mode's stand-in for the chain, kept apart from the book so reconciliation has something real to compare. */
export const paperChain = pgTable("paper_chain", {
  account: text("account").primaryKey(),
  micros: micros("micros").notNull().default(0),
});

export const paperTx = pgTable("paper_tx", {
  signature: text("signature").primaryKey(),
  status: text("status").notNull(),
  op: jsonb("op").notNull(),
  at: ts("at").notNull().defaultNow(),
});

// $TENR flywheel (docs/FLYWHEEL.md) ----------------------------------------

/** One gift draw every 30 minutes. Entries and seed are public, so anyone can recompute the winner. */
export const giftDraws = pgTable("gift_draws", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The half-hour this draw belongs to. One draw per slot. */
  slotAt: ts("slot_at").notNull(),
  grp: text("grp").$type<"active" | "holders" | "blasters">(),
  /** committed, drawn, claimed, expired, or rolled (nobody won; the pot grows). */
  state: text("state").notNull(),
  prize: micros("prize"),
  machineCode: text("machine_code"),
  entries: jsonb("entries").$type<Array<{ userId: string; wallet: string; weight: number }>>().notNull().default([]),
  entriesHash: text("entries_hash"),
  /** Solana slot whose blockhash seeds the draw. Null in paper mode, which uses a server seed. */
  targetSlot: bigint("target_slot", { mode: "number" }),
  blockhash: text("blockhash"),
  seed: text("seed"),
  winnerUserId: uuid("winner_user_id").references(() => users.id),
  winnerWallet: text("winner_wallet"),
  /** The gacha order that opens the gift pack once claimed. */
  orderId: uuid("order_id"),
  reason: text("reason"),
  drawnAt: ts("drawn_at"),
  expiresAt: ts("expires_at"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("gift_draws_slot_idx").on(t.slotAt), index("gift_draws_winner_idx").on(t.winnerUserId, t.drawnAt)]);

/** How long each user has held at least the long-holder share without a break. */
export const holderStreaks = pgTable("holder_streaks", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  held: doublePrecision("held").notNull().default(0),
  /** When they last went from under the share to over it. Null while under. */
  aboveSince: ts("above_since"),
  checkedAt: ts("checked_at").notNull().defaultNow(),
});

/** Outside revenue swapped to $TENR and burned. */
export const buybacks = pgTable("buybacks", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** PENDING, SWAPPED, BURNED, DONE, or SKIPPED. */
  stage: text("stage").notNull().default("PENDING"),
  usdcIn: micros("usdc_in").notNull(),
  tenrOut: doublePrecision("tenr_out"),
  swapSig: text("swap_sig"),
  burnSig: text("burn_sig"),
  error: text("error"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type GiftDraw = typeof giftDraws.$inferSelect;
export type Drop = typeof drops.$inferSelect;
