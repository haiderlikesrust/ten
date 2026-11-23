// Public profiles (a unique username, a picture, a bio, an X handle) and the sniping leaderboard.
import { randomBytes } from "node:crypto";
import { and, avatars, eq, inArray, ne, sql, users, type Database } from "@gemdex/db";
import type { FastifyInstance } from "fastify";
import { requireUser, userIdFrom } from "./auth";

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
/** Names that would look official, or clash with a page. */
const RESERVED = new Set([
  "admin", "administrator", "tenner", "tennertrade", "support", "help", "official", "team", "staff", "mod", "moderator", "system", "root",
  "me", "you", "null", "undefined", "anonymous", "leaderboard", "profile", "settings", "collectorcrypt",
]);
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const BIO_MAX = 160;
/** A picture is resized in the browser to 256 pixels, which is far below this. */
const AVATAR_MAX_BYTES = 150_000;
const AVATAR_TYPES: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
};

export type Period = "24h" | "7d" | "30d" | "all";
export type Sort = "snipes" | "profit" | "best" | "volume";
const PERIOD_HOURS: Record<Period, number | null> = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30, all: null };
const SORTS: Sort[] = ["snipes", "profit", "best", "volume"];

/** Where a picture is served. A new picture has a new key, so the address can be cached for ever. */
export const avatarUrl = (key: string | null) => (key ? `/avatars/${key}` : null);

