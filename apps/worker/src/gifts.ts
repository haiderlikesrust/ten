// Gift packs every 30 minutes (docs/FLYWHEEL.md). A draw commits to its entries first, then takes its seed
// from a Solana block that didn't exist yet, so nobody, the team included, can pick the winner.
import { createHash, randomBytes } from "node:crypto";
import {
  blasterWeight, giftEntriesText, giftGroupOrder, giftPrize, giftSlot, holderWeight, pickGiftWinner,
  type FlywheelSettings, type GiftEntry, type GiftGroup, type Micros,
} from "@gemdex/core";
import { and, balanceOf, emit, eq, getSetting, giftDraws, gte, holderStreaks, inArray, isNotNull, isNull, lt, machines, post, users, type GiftDraw } from "@gemdex/db";
import { checkAccess, walletsOf } from "@gemdex/venues/holdings";
import type { Ctx } from "./ctx";

type User = typeof users.$inferSelect;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Slots between the commit and the block that seeds it: roughly 13 seconds of Solana. */
const SEED_SLOTS = 32;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Live: does this user hold at least `bps` of $TENR right now? An unreadable chain counts as no. */
async function holds(ctx: Ctx, user: User, bps: number): Promise<boolean> {
  try {
    return (await checkAccess(ctx.tokens ?? null, walletsOf(user), bps)).ok;
  } catch {
    return false;
  }
}

async function usersById(ctx: Ctx, ids: string[]): Promise<Map<string, User>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.db.select().from(users).where(inArray(users.id, ids));
  return new Map(rows.map((u) => [u.id, u]));
}

/** Admins, the team's wallets, and anyone who won within the cooldown can't win. */
async function blocked(ctx: Ctx, settings: FlywheelSettings, now: number): Promise<(user: User) => boolean> {
  const since = new Date(now - settings.winCooldownHours * HOUR_MS);
  const recent = await ctx.db.select({ id: giftDraws.winnerUserId }).from(giftDraws).where(and(isNotNull(giftDraws.winnerUserId), gte(giftDraws.drawnAt, since)));
  const winners = new Set(recent.map((r) => r.id));
  const team = new Set(settings.excludedWallets);
  return (user) => user.isAdmin || winners.has(user.id) || walletsOf(user).some((w) => team.has(w));
}

const entry = (user: User, weight: number): GiftEntry => ({ userId: user.id, wallet: user.connectedWallet, weight });

/** At least N packs opened or sniped in the hour before the draw, and the access minimum held. */
async function activeEntries(ctx: Ctx, settings: FlywheelSettings, now: number, isBlocked: (u: User) => boolean): Promise<GiftEntry[]> {
  const since = new Date(now - HOUR_MS);
  const rows = await ctx.sql<{ user_id: string; n: number }[]>`
    select user_id, count(*)::int as n from (
      select user_id from cc_packs where drop_id is null and user_id is not null and state in ('paid', 'opened') and memo not in (select memo from orders where params ? 'gift' and memo is not null) and created_at >= ${since.toISOString()}::timestamptz
      union all
      select user_id from claims where state in ('won', 'settled') and created_at >= ${since.toISOString()}::timestamptz
    ) packs group by user_id having count(*) >= ${settings.activePacksPerHour}`;
  const found = await usersById(ctx, rows.map((r) => r.user_id));
  const out: GiftEntry[] = [];
  for (const row of rows) {
    const user = found.get(row.user_id);
    if (user && !isBlocked(user) && (await holds(ctx, user, settings.accessBps))) out.push(entry(user, row.n));
  }
  return out;
}

/** Held the long-holder share without a break, and still holding it now. */
async function holderEntries(ctx: Ctx, settings: FlywheelSettings, now: number, isBlocked: (u: User) => boolean): Promise<GiftEntry[]> {
  const streaks = await ctx.db.select().from(holderStreaks).where(isNotNull(holderStreaks.aboveSince));
  const found = await usersById(ctx, streaks.map((s) => s.userId));
  const out: GiftEntry[] = [];
  for (const streak of streaks) {
    const user = found.get(streak.userId);
    if (user && !isBlocked(user) && (await holds(ctx, user, settings.giftHoldBps))) out.push(entry(user, holderWeight(streak.aboveSince!, now)));
  }
  return out;
}

