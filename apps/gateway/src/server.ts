import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { BRAND, accessMessage, cashbackCapBps, discountPct, parseGradeNumber, pastPrices, publicDrop, pulseView, tierFor, holderBalance, usd, type Access } from "@gemdex/core";
import {
  activity, and, asc, dropLimits, availableBalance, balanceOf, balances, ccPacks, claims, count, desc, drops, emit, eq, feeRuns, getSetting, gt, gte, holderSnapshots,
  holdings, holds, ilike, inArray, listings, loadJson, lte, machines, orders, placeOrder, pricePoints, pulls, reconcileRuns, sales, saveJson, setSetting, sql, trackedWallets, treasuryMoves,
  userAccount, users, watchlist, type Database,
} from "@gemdex/db";
import { CARDS_MINT, CcRead, createPaperVenue, fetchTokenMarket, type Mode, type PaperVenue, type TokenMarket } from "@gemdex/venues";
import { checkAccess, tokenReaderFor, walletsOf } from "@gemdex/venues/holdings";
import Fastify from "fastify";
import { createPaperUser, grantPaperFunds, issueSession, loadUser, privySession, requireUser, userIdFrom } from "./auth";
import { claimDrop } from "./claim";
import { flywheelRoutes } from "./flywheel";
import { Realtime } from "./realtime";

export interface ServerOptions {
  database: Database;
  mode: Mode;
  corsOrigin?: string | boolean;
  /** True once the gateway is stopping for an update. Its health check then fails, so nothing new is sent to it. */
  draining?: () => boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A Solana address as its 32 raw bytes, or null if it isn't one. */
function addressBytes(address: string): Buffer | null {
  let value = 0n;
  for (const char of address) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 255n));
    value >>= 8n;
  }
  for (const char of address) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return bytes.length === 32 ? Buffer.from(bytes) : null;
}

/** Whether a base64 transaction names this account. Checked on the raw bytes, so a wallet adding a fee instruction doesn't matter. */
function mentionsAccount(base64: string, address: string): boolean {
  const needle = addressBytes(address);
  if (!needle) return false;
  try {
    return Buffer.from(base64, "base64").includes(needle);
  } catch {
    return false;
  }
}
const HOLDING_ACTIONS = ["buyback", "list", "send"];
const asNumber = (value: unknown): number | undefined => {
  const n = Number(value);
  return value === undefined || value === "" || !Number.isFinite(n) ? undefined : n;
};

function toEconRow(row: typeof machines.$inferSelect) {
  return {
    code: row.code, price: row.price, buybackPct: row.buybackPct, ev: row.ev, commonFloor: usd(row.tiers.common?.start ?? 0), open: row.isOpen,
    stock: Object.values(row.stock).reduce((sum, n) => sum + Number(n), 0),
  };
}

const LISTING_SORTS = {
  newest: desc(listings.listedAt),
  price_asc: asc(listings.price),
  price_desc: desc(listings.price),
  value_desc: desc(listings.insuredValue),
  discount: sql`(1 - ${listings.price}::float8 / nullif(${listings.insuredValue}, 0)) desc nulls last`,
} as const;

function listingDto(row: typeof listings.$inferSelect) {
  return { ...row, discountPct: row.insuredValue ? discountPct(row.price, row.insuredValue) : null };
}