/** Takes out control characters and runs of blank lines, and trims. */
function cleanText(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export interface SnipeStats {
  userId: string;
  snipes: number;
  /** What they paid for those cards. */
  spent: number;
  /** Their insured value. */
  value: number;
  /**
   * Profit on every card sniped: what it sold for minus what it cost once it is sold, and its insured value minus
   * what it cost while it is still held. The same rule as Portfolio, so the two never disagree.
   */
  profit: number;
  /** The single biggest profit on one snipe. */
  best: number;
}

/**
 * Pulse snipes per user. A card's profit is realized once it is sold or sold back, and counted at insured value
 * while it is held, the way Portfolio counts it.
 */
async function snipeStats(raw: Database["sql"], opts: { hours: number | null; userId?: string }): Promise<SnipeStats[]> {
  const since = opts.hours === null ? raw`` : raw`and h.acquired_at > now() - make_interval(hours => ${opts.hours})`;
  const who = opts.userId ? raw`and h.user_id = ${opts.userId}` : raw``;
  const rows = await raw<{ user_id: string; snipes: string; spent: string; value: string; profit: string; best: string }[]>`
    select h.user_id, count(*) as snipes, coalesce(sum(h.cost), 0) as spent, coalesce(sum(h.insured_value), 0) as value,
      coalesce(sum(${gain(raw)}), 0) as profit, coalesce(max(${gain(raw)}), 0) as best
    from holdings h
    where h.source = 'drop' ${since} ${who}
    group by h.user_id`;
  return rows.map((r) => ({
    userId: r.user_id, snipes: Number(r.snipes), spent: Number(r.spent), value: Number(r.value), profit: Number(r.profit), best: Number(r.best),
  }));
}

/** One snipe's profit, as SQL. */
function gain(raw: Database["sql"]) {
  return raw`(case when h.status in ('sold', 'bought_back') then coalesce(h.exit_price, 0) else coalesce(h.insured_value, h.cost) end - h.cost)`;
}

interface BestCard { userId: string; nft: string; name: string | null; image: string | null; cost: number; gain: number }

/** Each user's single best snipe in the period, for the card shown beside their name. */
async function bestCards(raw: Database["sql"], userIds: string[], hours: number | null): Promise<Map<string, BestCard>> {
  if (userIds.length === 0) return new Map();
  const since = hours === null ? raw`` : raw`and h.acquired_at > now() - make_interval(hours => ${hours})`;
  const rows = await raw<{ user_id: string; nft: string; name: string | null; image: string | null; cost: string; gain: string }[]>`
    select distinct on (h.user_id) h.user_id, h.nft, h.card->>'name' as name, h.card->>'image' as image, h.cost, ${gain(raw)} as gain
    from holdings h
    where h.source = 'drop' and h.user_id in ${raw(userIds)} ${since}
    order by h.user_id, ${gain(raw)} desc, h.acquired_at desc`;
  return new Map(rows.map((r) => [r.user_id, { userId: r.user_id, nft: r.nft, name: r.name, image: r.image, cost: Number(r.cost), gain: Number(r.gain) }]));
}

export function profileRoutes(app: FastifyInstance, { database }: { database: Database }) {
  const { db, sql: raw } = database;

  /** What anyone may see of a user: never a wallet address. */
  const publicUser = (u: { username: string | null; handle: string; bio: string | null; xHandle: string | null; avatarKey: string | null; createdAt: Date }) => ({
    name: u.username ?? u.handle, username: u.username, bio: u.bio, xHandle: u.xHandle, avatarUrl: avatarUrl(u.avatarKey), joinedAt: u.createdAt,
  });

  app.get("/profile", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const rows = await db.select().from(users).where(eq(users.id, userId));
    if (!rows[0]) return reply.code(401).send({ error: "Session expired" });
    return publicUser(rows[0]);
  });

  app.patch("/profile", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as { username?: unknown; bio?: unknown; xHandle?: unknown };
    const patch: Partial<typeof users.$inferInsert> = {};
    if ("username" in body) {
      const name = typeof body.username === "string" ? body.username.trim() : "";
      if (!USERNAME.test(name)) return reply.code(400).send({ error: "A username is 3 to 20 letters, numbers or underscores" });
      if (RESERVED.has(name.toLowerCase())) return reply.code(400).send({ error: "That username is reserved. Pick another." });
      const taken = await db.select({ id: users.id }).from(users).where(and(sql`lower(${users.username}) = ${name.toLowerCase()}`, ne(users.id, userId))).limit(1);
      if (taken[0]) return reply.code(409).send({ error: "That username is taken" });
      patch.username = name;
    }
    if ("bio" in body) {
      if (body.bio !== null && typeof body.bio !== "string") return reply.code(400).send({ error: "Bad bio" });
      const bio = cleanText(body.bio ?? "");
      if (bio.length > BIO_MAX) return reply.code(400).send({ error: `A bio is ${BIO_MAX} characters at most` });
      patch.bio = bio || null;
    }
    if ("xHandle" in body) {
      if (body.xHandle !== null && typeof body.xHandle !== "string") return reply.code(400).send({ error: "Bad X handle" });
      const handle = (body.xHandle ?? "").trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "");
      if (handle && !X_HANDLE.test(handle)) return reply.code(400).send({ error: "An X handle is up to 15 letters, numbers or underscores" });
      patch.xHandle = handle || null;
    }
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: "Nothing to change" });
    try {
      const rows = await db.update(users).set(patch).where(eq(users.id, userId)).returning();
      return publicUser(rows[0]!);
    } catch (error) {
      // Two people picking the same name at once: the unique index decides.
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: "That username is taken" });
      throw error;
    }
  });

  app.put("/profile/avatar", { bodyLimit: 256 * 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    const { image } = (request.body ?? {}) as { image?: unknown };
    const match = typeof image === "string" ? /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image) : null;
    if (!match) return reply.code(400).send({ error: "Pick a PNG, JPEG or WebP picture" });
    const type = match[1]!;
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) return reply.code(400).send({ error: "That picture is too big" });
    // The bytes must really be the type they claim, so nothing else is ever served as an image.
    if (!AVATAR_TYPES[type]!(bytes)) return reply.code(400).send({ error: "That file is not the picture type it says it is" });
    const key = randomBytes(16).toString("hex");
    await db.transaction(async (tx) => {
      await tx.insert(avatars).values({ key, userId, contentType: type, data: bytes.toString("base64") });
      await tx.update(users).set({ avatarKey: key }).where(eq(users.id, userId));
      await tx.delete(avatars).where(and(eq(avatars.userId, userId), ne(avatars.key, key)));
    });
    return { avatarUrl: avatarUrl(key) };
  });

  app.delete("/profile/avatar", async (request, reply) => {
    const userId = await userIdFrom(request);
    if (!requireUser(request, reply, userId)) return;
    await db.transaction(async (tx) => {
      await tx.update(users).set({ avatarKey: null }).where(eq(users.id, userId));
      await tx.delete(avatars).where(eq(avatars.userId, userId));
    });
    return { ok: true };
  });

  app.get("/avatars/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!/^[0-9a-f]{32}$/.test(key)) return reply.code(404).send({ error: "Not found" });
    const rows = await db.select().from(avatars).where(eq(avatars.key, key));
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "Not found" });
    return reply
      .header("content-type", row.contentType)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'")
      .send(Buffer.from(row.data, "base64"));
  });

  app.get("/profiles/:username", async (request, reply) => {
    const { username } = request.params as { username: string };
    if (!USERNAME.test(username)) return reply.code(404).send({ error: "No such profile" });
    const rows = await db.select().from(users).where(sql`lower(${users.username}) = ${username.toLowerCase()}`);
    const user = rows[0];
    if (!user) return reply.code(404).send({ error: "No such profile" });
    const [allTime, week] = await Promise.all([snipeStats(raw, { hours: null, userId: user.id }), snipeStats(raw, { hours: 24 * 7, userId: user.id })]);
    const empty = { snipes: 0, spent: 0, value: 0, profit: 0, best: 0 };
    const strip = (s: SnipeStats | undefined) => (s ? { snipes: s.snipes, spent: s.spent, value: s.value, profit: s.profit, best: s.best } : empty);
    const best = (await bestCards(raw, [user.id], null)).get(user.id) ?? null;
    const recent = await raw<{ nft: string; card: Record<string, unknown>; cost: string; insured_value: string | null; status: string; exit_price: string | null; acquired_at: Date }[]>`
      select nft, card, cost, insured_value, status, exit_price, acquired_at from holdings
      where user_id = ${user.id} and source = 'drop' order by acquired_at desc limit 24`;
    return {
      profile: publicUser(user),
      stats: { allTime: strip(allTime[0]), week: strip(week[0]) },
      best: best && best.gain > 0 ? { nft: best.nft, name: best.name, image: best.image, cost: best.cost, gain: best.gain } : null,
      recent: recent.map((r) => ({
        nft: r.nft, name: String(r.card.name ?? "A card"), image: typeof r.card.image === "string" ? r.card.image : null,
        grader: typeof r.card.grader === "string" ? r.card.grader : null, grade: typeof r.card.grade === "string" ? r.card.grade : null,
        cost: Number(r.cost), insuredValue: r.insured_value === null ? null : Number(r.insured_value), status: r.status,
        exitPrice: r.exit_price === null ? null : Number(r.exit_price), at: r.acquired_at,
      })),
    };
  });

  // The board is the same for everyone, so one reading serves every visitor for a little while.
  const boards = new Map<string, { at: number; rows: unknown[] }>();
  app.get("/leaderboard", async (request) => {
    const q = request.query as { period?: string; sort?: string };
    const period: Period = q.period && q.period in PERIOD_HOURS ? (q.period as Period) : "7d";
    const sort: Sort = SORTS.includes(q.sort as Sort) ? (q.sort as Sort) : "profit";
    const cacheKey = `${period}:${sort}`;
    const hit = boards.get(cacheKey);
    if (hit && Date.now() - hit.at < 20_000) return { period, sort, rows: hit.rows };
    const hours = PERIOD_HOURS[period];
    const stats = await snipeStats(raw, { hours });
    const key = (s: SnipeStats) => (sort === "snipes" ? s.snipes : sort === "best" ? s.best : sort === "volume" ? s.spent : s.profit);
    const top = stats.sort((a, b) => key(b) - key(a) || b.snipes - a.snipes).slice(0, 50);
    const ids = top.map((s) => s.userId);
    const [people, best] = await Promise.all([
      ids.length ? db.select({ id: users.id, username: users.username, handle: users.handle, avatarKey: users.avatarKey, xHandle: users.xHandle }).from(users).where(inArray(users.id, ids)) : Promise.resolve([]),
      bestCards(raw, ids, hours),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const rows = top.map((s, i) => {
      const person = byId.get(s.userId);
      const card = best.get(s.userId);
      return {
        rank: i + 1, name: person?.username ?? person?.handle ?? "Someone", username: person?.username ?? null, avatarUrl: avatarUrl(person?.avatarKey ?? null),
        xHandle: person?.xHandle ?? null, snipes: s.snipes, spent: s.spent, value: s.value, profit: s.profit, best: s.best,
        bestCard: card && card.gain > 0 ? { nft: card.nft, name: card.name, image: card.image, gain: card.gain } : null,
      };
    });
    boards.set(cacheKey, { at: Date.now(), rows });
    return { period, sort, rows };
  });
}
