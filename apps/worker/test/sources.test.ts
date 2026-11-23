// Prices from other platforms (docs/SOURCES.md): the worker's lookups and the gateway's matching, on a real Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { usd } from "@gemdex/core";
import { eq, listings, sourceLookups, sourceQuotes, sql } from "@gemdex/db";
import { CcRead, createPaperVenue, EbayHttpError, type CardSource, type SourceQuote, type SourceTarget } from "@gemdex/venues";
import { backfillListingKeys, pruneQuotes, tickSources, type Ctx } from "../src/lib";
import { buildServer } from "../../gateway/src/server";
import { createTestDb, type TestDb } from "../../../tools/testdb";

let t: TestDb;
let ctx: Ctx;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  t = await createTestDb(10);
  ctx = { db: t.db, sql: t.sql, venue: createPaperVenue(t.db), cc: new CcRead(), rng: Math.random, log: () => {}, announce: async () => {} };
  app = await buildServer({ database: t, mode: "paper" });
});

afterAll(async () => {
  await app.close();
  await t.shutdown();
});

beforeEach(async () => {
  await t.db.execute(sql`truncate listings, source_quotes, source_lookups`);
});

async function list(nft: string, name: string, price: number, opts: { grader?: string; cert?: string; keys?: boolean } = {}) {
  const grader = opts.grader ?? "PSA";
  await t.db.insert(listings).values({
    nft, name, grader, cert: opts.cert ?? null, price: usd(price), insuredValue: usd(price), source: "CC", listedAt: new Date(),
  });
  if (opts.keys !== false) await backfillListingKeys(ctx);
}

/** A source that answers from a table, and remembers what it was asked. */
function fakeSource(answers: Record<string, Array<Partial<SourceQuote> & { price: number }>>): CardSource & { asked: SourceTarget[] } {
  const asked: SourceTarget[] = [];
  return {
    id: "ebay",
    asked,
    async quotesFor(target) {
      asked.push(target);
      return (answers[target.identity.main ?? ""] ?? []).map((a, i) => ({
        id: `ebay:${target.identity.main}-${i}`, source: "ebay", kind: "ask", title: target.name, url: `https://www.ebay.com/itm/${i}`, image: null,
        grader: target.identity.grader, gradeNum: target.identity.grade, certKey: null, cardKey: `${target.identity.main}|${target.identity.number}|en|PSA|${target.identity.grade}`,
        shipping: null, at: null, ...a,
      }));
    },
  };
}

describe("matching keys on Collector Crypt listings", () => {
  it("fills keys on listings stored before there were any", async () => {
    await list("n1", "2003 #19 Salamence PSA 8 EX Dragon", 60, { cert: "118624252", keys: false });
    expect(await backfillListingKeys(ctx)).toBe(1);
    const [row] = await t.db.select().from(listings).where(eq(listings.nft, "n1"));
    expect(row).toMatchObject({ cardKey: "salamence|19|en|PSA|8", certKey: "PSA:118624252" });
  });
});

describe("looking up prices elsewhere", () => {
  it("asks about the priciest unlooked card first, once per card, and saves what it finds", async () => {
    await list("n1", "2003 #19 Salamence PSA 8 EX Dragon", 60);
    await list("n2", "2003 #19 Salamence PSA 8 EX Dragon", 70);
    await list("n3", "2000 #61 Mankey 1st Edition PSA 9 Rocket", 300);
    await list("cheap", "2000 #62 Primeape PSA 9 Rocket", 4);
    const source = fakeSource({ salamence: [{ price: usd(80), shipping: usd(5) }, { price: usd(95) }], mankey: [] });
    expect(await tickSources(ctx, [source])).toBe(0);
    expect(source.asked.map((a) => a.identity.main)).toEqual(["mankey"]);
    expect(await tickSources(ctx, [source])).toBe(2);
    expect(source.asked.map((a) => a.identity.main)).toEqual(["mankey", "salamence"]);
    // Both looked at in the last 6 hours, and a $4 card is never worth a lookup.
    expect(await tickSources(ctx, [source])).toBe(0);
    expect(source.asked.length).toBe(2);
    const lookups = await t.db.select().from(sourceLookups);
    expect(lookups.map((l) => [l.cardKey, l.found]).sort()).toEqual([["mankey|61|en|PSA|9", 0], ["salamence|19|en|PSA|8", 2]]);
  });

  it("marks a listing gone from the source's answer as no longer active", async () => {
    await list("n1", "2003 #19 Salamence PSA 8 EX Dragon", 60);
    await tickSources(ctx, [fakeSource({ salamence: [{ price: usd(80) }, { price: usd(95) }] })]);
    await t.db.update(sourceLookups).set({ lookedAt: new Date(Date.now() - 7 * 3_600_000) });
    await tickSources(ctx, [fakeSource({ salamence: [{ price: usd(82) }] })]);
    const quotes = await t.db.select().from(sourceQuotes).orderBy(sourceQuotes.id);
    expect(quotes.map((q) => [q.id, q.active, q.price])).toEqual([["ebay:salamence-0", true, usd(82)], ["ebay:salamence-1", false, usd(95)]]);
  });

  it("gives up on a card eBay refuses, but retries after a rate limit", async () => {
    await list("n1", "2003 #19 Salamence PSA 8 EX Dragon", 60);
    const refusing = (status: number): CardSource => ({ id: "ebay", quotesFor: async () => { throw new EbayHttpError(status, "https://api.ebay.com/x", ""); } });
    await expect(tickSources(ctx, [refusing(429)])).rejects.toThrow();
    expect(await t.db.select().from(sourceLookups)).toEqual([]);
    await tickSources(ctx, [refusing(400)]);
    expect((await t.db.select().from(sourceLookups)).length).toBe(1);
  });

  it("deletes quotes older than a day", async () => {
    await t.db.insert(sourceQuotes).values([
      { id: "ebay:old", source: "ebay", kind: "ask", title: "x", price: usd(1), seenAt: new Date(Date.now() - 25 * 3_600_000) },
      { id: "ebay:new", source: "ebay", kind: "ask", title: "x", price: usd(1) },
    ]);
    await pruneQuotes(ctx);
    expect((await t.db.select().from(sourceQuotes)).map((q) => q.id)).toEqual(["ebay:new"]);
  });
});