/** The biggest spenders over the last few days who hold the long-holder share now. */
async function blasterEntries(ctx: Ctx, settings: FlywheelSettings, now: number, isBlocked: (u: User) => boolean): Promise<GiftEntry[]> {
  const since = new Date(now - settings.blasterDays * DAY_MS);
  const rows = await ctx.sql<{ user_id: string; spend: string }[]>`
    select user_id, sum(amount)::bigint as spend from (
      select user_id, price as amount from cc_packs where drop_id is null and user_id is not null and state in ('paid', 'opened') and memo not in (select memo from orders where params ? 'gift' and memo is not null) and created_at >= ${since.toISOString()}::timestamptz
      union all
      select user_id, price as amount from claims where state in ('won', 'settled') and created_at >= ${since.toISOString()}::timestamptz
      union all
      select user_id, (params->>'price')::bigint as amount from orders where kind = 'market_buy' and state = 'done' and created_at >= ${since.toISOString()}::timestamptz
    ) spend group by user_id order by spend desc limit 200`;
  const found = await usersById(ctx, rows.map((r) => r.user_id));
  const out: GiftEntry[] = [];
  for (const row of rows) {
    if (out.length >= settings.topBlasters) break;
    const user = found.get(row.user_id);
    if (user && !isBlocked(user) && (await holds(ctx, user, settings.giftHoldBps))) out.push(entry(user, blasterWeight(Number(row.spend))));
  }
  return out;
}

const ENTRIES: Record<GiftGroup, typeof activeEntries> = { active: activeEntries, holders: holderEntries, blasters: blasterEntries };

/** An open pack machine at the prize, or the next tier down. Prefers the machines Pulse already uses. */
async function giftMachine(ctx: Ctx, prize: Micros, tiers: readonly Micros[]): Promise<{ code: string; price: Micros } | null> {
  const open = await ctx.db.select({ code: machines.code, price: machines.price }).from(machines).where(eq(machines.isOpen, true));
  const preferred = new Set((await getSetting(ctx.db, "drops")).machineMix.map((m) => m.code));
  for (const tier of [...tiers].sort((a, b) => b - a).filter((t) => t <= prize)) {
    const fits = open.filter((m) => m.price === tier).sort((a, b) => Number(preferred.has(b.code)) - Number(preferred.has(a.code)));
    if (fits[0]) return fits[0];
  }
  return null;
}

/** Picks the winner from the seed and tells them. Runs once per draw. */
async function finalize(ctx: Ctx, draw: GiftDraw, seed: string, blockhash: string | null, now: number) {
  const settings = await getSetting(ctx.db, "flywheel");
  const winner = pickGiftWinner(draw.entries, seed);
  if (!winner) return;
  const expiresAt = new Date(now + settings.claimHours * HOUR_MS);
  await ctx.db.transaction(async (tx) => {
    const done = await tx
      .update(giftDraws)
      .set({ state: "drawn", seed, blockhash, winnerUserId: winner.userId, winnerWallet: winner.wallet, drawnAt: new Date(now), expiresAt })
      .where(and(eq(giftDraws.id, draw.id), eq(giftDraws.state, "committed")))
      .returning({ id: giftDraws.id });
    if (done.length === 0) return;
    await emit(tx, `user:${winner.userId}`, { type: "gift", drawId: draw.id, prize: draw.prize, machineCode: draw.machineCode, expiresAt });
    await emit(tx, "gifts", { type: "drawn", id: draw.id, group: draw.grp, prize: draw.prize, winner: winner.wallet, seed });
  });
}

async function runDraw(ctx: Ctx, settings: FlywheelSettings, slotAt: number, now: number) {
  const slot = new Date(slotAt);
  const rolled = async (reason: string, extra: Partial<GiftDraw> = {}) => {
    await ctx.db.insert(giftDraws).values({ slotAt: slot, state: "rolled", reason, ...extra }).onConflictDoNothing();
  };
  if (!ctx.tokens) return rolled("There's no $TENR to check holdings against yet");
  const prize = giftPrize(await balanceOf(ctx.db, "gifts"), settings.giftSpendBps, settings.giftTiers);
  if (prize === null) return rolled("The pool is still filling");
  const machine = await giftMachine(ctx, prize, settings.giftTiers);
  if (!machine) return rolled("No pack machine is open at that price", { prize });

  const isBlocked = await blocked(ctx, settings, now);
  for (const group of giftGroupOrder(slotAt, settings.giftIntervalMin)) {
    const entries = await ENTRIES[group](ctx, settings, now, isBlocked);
    if (entries.length === 0) continue;
    const entriesHash = sha256(giftEntriesText(entries));
    const targetSlot = ctx.slots ? (await ctx.slots.current()) + SEED_SLOTS : null;
    const draw = await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(giftDraws)
        .values({ slotAt: slot, grp: group, state: "committed", prize: machine.price, machineCode: machine.code, entries, entriesHash, targetSlot })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;
      // The prize leaves the pool now, so a claim can never be short.
      await post(tx, `gift:${row.id}:reserve`, "gift_reserve", [{ account: "gifts", delta: -machine.price }, { account: "gift_reserved", delta: machine.price }]);
      await emit(tx, "gifts", { type: "committed", id: row.id, group, prize: machine.price, entries: entries.length, entriesHash, targetSlot });
      return row;
    });
    // Paper mode has no chain to wait for, so it seeds on the server and says so.
    if (draw && !ctx.slots) await finalize(ctx, draw, sha256(`${draw.id}:${entriesHash}:${randomBytes(32).toString("hex")}`), null, now);
    return;
  }
  return rolled("Nobody was eligible", { prize: machine.price, machineCode: machine.code });
}

