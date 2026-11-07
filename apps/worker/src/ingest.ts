import { matchesRule, type AutoRule } from "@gemdex/core";
import {
  activeRulesQuery, autoFires, emit, eq, listings, machines, placeOrder, poolCards, pricePoints, pulls, sales, sql,
} from "./ingest-db";
import { isUsdcListing, normalizeListing, normalizeMachine, normalizePoolCard, normalizeWinner, type NormalListing } from "@gemdex/venues";
import type { Ctx } from "./ctx";

export async function ingestMachines(ctx: Ctx): Promise<void> {
  const [rows, status] = await Promise.all([ctx.cc.machines(), ctx.cc.status().catch(() => null)]);
  for (const row of rows) {
    const m = normalizeMachine(row, status);
    await ctx.db
      .insert(machines)
      .values({ ...m, updatedAt: new Date() })
      .onConflictDoUpdate({ target: machines.code, set: { ...m, updatedAt: new Date() } });
  }
}

export async function ingestPulls(ctx: Ctx): Promise<void> {
  const rows = await ctx.cc.winners(60);
  for (const row of rows.reverse()) {
    const pull = normalizeWinner(row);
    if (!pull) continue;
    const inserted = await ctx.db.insert(pulls).values(pull).onConflictDoNothing().returning({ id: pulls.id });
    if (inserted.length > 0) await emit(ctx.db, "pulls", { type: "pull", pull });
  }
}

async function upsertListing(ctx: Ctx, l: NormalListing): Promise<boolean> {
  // Raw queries take ISO strings: Drizzle disables the client date serializer on this connection.
  const now = new Date().toISOString();
  const listedAt = l.listedAt?.toISOString() ?? null;
  const result = await ctx.sql<{ inserted: boolean; price_changed: boolean }[]>`
    insert into listings (nft, name, category, "set", year, grader, grade, grade_num, cert, image, insured_value, price, source, seller, seller_name, offers, vault, listed_at, first_seen, last_seen, active)
    values (${l.nft}, ${l.name}, ${l.category}, ${l.set}, ${l.year}, ${l.grader}, ${l.grade}, ${l.gradeNum}, ${l.cert}, ${l.image}, ${l.insuredValue}, ${l.price}, ${l.source}, ${l.seller}, ${l.sellerName}, ${l.offers}, ${l.vault}, ${listedAt}, ${now}, ${now}, true)
    on conflict (nft) do update set
      price = excluded.price, insured_value = excluded.insured_value, source = excluded.source, seller = excluded.seller,
      seller_name = excluded.seller_name, image = excluded.image, offers = excluded.offers, listed_at = excluded.listed_at, last_seen = excluded.last_seen, active = true
    returning (xmax = 0) as inserted, false as price_changed`;
  return !!result[0]?.inserted;
}

/** One page of newest listings. New rows go out live and are checked against auto-buy rules. */
export async function ingestListings(ctx: Ctx, opts: { pages?: number; announce?: boolean } = {}): Promise<number> {
  let cursor: string | undefined;
  let added = 0;
  const fresh: NormalListing[] = [];
  for (let page = 0; page < (opts.pages ?? 1); page++) {
    const body = await ctx.cc.marketplace({ step: 200, orderBy: "listedDateDesc", cursor });
    for (const row of body.filterNFtCard) {
      const listing = normalizeListing(row);
      if (!listing) continue;
      if (await upsertListing(ctx, listing)) {
        added++;
        fresh.push(listing);
      }
    }
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  if (opts.announce !== false) {
    for (const listing of fresh) await emit(ctx.db, "listings", { type: "listing", listing });
    await evaluateRules(ctx, fresh);
  }
  return added;
}

/** Listings that vanished from the feed were either sold or delisted. CC gives no sales feed, so we check. */
export async function detectSales(ctx: Ctx, limit = 8): Promise<number> {
  const stale = await ctx.db
    .select()
    .from(listings)
    .where(sql`${listings.active} = true and ${listings.lastSeen} < now() - interval '3 minutes'`)
    .orderBy(sql`${listings.lastSeen} desc`)
    .limit(limit);
  let found = 0;
  for (const row of stale) {
    const market = await ctx.cc.cardMarket(row.nft).catch(() => null);
    if (!market) continue;
    // Moved to a marketplace that prices in SOL: no longer buyable here, and not a sale.
    if (market.listing && !isUsdcListing(market.listing)) {
      await ctx.db.update(listings).set({ active: false }).where(eq(listings.nft, row.nft));
      continue;
    }
    if (market.listing) {
      await ctx.db.update(listings).set({ lastSeen: new Date(), price: Math.round(market.listing.price * 1e6) }).where(eq(listings.nft, row.nft));
      continue;
    }
    await ctx.db.update(listings).set({ active: false }).where(eq(listings.nft, row.nft));
    const buyer = market.owner?.wallet ?? null;
    if (buyer && buyer !== row.seller) {
      await ctx.db.insert(sales).values({ nft: row.nft, name: row.name, price: row.price, insuredValue: row.insuredValue, seller: row.seller, buyer, source: "listing_diff" });
      await emit(ctx.db, "listings", { type: "sold", nft: row.nft, price: row.price });
      found++;
    }
  }
  return found;
}

/** Hourly price snapshot of watched-size sample, the base for card charts. */
export async function recordPricePoints(ctx: Ctx): Promise<void> {
  await ctx.sql`
    insert into price_points (nft, at, ask, insured_value)
    select nft, date_trunc('hour', now()), price, insured_value from listings where active = true
    on conflict do nothing`;
}

/** Real cards for each machine, so paper pulls show real names, photos and values. */
export async function ingestPool(ctx: Ctx, codes: string[]): Promise<void> {
  for (const code of codes) {
    for (const rarity of ["common", "uncommon", "rare", "epic"]) {
      const rows = await ctx.cc.pool(code, rarity, 100).catch(() => []);
      for (const row of rows) {
        const card = normalizePoolCard(row, code);
        if (!card) continue;
        await ctx.db.insert(poolCards).values({ ...card, rarity }).onConflictDoNothing();
      }
    }
  }
}

async function evaluateRules(ctx: Ctx, fresh: NormalListing[]): Promise<void> {
  if (fresh.length === 0) return;
  const rules = await activeRulesQuery(ctx.db);
  for (const { rule, spent } of rules) {
    const asRule: AutoRule = { ...rule, enabled: rule.enabled, minGrade: rule.minGrade };
    for (const listing of fresh) {
      if (!matchesRule(asRule, listing, spent)) continue;
      const fired = await ctx.db.insert(autoFires).values({ ruleId: rule.id, nft: listing.nft, price: listing.price }).onConflictDoNothing().returning({ id: autoFires.id });
      if (fired.length === 0) continue;
      await ctx.db.transaction((tx) =>
        placeOrder(tx, { userId: rule.userId, kind: "market_buy", params: { nft: listing.nft, price: listing.price, rule: rule.id }, holdAmount: listing.price, idempotencyKey: `auto:${rule.id}:${listing.nft}` }),
      );
      await emit(ctx.db, `user:${rule.userId}`, { type: "autoFire", rule: rule.name, nft: listing.nft, name: listing.name, price: listing.price });
      break;
    }
  }
}