describe("prices elsewhere in the gateway", () => {
  async function seed() {
    await list("cheap-here", "2003 #19 Salamence PSA 8 EX Dragon", 60, { cert: "118624252" });
    await list("dear-here", "2000 #61 Mankey 1st Edition PSA 9 Rocket", 300);
    await list("nowhere", "1999 #4 Charizard PSA 7 Base", 900);
    await t.db.insert(sourceQuotes).values([
      { id: "ebay:a", source: "ebay", kind: "ask", title: "Salamence", url: "https://www.ebay.com/itm/a", price: usd(80), shipping: usd(5), cardKey: "salamence|19|en|PSA|8" },
      { id: "ebay:b", source: "ebay", kind: "ask", title: "Salamence", url: "https://www.ebay.com/itm/b", price: usd(70), shipping: usd(20), cardKey: "salamence|19|en|PSA|8" },
      { id: "ebay:c", source: "ebay", kind: "ask", title: "Mankey", url: "https://www.ebay.com/itm/c", price: usd(250), cardKey: "mankey|61|en|PSA|9" },
      // Gone, or too old to show under eBay's licence.
      { id: "ebay:d", source: "ebay", kind: "ask", title: "Mankey", price: usd(1), cardKey: "mankey|61|en|PSA|9", active: false },
      { id: "ebay:e", source: "ebay", kind: "ask", title: "Mankey", price: usd(2), cardKey: "mankey|61|en|PSA|9", seenAt: new Date(Date.now() - 7 * 3_600_000) },
    ]);
  }

  it("shows each listing's cheapest live ask elsewhere, shipping included", async () => {
    await seed();
    const { rows } = (await app.inject({ url: "/listings?sort=price_asc" })).json() as { rows: Array<{ nft: string; elsewhere: unknown[] }> };
    const by = Object.fromEntries(rows.map((r) => [r.nft, r.elsewhere]));
    expect(by["cheap-here"]).toEqual([{ source: "ebay", match: "card", ask: usd(85), askUrl: "https://www.ebay.com/itm/a", asks: 2, sold: null, soldAt: null, soldUrl: null }]);
    expect(by["dear-here"]).toMatchObject([{ ask: usd(250), asks: 1 }]);
    expect(by.nowhere).toEqual([]);
  });

  it("calls it the same slab when the cert matches", async () => {
    await seed();
    await t.db.insert(sourceQuotes).values({ id: "ebay:slab", source: "ebay", kind: "ask", title: "Salamence", price: usd(99), certKey: "PSA:118624252" });
    const { rows } = (await app.inject({ url: "/listings?search=Salamence" })).json() as { rows: Array<{ elsewhere: Array<{ match: string; asks: number }> }> };
    expect(rows[0]?.elsewhere).toMatchObject([{ match: "cert", asks: 3 }]);
  });

  it("filters and sorts by the gap, and Scanner gets the cards cheaper here", async () => {
    await seed();
    const cheaper = (await app.inject({ url: "/listings?elsewhere=cheaper" })).json() as { rows: Array<{ nft: string }>; total: number };
    expect(cheaper.rows.map((r) => r.nft)).toEqual(["cheap-here"]);
    expect(cheaper.total).toBe(1);
    const gap = (await app.inject({ url: "/listings?sort=gap" })).json() as { rows: Array<{ nft: string }> };
    expect(gap.rows.map((r) => r.nft)).toEqual(["cheap-here", "dear-here", "nowhere"]);
    const pulse = (await app.inject({ url: "/pulse" })).json() as { under: Array<{ nft: string }> };
    expect(pulse.under.map((r) => r.nft)).toEqual(["cheap-here"]);
  });
});