/** Seeds committed draws once their block exists. */
async function revealDraws(ctx: Ctx, now: number) {
  if (!ctx.slots) return;
  const pending = await ctx.db.select().from(giftDraws).where(eq(giftDraws.state, "committed"));
  for (const draw of pending) {
    if (draw.targetSlot === null) continue;
    const block = await ctx.slots.blockhashAtOrAfter(draw.targetSlot);
    if (block) await finalize(ctx, draw, sha256(`${draw.id}:${draw.entriesHash}:${block.blockhash}`), block.blockhash, now);
  }
}

/** Unclaimed gifts go back to the pool. */
async function expireGifts(ctx: Ctx, now: number) {
  const due = await ctx.db.select().from(giftDraws).where(and(eq(giftDraws.state, "drawn"), isNull(giftDraws.orderId), lt(giftDraws.expiresAt, new Date(now))));
  for (const draw of due) {
    await ctx.db.transaction(async (tx) => {
      const done = await tx.update(giftDraws).set({ state: "expired" }).where(and(eq(giftDraws.id, draw.id), eq(giftDraws.state, "drawn"), isNull(giftDraws.orderId))).returning({ id: giftDraws.id });
      if (done.length === 0 || !draw.prize) return;
      await post(tx, `gift:${draw.id}:expire`, "gift_expire", [{ account: "gift_reserved", delta: -draw.prize }, { account: "gifts", delta: draw.prize }]);
      await emit(tx, "gifts", { type: "expired", id: draw.id });
    });
  }
}

/** Runs often. Draws once per slot, reveals committed draws, and returns expired gifts to the pool. */
export async function tickGiftDraws(ctx: Ctx, now = Date.now()) {
  await expireGifts(ctx, now);
  await revealDraws(ctx, now);
  const settings = await getSetting(ctx.db, "flywheel");
  if (!settings.giftsEnabled) return;
  const slotAt = giftSlot(now, settings.giftIntervalMin);
  const seen = await ctx.db.select({ id: giftDraws.id }).from(giftDraws).where(eq(giftDraws.slotAt, new Date(slotAt)));
  if (seen.length === 0) await runDraw(ctx, settings, slotAt, now);
}

/**
 * Tracks how long each user has held the long-holder share without a break. Reads every user's balance live;
 * the access minimum caps how many users there can be, so this stays small.
 */
export async function tickHolderStreaks(ctx: Ctx, now = Date.now()) {
  if (!ctx.tokens) return;
  const settings = await getSetting(ctx.db, "flywheel");
  const supply = await ctx.tokens.supply();
  const needed = (supply * settings.giftHoldBps) / 10_000;
  const all = await ctx.db.select().from(users);
  const streaks = new Map((await ctx.db.select().from(holderStreaks)).map((s) => [s.userId, s]));
  for (const user of all) {
    let held: number;
    try {
      held = await ctx.tokens.balanceOf(walletsOf(user));
    } catch {
      continue;
    }
    const above = needed > 0 && held >= needed;
    const before = streaks.get(user.id);
    if (!above && !before) continue;
    const aboveSince = above ? before?.aboveSince ?? new Date(now) : null;
    await ctx.db
      .insert(holderStreaks)
      .values({ userId: user.id, held, aboveSince, checkedAt: new Date(now) })
      .onConflictDoUpdate({ target: holderStreaks.userId, set: { held, aboveSince, checkedAt: new Date(now) } });
  }
}