export async function buildServer(opts: ServerOptions) {
  const { database, mode } = opts;
  const { db, sql: raw } = database;
  // Behind Traefik every request comes from the proxy. TRUST_PROXY=true reads the visitor's address from
  // X-Forwarded-For, so the rate limit counts each visitor, not everyone together. Only set it when the
  // gateway is reachable through the proxy alone, as it is on Dokploy.
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: process.env.TRUST_PROXY === "true" });
  const cc = new CcRead({ mode, apiKey: process.env.CC_API_KEY });
  const paper: PaperVenue | null = mode === "paper" ? createPaperVenue(db) : null;

  // The access minimum (docs/FLYWHEEL.md). Every buy reads the balance live; only /me reuses a reading for a few seconds.
  const tokenReader = tokenReaderFor(mode, process.env, paper ? (wallet) => paper.chain.tokenBalance(wallet) : undefined);
  const accessCache = new Map<string, { at: number; access: Access }>();
  type Account = NonNullable<Awaited<ReturnType<typeof loadUser>>>;
  const accessOf = async (user: Account, fresh = true): Promise<Access> => {
    const hit = accessCache.get(user.id);
    if (!fresh && hit && Date.now() - hit.at < 10_000) return hit.access;
    const { accessBps } = await getSetting(db, "flywheel");
    const access = await checkAccess(tokenReader, walletsOf(user), accessBps);
    accessCache.set(user.id, { at: Date.now(), access });
    return access;
  };
  /** Every feature needs the access minimum (docs/FLYWHEEL.md). Sends the refusal and returns false when short. */
  const gateFeature = async (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, userId: string): Promise<boolean> => {
    const user = await loadUser(db, userId);
    if (!user) {
      reply.code(401).send({ error: "Session expired" });
      return false;
    }
    const refused = await accessRefusal(user);
    if (refused) {
      reply.code(refused.code === "access" ? 403 : 503).send(refused);
      return false;
    }
    return true;
  };
  /** Null when the user may buy. Otherwise the reason, ready to send. */
  const accessRefusal = async (user: Account): Promise<{ error: string; code: "access" | "access_unreadable"; access?: Access } | null> => {
    try {
      const access = await accessOf(user);
      return access.ok ? null : { error: accessMessage(access), code: "access", access };
    } catch {
      // Can't read the chain: refuse rather than let anyone through, and say it's temporary.
      return { error: "Couldn't check your $TENR balance. Try again in a moment.", code: "access_unreadable" };
    }
  };
  const realtime = new Realtime(database);

  await app.register(cors, { origin: opts.corsOrigin ?? true });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  await app.register(websocket, {
    // Stopping for an update: 1012 ("service restart") tells browsers to reconnect at once. The new gateway is
    // already up, and they resume from their last event, so nothing is missed.
    preClose(done) {
      for (const client of app.websocketServer.clients) client.close(1012, "Server restarting");
      done();
    },
  });
  await realtime.start();

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) console.error("[gateway]", error);
    void reply.code(status).send({ error: status >= 500 ? "Something went wrong" : error.message });
  });

  // Realtime --------------------------------------------------------------------

  app.register(async (scope) => {
    scope.get("/stream", { websocket: true }, (socket, request) => {
      const query = request.query as { token?: string; lastSeq?: string };
      void realtime.attach(socket as never, query.token, asNumber(query.lastSeq) ?? null);
    });
  });

  // Public ----------------------------------------------------------------------

  app.get("/health", async (_request, reply) => {
    if (opts.draining?.()) return reply.code(503).header("cache-control", "no-store").send({ ok: false, mode, state: "draining" });
    // A lost database fails at once. A slow answer (a long query ahead of it) is not a failure.
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<boolean>((resolve) => {
      timer = setTimeout(resolve, 2_000, true);
    });
    const ok = await Promise.race([database.sql`select 1`.then(() => true, () => false), slow]);
    clearTimeout(timer);
    return reply.code(ok ? 200 : 503).header("cache-control", "no-store").send({ ok, mode });
  });

  app.get("/meta", async () => {
    const [drop, cashback, flywheel] = await Promise.all([getSetting(db, "drops"), getSetting(db, "cashback"), getSetting(db, "flywheel")]);
    return {
      mode, brand: BRAND, minPrice: drop.minPrice, maxPrice: drop.maxPrice, winCooldownSec: drop.winCooldownSec, ttlSec: drop.ttlSec, tiers: cashback.tiers,
      paper: mode === "paper", tokenMint: process.env.GEMDEX_TOKEN_MINT || null, accessBps: flywheel.accessBps,
    };
  });

  app.get("/listings", async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const filters = [eq(listings.active, true)];
    if (q.category) filters.push(eq(listings.category, q.category));
    if (q.grader) filters.push(eq(listings.grader, q.grader));
    if (q.source) filters.push(eq(listings.source, q.source));
    if (q.search) filters.push(ilike(listings.name, `%${q.search.replace(/[%_]/g, "")}%`));
    const minGrade = asNumber(q.minGrade);
    if (minGrade !== undefined) filters.push(gte(listings.gradeNum, minGrade));
    const minPrice = asNumber(q.minPrice);
    if (minPrice !== undefined) filters.push(gte(listings.price, usd(minPrice)));
    const maxPrice = asNumber(q.maxPrice);
    if (maxPrice !== undefined) filters.push(lte(listings.price, usd(maxPrice)));
    const year = asNumber(q.year);
    if (year !== undefined) filters.push(eq(listings.year, year));
    const minDiscount = asNumber(q.minDiscount);
    if (minDiscount !== undefined) filters.push(sql`${listings.insuredValue} > 0 and (1 - ${listings.price}::float8 / ${listings.insuredValue}) * 100 >= ${minDiscount}`);
    const sort = LISTING_SORTS[(q.sort ?? "newest") as keyof typeof LISTING_SORTS] ?? LISTING_SORTS.newest;
    const limit = Math.max(0, Math.min(Math.floor(asNumber(q.limit) ?? 100), 500));
    const rows = await db.select().from(listings).where(and(...filters)).orderBy(sort).limit(limit).offset(Math.max(0, Math.floor(asNumber(q.offset) ?? 0)));
    const total = await db.select({ n: count() }).from(listings).where(and(...filters));
    return { rows: rows.map(listingDto), total: total[0]?.n ?? 0 };
  });

  app.get("/listings/facets", async () => {
    const categories = await db
      .select({ value: listings.category, n: count() })
      .from(listings)
      .where(and(eq(listings.active, true), sql`${listings.category} is not null`))
      .groupBy(listings.category)
      .orderBy(desc(count()))
      .limit(14);
    const graders = await db
      .select({ value: listings.grader, n: count() })
      .from(listings)
      .where(and(eq(listings.active, true), sql`${listings.grader} is not null`))
      .groupBy(listings.grader)
      .orderBy(desc(count()))
      .limit(6);
    return { categories, graders };
  });

  app.get("/pulse", async () => {
    const fresh = await db.select().from(listings).where(eq(listings.active, true)).orderBy(desc(listings.listedAt)).limit(40);
    const below = await db
      .select()
      .from(listings)
      .where(and(eq(listings.active, true), sql`${listings.insuredValue} > ${listings.price}`, gte(listings.insuredValue, usd(5))))
      .orderBy(LISTING_SORTS.discount)
      .limit(40);
    const recentPulls = await db.select().from(pulls).orderBy(desc(pulls.at)).limit(40);
    return { fresh: fresh.map(listingDto), below: below.map(listingDto), pulls: recentPulls };
  });

  app.get("/pulls", async (request) => {
    const q = request.query as { limit?: string; packType?: string; wallet?: string };
    const filters = [];
    if (q.packType) filters.push(eq(pulls.packType, q.packType));
    if (q.wallet) filters.push(eq(pulls.winner, q.wallet));
    return db.select().from(pulls).where(and(...filters)).orderBy(desc(pulls.at)).limit(Math.max(0, Math.min(Math.floor(asNumber(q.limit) ?? 50), 200)));
  });

  app.get("/machines", async () => {
    const rows = await db.select().from(machines).where(eq(machines.isPublic, true)).orderBy(asc(machines.price));
    const settings = await getSetting(db, "cashback");
    return rows.map((row) => ({ ...row, evPct: row.ev ? Math.round((row.ev / row.price) * 1000) / 10 : null, cashbackCapBps: cashbackCapBps(toEconRow(row), settings) }));
  });

  // Public market data for the status bar, cached so traffic here never reaches the data source.
  let tokens: { at: number; cards: TokenMarket | null; gdex: TokenMarket | null } = { at: 0, cards: null, gdex: null };
  app.get("/tokens", async () => {
    const mint = process.env.GEMDEX_TOKEN_MINT;
    if (Date.now() - tokens.at > 60_000) {
      tokens.at = Date.now();
      const [cards, gdex] = await Promise.all([fetchTokenMarket(CARDS_MINT), mint ? fetchTokenMarket(mint) : null]);
      tokens = { at: tokens.at, cards: cards ?? tokens.cards, gdex: gdex ?? tokens.gdex };
    }
    return { cards: tokens.cards, gdex: tokens.gdex, gdexLaunched: !!mint };
  });

  app.get("/drops", async () => {
    const live = await db.select().from(drops).where(eq(drops.state, "LIVE")).orderBy(desc(drops.opensAt)).limit(30);
    const recent = await db.select().from(drops).where(inArray(drops.state, ["SETTLED", "DELIVERED"])).orderBy(desc(drops.updatedAt)).limit(30);
    const status = await loadJson(db, "dropsStatus");
    const [drop, cashback] = await Promise.all([balanceOf(db, "drops"), balanceOf(db, "cashback")]);
    return { live: live.map(publicDrop), recent: recent.map(publicDrop), status, pools: { drops: drop, cashback } };
  });

  app.get("/cards/:nft", async (request, reply) => {
    const { nft } = request.params as { nft: string };
    const listingRows = await db.select().from(listings).where(eq(listings.nft, nft));
    const [detail, market] = await Promise.all([cc.card(nft).catch(() => null), cc.cardMarket(nft).catch(() => null)]);
    const listing = listingRows[0];
    if (!listing && !detail) return reply.code(404).send({ error: "Card not found" });
    const salesRows = await db.select().from(sales).where(eq(sales.nft, nft)).orderBy(desc(sales.soldAt)).limit(50);
    const points = await db.select().from(pricePoints).where(eq(pricePoints.nft, nft)).orderBy(asc(pricePoints.at)).limit(500);
    // "2023 #051 Snorlax PSA 9 ..." is the same card as "2023 #051 Snorlax CGC 10 ...", in another grade.
    const title = String(detail?.itemName ?? listing?.name ?? "").replace(/\s+(PSA|CGC|BGS|SGC)\s+[\d.]+.*$/i, "").trim();
    const comps = title.length >= 6
      ? await db.select().from(listings).where(and(eq(listings.active, true), ilike(listings.name, `${title.replace(/[%_\\]/g, "")}%`), sql`${listings.nft} <> ${nft}`)).orderBy(asc(listings.price)).limit(12)
      : [];
    const pulse = await db
      .select({ number: drops.number, price: drops.price, boughtBy: drops.boughtBy, at: drops.stoppedAt })
      .from(drops)
      .where(and(eq(drops.nft, nft), sql`${drops.boughtBy} is not null and ${drops.stoppedAt} is not null`))
      .orderBy(desc(drops.stoppedAt))
      .limit(20);
    return {
      nft, listing: listing ? listingDto(listing) : null, detail, market, sales: salesRows, points, comps: comps.map(listingDto), pulse,
      gradeNum: parseGradeNumber(String(detail?.grade ?? listing?.grade ?? "")),
    };
  });

  // Who pulled the most value in the last day, for the Tracker. Everyone sees the same list, so it's cached.
  let pullers: { at: number; rows: unknown[] } = { at: 0, rows: [] };
  app.get("/pullers", async () => {
    if (Date.now() - pullers.at > 30_000) {
      const rows = await raw<{ wallet: string; pulls: string; value: string; best: string | null; best_name: string | null; best_image: string | null; best_nft: string | null; last_at: Date }[]>`
        select winner as wallet, count(*) as pulls, coalesce(sum(insured_value), 0) as value, max(insured_value) as best,
          (array_agg(name order by insured_value desc nulls last))[1] as best_name,
          (array_agg(image order by insured_value desc nulls last))[1] as best_image,
          (array_agg(nft order by insured_value desc nulls last))[1] as best_nft,
          max(at) as last_at
        from pulls where at > now() - interval '24 hours'
        group by winner order by coalesce(sum(insured_value), 0) desc limit 15`;
      pullers = {
        at: Date.now(),
        rows: rows.map((r) => ({
          wallet: r.wallet, pulls: Number(r.pulls), value: Number(r.value), best: r.best === null ? null : Number(r.best),
          bestName: r.best_name, bestImage: r.best_image, bestNft: r.best_nft, lastAt: r.last_at,
        })),
      };
    }
    return pullers.rows;
  });

  app.get("/leaderboard", async () => {
    const rows = await raw<{ handle: string; wins: string; spent: string; value: string }[]>`
      select u.handle, count(*) as wins, coalesce(sum(h.cost), 0) as spent, coalesce(sum(h.insured_value), 0) as value
      from holdings h join users u on u.id = h.user_id
      where h.source = 'drop' and h.acquired_at > now() - interval '7 days'
      group by u.handle order by count(*) desc limit 20`;
    return rows.map((row) => ({ handle: row.handle, wins: Number(row.wins), spent: Number(row.spent), value: Number(row.value) }));
  });

  // Session ---------------------------------------------------------------------

  app.post("/auth/paper", async (request, reply) => {
    if (!paper) return reply.code(404).send({ error: "Paper mode is off" });
    const { handle } = (request.body ?? {}) as { handle?: string };
    const id = await createPaperUser(db, paper, handle);
    return { token: await issueSession(id) };
  });

  app.post("/auth/privy", async (request, reply) => {
    if (mode === "paper") return reply.code(404).send({ error: "Wallet sign-in is off in paper mode" });
    const { accessToken } = (request.body ?? {}) as { accessToken?: string };
    if (!accessToken) return reply.code(400).send({ error: "Missing sign-in token" });
    const result = await privySession(db, accessToken);
    if ("error" in result) return reply.code(401).send({ error: result.error });
    return { token: await issueSession(result.userId) };
  });

  app.get("/me", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const user = await loadUser(db, userId);
    if (!user) return reply.code(401).send({ error: "Session expired" });
    const [balance, available, settings, cashback] = await Promise.all([
      balanceOf(db, userAccount(userId)), availableBalance(db, userId), getSetting(db, "drops"), getSetting(db, "cashback"),
    ]);
    let tokens = 0;
    if (user.holderWallet) {
      const since = new Date(Date.now() - 86_400_000);
      const rows = await db.select({ b: holderSnapshots.balance }).from(holderSnapshots).where(and(eq(holderSnapshots.wallet, user.holderWallet), gte(holderSnapshots.takenAt, since)));
      tokens = holderBalance(rows.map((row) => row.b));
    }
    const left = user.lastWinAt ? settings.winCooldownSec - (Date.now() - user.lastWinAt.getTime()) / 1000 : 0;
    const access = await accessOf(user, false).catch(() => null);
    return {
      id: user.id, handle: user.handle, tradingWallet: user.tradingWallet, connectedWallet: user.connectedWallet, holderWallet: user.holderWallet,
      isAdmin: isAdmin(user), strikes: user.strikes, settings: user.settings, balance, available, held: balance - available,
      cooldownSec: Math.max(0, Math.ceil(left)), tokens, tier: tierFor(tokens, cashback.tiers), access,
    };
  });

  app.patch("/me/settings", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const body = (request.body ?? {}) as { quickBuy?: unknown; tradeLimitUsd?: unknown; autoForward?: unknown; soundOn?: unknown };
    const user = await loadUser(db, userId);
    // Only known keys are stored, each only when sent and well formed, so saving one setting never wipes another.
    const merged = { ...user!.settings };
    if ("tradeLimitUsd" in body) merged.tradeLimitUsd = typeof body.tradeLimitUsd === "number" && body.tradeLimitUsd > 0 ? body.tradeLimitUsd : undefined;
    if (typeof body.autoForward === "boolean") merged.autoForward = body.autoForward;
    if (typeof body.soundOn === "boolean") merged.soundOn = body.soundOn;
    if (Array.isArray(body.quickBuy)) merged.quickBuy = body.quickBuy.filter((n): n is number => typeof n === "number" && n > 0).slice(0, 5);
    await db.update(users).set({ settings: merged }).where(eq(users.id, userId));
    return merged;
  });

  // Trading ---------------------------------------------------------------------

  app.post("/drops/:id/claim", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const { id } = request.params as { id: string };
    const { idempotencyKey, maxPrice } = (request.body ?? {}) as { idempotencyKey?: string; maxPrice?: number };
    if (!idempotencyKey) return reply.code(400).send({ error: "Missing idempotency key" });
    if (!UUID.test(id)) return { status: "rejected", reason: "not_found" };
    if (maxPrice !== undefined && !Number.isSafeInteger(maxPrice)) return reply.code(400).send({ error: "Bad price" });
    const user = await loadUser(db, userId);
    if (!user) return reply.code(401).send({ error: "Session expired" });
    const refused = await accessRefusal(user);
    if (refused) return { status: "rejected", reason: refused.code, message: refused.error, access: refused.access };
    const paused = await tradingPaused();
    if (paused) return { status: "rejected", reason: "drops_paused", message: paused };
    return claimDrop(db, { userId, dropId: id, idempotencyKey, maxPrice });
  });

  const order = async (request: Parameters<typeof userIdFrom>[0], reply: { code: (n: number) => { send: (b: unknown) => unknown } }, userId: string, input: Parameters<typeof placeOrder>[1]) => {
    const result = await db.transaction((tx) => placeOrder(tx, input));
    if (!result.ok) return reply.code(402).send({ error: "Not enough USDC in your trading wallet", available: result.available });
    return { orderId: result.orderId };
  };

  app.post("/orders/buy", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const { nft, price, idempotencyKey } = (request.body ?? {}) as { nft: string; price: number; idempotencyKey: string };
    if (typeof nft !== "string" || !Number.isSafeInteger(price) || price <= 0 || !idempotencyKey) return reply.code(400).send({ error: "Bad order" });
    const user = await loadUser(db, userId);
    if (!user) return reply.code(401).send({ error: "Session expired" });
    const refused = await accessRefusal(user);
    if (refused) return reply.code(refused.code === "access" ? 403 : 503).send(refused);
    const limit = user.settings.tradeLimitUsd;
    if (limit && price > usd(limit)) return reply.code(400).send({ error: `Over your ${limit} USDC trade limit` });
    const paused = await tradingPaused();
    if (paused) return reply.code(503).send({ error: paused });
    return order(request, reply, userId, { userId, kind: "market_buy", params: { nft, price }, holdAmount: price, idempotencyKey });
  });

  app.post("/orders/open", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const { machine, turbo, count: quantity, idempotencyKey } = (request.body ?? {}) as { machine: string; turbo?: boolean; count?: number; idempotencyKey: string };
    const user = await loadUser(db, userId);
    if (!user) return reply.code(401).send({ error: "Session expired" });
    const refused = await accessRefusal(user);
    if (refused) return reply.code(refused.code === "access" ? 403 : 503).send(refused);
    if (typeof machine !== "string" || typeof idempotencyKey !== "string" || !idempotencyKey) return reply.code(400).send({ error: "Bad order" });
    if (quantity !== undefined && !(Number.isInteger(quantity) && quantity >= 1 && quantity <= 100)) return reply.code(400).send({ error: "Open between 1 and 100 packs" });
    const paused = await tradingPaused();
    if (paused) return reply.code(503).send({ error: paused });
    const rows = await db.select().from(machines).where(eq(machines.code, machine));
    const row = rows[0];
    if (!row || !row.isOpen) return reply.code(400).send({ error: "This machine is closed" });
    const n = quantity ?? 1;
    const placed: string[] = [];
    for (let i = 0; i < n; i++) {
      const result = await db.transaction((tx) => placeOrder(tx, { userId, kind: "gacha_open", params: { machine, turbo: !!turbo }, holdAmount: row.price, idempotencyKey: `${idempotencyKey}:${i}` }));
      if (!result.ok) {
        if (placed.length === 0) return reply.code(402).send({ error: "Not enough USDC in your trading wallet" });
        break;
      }
      placed.push(result.orderId);
    }
    return { orderIds: placed };
  });

  app.post("/orders/holding", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const { action, holdingId, nft, price, idempotencyKey } = (request.body ?? {}) as { action: "buyback" | "list" | "send"; holdingId: string; nft?: string; price?: number; idempotencyKey: string };
    if (!HOLDING_ACTIONS.includes(action) || !idempotencyKey) return reply.code(400).send({ error: "Bad order" });
    if (action === "list" && !(Number.isSafeInteger(price) && price! > 0)) return reply.code(400).send({ error: "Enter a price" });
    if (action !== "send" && !UUID.test(holdingId ?? "")) return reply.code(400).send({ error: "Bad order" });
    if (action === "send" && (typeof nft !== "string" || !nft)) return reply.code(400).send({ error: "Bad order" });
    if (action === "list") {
      // Listings are signed by the trading wallet, so a card in the user's own wallet can't be listed from here.
      const held = await db.select({ wallet: holdings.wallet }).from(holdings).where(and(eq(holdings.id, holdingId), eq(holdings.userId, userId)));
      if (held[0] && held[0].wallet !== "trading") return reply.code(400).send({ error: "Only cards in your trading wallet can be listed here" });
    }
    const paused = await tradingPaused();
    if (paused) return reply.code(503).send({ error: paused });
    return order(request, reply, userId, { userId, kind: action, params: action === "list" ? { holdingId, price } : action === "send" ? { nft } : { holdingId }, holdAmount: 0, idempotencyKey });
  });

  app.get("/orders/:id", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: "Not found" });
    const rows = await db.select().from(orders).where(and(eq(orders.id, id), eq(orders.userId, userId)));
    return rows[0] ?? reply.code(404).send({ error: "Not found" });
  });

  // Sell-back from the connected wallet -------------------------------------------
  // Won cards sit in the wallet the user owns, so only they can sign. The gateway fetches
  // CC's transaction and relays it. It never sees a key, and proceeds go to the trading wallet.

  const ownedConnected = async (userId: string, id: string) => {
    if (!UUID.test(id)) return null;
    const rows = await db.select().from(holdings).where(and(eq(holdings.id, id), eq(holdings.userId, userId), eq(holdings.status, "held"), eq(holdings.wallet, "connected")));
    return rows[0] ?? null;
  };

  /** A CC call that never hangs a request. `reached` is false when CC's answer is unknown (timeout or network). */
  const gacha = async (path: string, body: unknown, timeoutMs = 15_000) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "tenner/0.1" };
    if (process.env.CC_API_KEY) headers["x-api-key"] = process.env.CC_API_KEY;
    try {
      const res = await fetch(`${cc.endpoints.gachaBase}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      return { reached: true, ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    } catch {
      return { reached: false, ok: false, json: {} as Record<string, unknown> };
    }
  };

  app.post("/holdings/:id/buyback-tx", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    if (paper) return reply.code(404).send({ error: "Paper mode sells back through orders" });
    const holding = await ownedConnected(userId, (request.params as { id: string }).id);
    if (!holding) return reply.code(404).send({ error: "You do not hold this card" });
    const user = await loadUser(db, userId);
    const built = await gacha("/api/buyback", { playerAddress: user!.connectedWallet, nftAddress: holding.nft, altRecipient: user!.tradingWallet });
    if (!built.reached) return reply.code(503).send({ error: "Collector Crypt is not answering. Try again in a moment." });
    const amount = Number(built.json.refundAmount);
    // The same bounds the worker uses: anything else is not a real offer.
    const offered = typeof built.json.serializedTransaction === "string" && Number.isSafeInteger(amount) && amount >= 10_000 && amount <= 280_000_000_000;
    if (!built.ok || !offered) return reply.code(400).send({ error: "The buyback window has closed" });
    await saveJson(db, `buybackOffer:${holding.id}`, { amount, at: Date.now() });
    return { transaction: built.json.serializedTransaction, amount };
  });

  app.post("/holdings/:id/buyback-submit", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    if (paper) return reply.code(404).send({ error: "Paper mode sells back through orders" });
    const holding = await ownedConnected(userId, (request.params as { id: string }).id);
    if (!holding) return reply.code(404).send({ error: "You do not hold this card" });
    const { signedTransaction } = (request.body ?? {}) as { signedTransaction: string };
    if (typeof signedTransaction !== "string" || !signedTransaction) return reply.code(400).send({ error: "Bad transaction" });
    // It must be this card's sell-back, or the wrong card would be marked sold.
    if (!mentionsAccount(signedTransaction, holding.nft)) return reply.code(400).send({ error: "That transaction is not this card's sell-back. Start the sell-back again." });
    const offer = await loadJson<{ amount: number; at: number }>(db, `buybackOffer:${holding.id}`);
    // CC waits for the chain before it answers, so it gets longer than other calls.
    const sent = await gacha("/api/submitTransaction", { signedTransaction }, 45_000);
    if (!sent.reached) return reply.code(504).send({ error: "We could not confirm the sell-back. Check your wallet before trying again." });
    if (!sent.ok || sent.json.success !== true) return reply.code(400).send({ error: "The sell-back did not go through" });
    // Only a confirmed sale is booked. A processed one can still fail, and the card would look sold.
    const confirmation = sent.json.confirmationStatus;
    if (confirmation !== "confirmed" && confirmation !== "finalized") {
      return reply.code(409).send({ error: "The sell-back was sent but is not confirmed yet. Check your wallet before trying again." });
    }
    await db.transaction(async (tx) => {
      // The amount comes from our stored quote, never the client. The USDC itself reaches the book through deposit sync.
      await tx.update(holdings).set({ status: "bought_back", exitPrice: offer?.amount ?? holding.buybackAmount, exitedAt: new Date() }).where(eq(holdings.id, holding.id));
      await tx.insert(activity).values({ userId, kind: "sell", title: `Sold back ${String(holding.card.name ?? "a card")}`, delta: 0, ref: holding.nft });
    });
    return { ok: true };
  });

  // Portfolio -------------------------------------------------------------------

  app.get("/portfolio", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const rows = await db.select().from(holdings).where(eq(holdings.userId, userId)).orderBy(desc(holdings.acquiredAt));
    const held = rows.filter((row) => row.status === "held" || row.status === "listed");
    const exited = rows.filter((row) => row.status === "bought_back" || row.status === "sold");
    const value = held.reduce((sum, row) => sum + (row.insuredValue ?? 0), 0);
    const cost = held.reduce((sum, row) => sum + row.cost, 0);
    const realized = exited.reduce((sum, row) => sum + ((row.exitPrice ?? 0) - row.cost), 0);
    const days = await raw<{ day: string; pnl: string }[]>`
      select to_char(exited_at, 'YYYY-MM-DD') as day, sum(exit_price - cost) as pnl
      from holdings where user_id = ${userId} and exited_at is not null group by 1 order by 1 desc limit 120`;
    // Every movement of the trading wallet, so the chart can show net worth and not just cards.
    const wallet = await raw<{ at: Date; delta: string }[]>`
      select date_trunc('second', created_at) as at, sum(delta) as delta
      from ledger_entries where account = ${userAccount(userId)} group by 1 order by 1`;
    return {
      held, exited, summary: { value, cost, unrealized: value - cost, realized },
      days: days.map((d) => ({ day: d.day, pnl: Number(d.pnl) })),
      wallet: wallet.map((w) => ({ at: w.at, delta: Number(w.delta) })),
    };
  });

  app.get("/activity", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    return db.select().from(activity).where(eq(activity.userId, userId)).orderBy(desc(activity.id)).limit(100);
  });

  app.post("/wallet/faucet", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    if (!paper) return reply.code(404).send({ error: "Paper mode is off" });
    await grantPaperFunds(db, paper, userId, usd(100));
    await emit(db, `user:${userId}`, { type: "balance" });
    return { ok: true };
  });

  // Pulse ------------------------------------------------------------------------

  app.get("/pulse/drops", async () => {
    const settings = await getSetting(db, "drops");
    const live = await db.select().from(drops).where(eq(drops.state, "LIVE")).orderBy(asc(drops.number));
    const done = await db.select().from(drops).where(inArray(drops.state, ["CLAIMED", "SETTLING", "SETTLED", "QUOTED", "DEBITING", "PACK_PAYING", "OPENING", "DELIVERED"])).orderBy(desc(drops.updatedAt)).limit(60);
    return { drops: [...live, ...done.filter((d) => d.stoppedAt)].map((d) => pulseView(d)), newPullSec: settings.newPullSec, moveSec: settings.ttlSec };
  });

  app.get("/pulse/drops/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: "Card not found" });
    const rows = await db.select().from(drops).where(eq(drops.id, id));
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "Card not found" });
    const userId = await userIdFrom(request);
    const limits = userId ? await db.select().from(dropLimits).where(and(eq(dropLimits.dropId, id), eq(dropLimits.userId, userId), eq(dropLimits.state, "open"))) : [];
    return { drop: pulseView(row), prices: pastPrices(row), limit: limits[0] ?? null };
  });

  app.post("/pulse/drops/:id/limit", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    if (!(await gateFeature(reply, userId))) return;
    const { id } = request.params as { id: string };
    const { maxPrice } = (request.body ?? {}) as { maxPrice: number };
    if (!UUID.test(id) || !Number.isSafeInteger(maxPrice) || maxPrice <= 0) return reply.code(400).send({ error: "Enter a price" });
    const rows = await db.select({ state: drops.state }).from(drops).where(eq(drops.id, id));
    if (rows[0]?.state !== "LIVE") return reply.code(400).send({ error: "This card is gone" });
    return db.transaction(async (tx) => {
      // Serialises this user's saves for this card, so two quick ones can't both insert an open order.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`limit:${userId}:${id}`}))`);
      await tx.update(dropLimits).set({ state: "cancelled" }).where(and(eq(dropLimits.dropId, id), eq(dropLimits.userId, userId), eq(dropLimits.state, "open")));
      const created = await tx.insert(dropLimits).values({ dropId: id, userId, maxPrice }).returning();
      return created[0];
    });
  });

  app.delete("/pulse/drops/:id/limit", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(404).send({ error: "Card not found" });
    await db.update(dropLimits).set({ state: "cancelled" }).where(and(eq(dropLimits.dropId, id), eq(dropLimits.userId, userId), eq(dropLimits.state, "open")));
    return { ok: true };
  });

  // Tracker and watchlist ------------------------------------------------------

  app.get("/tracker", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const wallets = await db.select().from(trackedWallets).where(eq(trackedWallets.userId, userId));
    const addresses = wallets.map((w) => w.wallet);
    if (addresses.length === 0) return { wallets, feed: [] };
    const pullRows = await db.select().from(pulls).where(inArray(pulls.winner, addresses)).orderBy(desc(pulls.at)).limit(50);
    const listingRows = await db.select().from(listings).where(and(inArray(listings.seller, addresses), eq(listings.active, true))).orderBy(desc(listings.listedAt)).limit(50);
    const feed = [
      ...pullRows.map((p) => ({ kind: "pull" as const, wallet: p.winner, at: p.at, name: p.name, image: p.image, nft: p.nft, value: p.insuredValue, rarity: p.rarity })),
      ...listingRows.map((l) => ({ kind: "listing" as const, wallet: l.seller!, at: l.listedAt ?? l.firstSeen, name: l.name, image: l.image, nft: l.nft, value: l.price, rarity: null })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { wallets, feed };
  });

  app.post("/tracker", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    if (!(await gateFeature(reply, userId))) return;
    const { wallet, label } = (request.body ?? {}) as { wallet: string; label?: string };
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet ?? "")) return reply.code(400).send({ error: "That is not a Solana address" });
    await db.insert(trackedWallets).values({ userId, wallet, label: (label || wallet.slice(0, 6)).slice(0, 32) }).onConflictDoNothing();
    return { ok: true };
  });

  app.delete("/tracker/:wallet", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const { wallet } = request.params as { wallet: string };
    await db.delete(trackedWallets).where(and(eq(trackedWallets.userId, userId), eq(trackedWallets.wallet, wallet)));
    return { ok: true };
  });

  app.get("/watchlist", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const rows = await db.select({ item: watchlist, listing: listings }).from(watchlist).leftJoin(listings, eq(listings.nft, watchlist.nft)).where(eq(watchlist.userId, userId));
    return rows.map((row) => ({ nft: row.item.nft, listing: row.listing ? listingDto(row.listing) : null }));
  });

  app.post("/watchlist/:nft", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    if (!(await gateFeature(reply, userId))) return;
    const { nft } = request.params as { nft: string };
    const removed = await db.delete(watchlist).where(and(eq(watchlist.userId, userId), eq(watchlist.nft, nft))).returning();
    if (removed.length === 0) await db.insert(watchlist).values({ userId, nft });
    return { watching: removed.length === 0 };
  });

  // Rewards ---------------------------------------------------------------------

  app.get("/rewards", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const earned = await raw<{ total: string; n: string }[]>`
      select coalesce(sum(amount), 0) as total, count(*) as n from cashback_accruals where user_id = ${userId} and status = 'paid'`;
    const [pool, settings] = await Promise.all([balanceOf(db, "cashback"), getSetting(db, "cashback")]);
    const history = await raw<{ machine_code: string; amount: string; rate_bps: number; created_at: Date }[]>`
      select machine_code, amount, rate_bps, created_at from cashback_accruals where user_id = ${userId} and status = 'paid' order by created_at desc limit 20`;
    return {
      earned: Number(earned[0]?.total ?? 0), packs: Number(earned[0]?.n ?? 0), pool, tiers: settings.tiers, dailyCap: settings.dailyCapPerUser,
      history: history.map((h) => ({ machineCode: h.machine_code, amount: Number(h.amount), rateBps: h.rate_bps, at: h.created_at })),
    };
  });

  /** Paper only. Real linking requires a signature from the holder wallet. */
  app.post("/rewards/paper-tokens", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    if (!paper) return reply.code(404).send({ error: "Paper mode is off" });
    const { tokens } = (request.body ?? {}) as { tokens: number };
    const user = await loadUser(db, userId);
    const wallet = user!.holderWallet ?? user!.connectedWallet;
    if (!user!.holderWallet) await db.update(users).set({ holderWallet: wallet }).where(eq(users.id, userId));
    await paper.setTokenBalance(wallet, tokens);
    // The balance just changed, so /me must read it fresh rather than reuse its last reading.
    accessCache.delete(userId);
    await db.delete(holderSnapshots).where(eq(holderSnapshots.wallet, wallet));
    await db.insert(holderSnapshots).values({ wallet, balance: tokens });
    return { ok: true };
  });

  // Admin -----------------------------------------------------------------------

  /**
   * On a real chain, admin follows ADMIN_WALLETS on every request, so removing a wallet takes effect at once rather
   * than when that person next signs in. Paper keeps its own flag for local use.
   */
  const isAdmin = (user: { isAdmin: boolean; connectedWallet: string }) => {
    if (paper) return user.isAdmin;
    return (process.env.ADMIN_WALLETS ?? "").split(",").map((w) => w.trim()).filter(Boolean).includes(user.connectedWallet);
  };

  /** Why new trades can't start right now, if they can't: the kill switch, or mainnet not armed. Nothing would sign them. */
  const tradingPaused = async (): Promise<string | null> => {
    const ops = await getSetting(db, "ops");
    if (ops.killSwitch) return "Trading is paused right now. Try again soon.";
    if (mode === "mainnet") {
      const until = ops.armedUntil ? new Date(ops.armedUntil).getTime() : 0;
      if (until <= Date.now() || new Set(ops.armedBy).size < 2) return "Trading is paused right now. Try again soon.";
    }
    return null;
  };

  const requireAdmin = async (request: Parameters<typeof userIdFrom>[0], reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const userId = await userIdFrom(request);
    const user = userId ? await loadUser(db, userId) : null;
    if (!user || !isAdmin(user)) {
      reply.code(403).send({ error: "Admins only" });
      return null;
    }
    return user;
  };

  app.get("/admin/overview", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const [dropSettings, fees, cashback, flywheel, ops, status] = await Promise.all([
      getSetting(db, "drops"), getSetting(db, "fees"), getSetting(db, "cashback"), getSetting(db, "flywheel"), getSetting(db, "ops"), loadJson(db, "dropsStatus"),
    ]);
    const accounts = await db.select().from(balances).where(sql`${balances.account} in ('drops', 'cashback', 'fee', 'gifts', 'gift_reserved', 'revenue')`);
    const runs = await db.select().from(feeRuns).orderBy(desc(feeRuns.createdAt)).limit(12);
    const checks = await db.select().from(reconcileRuns).orderBy(desc(reconcileRuns.id)).limit(6);
    const stateCounts = await db.select({ state: drops.state, kind: drops.kind, n: count() }).from(drops).groupBy(drops.state, drops.kind);
    const stuck = await db.select({ n: count() }).from(holds).where(and(eq(holds.status, "active"), sql`${holds.createdAt} < now() - interval '5 minutes'`));
    const open = await db.select({ n: count() }).from(claims).where(eq(claims.state, "won"));
    const packs = await db.select({ n: count() }).from(ccPacks).where(gt(ccPacks.createdAt, new Date(Date.now() - 86_400_000)));
    const moves = await db.select().from(treasuryMoves).orderBy(desc(treasuryMoves.createdAt)).limit(8);
    const treasuryWallets = await loadJson<{ drops: string; cashback: string; feePayer: string }>(db, "treasuryWallets");
    return {
      mode, settings: { drops: dropSettings, fees, cashback, flywheel }, ops, status, accounts, runs, checks, stateCounts, moves, treasuryWallets,
      alerts: { stuckHolds: stuck[0]?.n ?? 0, openClaims: open[0]?.n ?? 0, packs24h: packs[0]?.n ?? 0 },
    };
  });

  app.patch("/admin/settings/:key", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { key } = request.params as { key: "drops" | "fees" | "cashback" | "flywheel" };
    if (!["drops", "fees", "cashback", "flywheel"].includes(key)) return reply.code(400).send({ error: "Unknown settings" });
    const body = (request.body ?? {}) as Record<string, number>;
    if (key === "flywheel") {
      const bps = ["accessBps", "giftHoldBps", "giftBps", "giftSpendBps", "saleBuybackBps", "platformFeeBps", "buybackMaxSlippageBps"] as const;
      if (bps.some((name) => body[name] !== undefined && !(Number.isInteger(body[name]) && body[name]! >= 0 && body[name]! <= 10_000))) {
        return reply.code(400).send({ error: "Shares are basis points from 0 to 10000" });
      }
    }
    if (key === "drops") {
      if (!(body.minPrice! > 0) || body.maxPrice! < body.minPrice! || !(body.crashHi! <= 1) || body.crashLo! > body.crashHi! || !(body.ttlSec! > 0)) {
        return reply.code(400).send({ error: "Those drop settings do not make sense" });
      }
    }
    return setSetting(db, key, request.body as never);
  });

  app.post("/admin/ops", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { killSwitch, reconcileHold } = (request.body ?? {}) as { killSwitch?: boolean; reconcileHold?: boolean };
    const patch: Record<string, boolean> = {};
    if (typeof killSwitch === "boolean") patch.killSwitch = killSwitch;
    if (typeof reconcileHold === "boolean") patch.reconcileHold = reconcileHold;
    return setSetting(db, "ops", patch);
  });

  /**
   * Records USDC an admin moved into or out of the Drops or Cashback wallet by hand, so the books follow. The worker
   * reads the transaction and books exactly what moved; Tenner's own transactions are refused there.
   */
  app.post("/admin/treasury-moves", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    if (mode === "paper") return reply.code(400).send({ error: "Paper treasury wallets are funded automatically" });
    const { signature, wallet } = (request.body ?? {}) as { signature?: unknown; wallet?: unknown };
    const sig = typeof signature === "string" ? signature.trim() : "";
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) return reply.code(400).send({ error: "That is not a transaction signature" });
    if (wallet !== "drops" && wallet !== "cashback") return reply.code(400).send({ error: "Pick the Drops or Cashback wallet" });
    const rows = await db.insert(treasuryMoves).values({ signature: sig, wallet, createdBy: admin.id }).onConflictDoNothing().returning();
    if (!rows[0]) return reply.code(409).send({ error: "That transaction is already recorded" });
    return rows[0];
  });

  /** Mainnet signing needs two different admins, and the arm expires on its own. */
  app.post("/admin/arm", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    if (mode !== "mainnet") return reply.code(400).send({ error: "Arming only applies to mainnet" });
    return db.transaction(async (tx) => {
      // Two admins pressing at once must not overwrite each other.
      await tx.execute(sql`select pg_advisory_xact_lock(7270013)`);
      const ops = await getSetting(tx, "ops");
      const waiting = ops.armRequestBy && ops.armRequestedAt && Date.now() - new Date(ops.armRequestedAt).getTime() < 15 * 60_000 ? ops.armRequestBy : null;
      if (waiting && waiting !== admin.id) {
        return setSetting(tx, "ops", { armedBy: [waiting, admin.id], armedUntil: new Date(Date.now() + 2 * 3_600_000).toISOString(), armRequestBy: null, armRequestedAt: null });
      }
      // The first press, or the same admin again: a request that waits for someone else. The current arm stands.
      return setSetting(tx, "ops", { armRequestBy: admin.id, armRequestedAt: new Date().toISOString() });
    });
  });

  app.post("/admin/disarm", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return setSetting(db, "ops", { armedBy: [], armedUntil: null, armRequestedAt: null, armRequestBy: null });
  });

  // The $TENR flywheel: its public page and gift claims (docs/FLYWHEEL.md).
  flywheelRoutes(app, { database, accessRefusal, tradingPaused });

  return app;
}
