// Prices for the same card on other platforms, next to Collector Crypt's (docs/SOURCES.md). Read-only.
import type { Elsewhere } from "@gemdex/core";
import { listings, sql, type Database } from "@gemdex/db";

/** eBay's licence: a listing shown must be no more than 6 hours older than eBay's own. */
const FRESH = sql.raw(`interval '6 hours'`);

/** The cheapest live ask elsewhere for a listing, shipping included, as a SQL expression for sorting and filtering. */
export const cheapestElsewhere = sql`(
  select min(q.price + coalesce(q.shipping, 0)) from source_quotes q
  where q.active and q.kind = 'ask' and q.seen_at > now() - ${FRESH}
    and (q.card_key = ${listings.cardKey} or q.cert_key = ${listings.certKey})
)`;

interface QuoteRow {
  source: string;
  kind: "ask" | "sold";
  cert_key: string | null;
  card_key: string | null;
  price: number;
  shipping: number | null;
  url: string | null;
  at: Date | null;
}

type Keyed = { certKey: string | null; cardKey: string | null };

/** Adds `elsewhere` to each listing: per source, the cheapest ask (shipping included) and the latest sale. */
export async function withElsewhere<T extends Keyed>(raw: Database["sql"], rows: T[]): Promise<Array<T & { elsewhere: Elsewhere[] }>> {
  const cards = [...new Set(rows.map((r) => r.cardKey).filter((k): k is string => !!k))];
  const certs = [...new Set(rows.map((r) => r.certKey).filter((k): k is string => !!k))];
  if (cards.length === 0 && certs.length === 0) return rows.map((r) => ({ ...r, elsewhere: [] }));
  const quotes = await raw<QuoteRow[]>`
    select source, kind, cert_key, card_key, price::float8 as price, shipping::float8 as shipping, url, at
    from source_quotes
    where active and seen_at > now() - interval '6 hours' and (card_key = any(${cards}::text[]) or cert_key = any(${certs}::text[]))`;
  return rows.map((row) => ({ ...row, elsewhere: summarize(row, quotes) }));
}

export function summarize(row: Keyed, quotes: QuoteRow[]): Elsewhere[] {
  const bySource = new Map<string, Elsewhere>();
  for (const q of quotes) {
    const sameSlab = !!row.certKey && q.cert_key === row.certKey;
    if (!sameSlab && (!row.cardKey || q.card_key !== row.cardKey)) continue;
    const e = bySource.get(q.source) ?? { source: q.source, match: "card", ask: null, askUrl: null, asks: 0, sold: null, soldAt: null, soldUrl: null };
    if (sameSlab) e.match = "cert";
    if (q.kind === "ask") {
      const landed = q.price + (q.shipping ?? 0);
      e.asks++;
      if (e.ask === null || landed < e.ask) {
        e.ask = landed;
        e.askUrl = q.url;
      }
    } else if (q.at && (!e.soldAt || q.at.toISOString() > e.soldAt)) {
      e.sold = q.price;
      e.soldAt = q.at.toISOString();
      e.soldUrl = q.url;
    }
    bySource.set(q.source, e);
  }
  return [...bySource.values()];
}
