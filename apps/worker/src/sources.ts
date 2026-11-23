// Prices for Collector Crypt's cards on other platforms (docs/SOURCES.md). Read-only: these jobs only look.
import { cardKey, ccIdentity, certKey } from "@gemdex/core";
import { EbayHttpError, type CardSource, type SourceQuote } from "@gemdex/venues";
import type { Ctx } from "./ctx";

/** eBay's licence: a listing shown must be no more than 6 hours older than eBay's own. */
export const QUOTE_FRESH_HOURS = 6;

/** Listings stored before cards had matching keys get them here. Runs once at start. */
export async function backfillListingKeys(ctx: Ctx, limit = 5_000): Promise<number> {
  const rows = await ctx.sql<{ nft: string; name: string; grader: string | null; grade_num: number | null; cert: string | null }[]>`
    select nft, name, grader, grade_num, cert from listings where active = true and card_key is null and cert_key is null limit ${limit}`;
  let filled = 0;
  for (const row of rows) {
    const keys = { cert: certKey(row.grader, row.cert), card: cardKey(ccIdentity(row.name, row.grader, row.grade_num)) };
    if (!keys.cert && !keys.card) continue;
    await ctx.sql`update listings set cert_key = ${keys.cert}, card_key = ${keys.card} where nft = ${row.nft}`;
    filled++;
  }
  return filled;
}

async function saveQuotes(ctx: Ctx, quotes: SourceQuote[]) {
  const now = new Date().toISOString();
  for (const q of quotes) {
    await ctx.sql`
      insert into source_quotes (id, source, kind, title, url, image, grader, grade_num, cert_key, card_key, price, shipping, at, seen_at, active)
      values (${q.id}, ${q.source}, ${q.kind}, ${q.title}, ${q.url}, ${q.image}, ${q.grader}, ${q.gradeNum}, ${q.certKey}, ${q.cardKey}, ${q.price}, ${q.shipping}, ${q.at?.toISOString() ?? null}, ${now}, true)
      on conflict (id) do update set
        title = excluded.title, url = excluded.url, image = excluded.image, price = excluded.price, shipping = excluded.shipping,
        cert_key = coalesce(excluded.cert_key, source_quotes.cert_key), card_key = excluded.card_key, seen_at = excluded.seen_at, active = true`;
  }
}

/**
 * Asks each source about the cards it has looked at least recently, `perSource` at a time. The worker's interval
 * is the rate limit: one eBay search every 30 seconds is 2,880 a day, inside the 5,000 eBay allows. Pricier cards go
 * first, since that is where a gap is worth the shipping.
 */
export async function tickSources(ctx: Ctx, sources: CardSource[], perSource = 1): Promise<number> {
  let saved = 0;
  for (const source of sources) {
    const targets = await ctx.sql<{ card_key: string; name: string; grader: string | null; grade_num: number | null; cert: string | null }[]>`
      select c.card_key, c.name, c.grader, c.grade_num, c.cert
      from (
        select distinct on (card_key) card_key, name, grader, grade_num, cert, price
        from listings where active = true and card_key is not null and price >= 10000000
        order by card_key, price desc
      ) c
      left join source_lookups l on l.source = ${source.id} and l.card_key = c.card_key
      where l.looked_at is null or l.looked_at < now() - make_interval(hours => ${QUOTE_FRESH_HOURS})
      order by l.looked_at is not null, c.price desc
      limit ${perSource}`;
    for (const t of targets) {
      let quotes: SourceQuote[] = [];
      try {
        quotes = await source.quotesFor({ name: t.name, identity: ccIdentity(t.name, t.grader, t.grade_num), cert: t.cert });
      } catch (error) {
        // A query eBay refuses would be refused again, so it is marked looked-at. Rate limits and outages are retried.
        const permanent = error instanceof EbayHttpError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429;
        if (!permanent) throw error;
        ctx.log(`${source.id} refused a lookup`, error.message);
      }
      await saveQuotes(ctx, quotes);
      // Listings from the last look that are gone now have sold or ended.
      const ids = quotes.map((q) => q.id);
      await ctx.sql`
        update source_quotes set active = false
        where source = ${source.id} and card_key = ${t.card_key} and active = true and kind = 'ask' and not (id = any(${ids}::text[]))`;
      await ctx.sql`
        insert into source_lookups (source, card_key, looked_at, found) values (${source.id}, ${t.card_key}, now(), ${quotes.length})
        on conflict (source, card_key) do update set looked_at = excluded.looked_at, found = excluded.found`;
      saved += quotes.length;
    }
  }
  return saved;
}

/** eBay's licence caps how long its listings may be kept, so old ones are deleted, not just hidden. */
export async function pruneQuotes(ctx: Ctx): Promise<void> {
  await ctx.sql`delete from source_quotes where seen_at < now() - interval '24 hours'`;
}
