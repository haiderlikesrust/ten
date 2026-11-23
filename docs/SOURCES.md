# Card sources beyond Collector Crypt

Every card on Tenner comes from Collector Crypt (CC). Pulls come from CC's pack program, and machines and listings come from CC's API. A community member asked Tenner to also index **eBay**, **TCG Drop**, **PalletTrade** and **InstaSnipe**, so traders can spot price gaps between platforms. This page records what each of those is, what can be read from it and on what terms, and what was built. Researched on 2026-11-23.

## Summary

| Source | What it is | Readable? | Verdict |
|---|---|---|---|
| **eBay** | The marketplace itself | Official Browse API, with an app key | **Built.** Shows live buy-it-now asks. It is turned on by `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`. |
| **TCG Drop** (tcgdrop.com) | A Discord bot that posts underpriced eBay and TCGplayer listings | No API or feed | Not feasible. Its data is eBay's, which we now read directly. |
| **PalletTrade** (pallet.trade) | Apps and a browser extension that send deal alerts across eBay, Whatnot, Mercari and Fanatics | A webhook for approved subscribers only | Not feasible. The terms forbid scraping, storing and redistribution. |
| **InstaSnipe** (instasnipe.com) | Alerts for new eBay listings priced below recent sales | No API | Not feasible. The terms say "do not scrape, mirror or resell the feed". |

None of the three named tools is a crypto or tokenized-card platform. All three are deal-alert tools built on eBay data (PalletTrade also uses TCGplayer), and they sell that alert as their product. The real edge the community is asking for is "CC price vs eBay price for the same slab", and Tenner now shows that directly.

## eBay

- **Access.** The Buy **Browse API** (`https://api.ebay.com/buy/browse/v1/item_summary/search`) with an application token. That token comes from the OAuth client-credentials grant with scope `https://api.ebay.com/oauth/api_scope`, and needs no user sign-in. It needs a production keyset from developer.ebay.com. eBay's Buy API page says production Buy access is "intended for eBay partners", but eBay staff say most Browse calls are open. If the keyset is refused for Browse, apply through the eBay Partner Network.
- **Rate limit.** 5,000 Browse calls a day by default, which can be raised through eBay's "Application Growth Check". Tenner makes one search every 30 seconds, 2,880 a day, plus a token every 2 hours.
- **What search returns.** Title, price and currency, buying options, condition, image, item URL (and an affiliate URL when a partner campaign is sent), shipping cost, and the date it was listed.
- **Grader, grade and cert.** Search results do **not** carry item specifics. "Professional Grader", "Grade" and "Certification Number" only come from `getItem`, at one call per listing. Tenner does not spend the budget on that. It matches on the title, strictly: grader, grade, card number and the card's name word must all appear, and Japanese only matches Japanese. When a seller puts the cert in the title ("Cert #12345678"), Tenner reads it and marks the match as the **same slab**.
- **Sold prices: not available.** The Finding API (`findCompletedItems`) was shut down on 2025-02-05. Its replacement, the Marketplace Insights API, is a limited release that eBay grants case by case. The data model already has `kind = 'sold'` for when that access is granted.
- **Licence terms that shape the build.**
  - A listing shown must be no more than **6 hours** older than eBay's own copy. Tenner looks each card up again after 6 hours and hides any quote it hasn't seen in 6 hours.
  - Quotes are deleted after 24 hours.
  - Every eBay price links to the eBay listing.
  - eBay's pricing and market-trend data (sold history) are restricted APIs.
  - The full current API License Agreement page could not be fetched automatically. Read it once before going live, especially for anything about price comparison: https://developer.ebay.com/join/api-license-agreement
- **eBay Partner Network (optional).** Set `EBAY_CAMPAIGN_ID`. Tenner then sends `X-EBAY-C-ENDUSERCTX: affiliateCampaignId=…` and links to eBay's affiliate URL, so purchases that start on Tenner earn a commission.

## TCG Drop

tcgdrop.com is a free Discord community and bot, funded by Patreon, that posts underpriced eBay and TCGplayer listings (Pokémon, MTG, Lorcana, Lego) within about 10 seconds, using the eBay API. It has no API and no terms page. Other things share the name, none of them crypto: a restock-alert newsletter ("TCG Drop Radar") and a YouTube channel. tcgdrop.io does not resolve. **Not a source:** reading eBay directly gives the same data, first-hand.

## PalletTrade

PalletTrade LLC (Kansas City) makes iOS and Android apps and the "PalletTrade Pro" browser extension ($9.99 a month). They show deal scores and price history across eBay, Whatnot, Mercari and Fanatics, priced against TCGplayer. Approved subscribers get an API/webhook, a stream of fewer than about 100 deal events a day. Its terms (pallet.trade/terms.html) ban scraping and automated access in section 4. Section 6 bans resale, sharing, storing the data in databases and AI training, and says the data is "licensed solely for personal, real-time deal awareness". **Not a source:** showing it inside Tenner would break those terms.

## InstaSnipe

instasnipe.com checks new eBay listings against recent sales of the same item and sends alerts by web, app, email or Discord. It covers trading cards, sports cards, metals, watches and more, and is an eBay Partner Network affiliate. It has no API. Its terms (app.instasnipe.com/terms) say "do not scrape, mirror or resell the feed" and ban forwarding it as a service. **Not a source.**

## Worth a look later

If the goal is arbitrage between tokenized, vaulted slabs (cards Tenner could one day trade, not just compare), the relevant sources are other on-chain vault platforms: Phygitals (Solana), Courtyard (Polygon), Beezie, and Magic Eden's pack listings. Their APIs were not researched here. Cert numbers would make matching against them exact, since each one tokenizes a specific slab.

## How it works

The design is source-neutral: any new platform plugs into the same three pieces.

1. **Matching keys** (`packages/core/src/sources.ts`). Every source and CC agree on two keys:
   - `cert_key` is grader plus cert number (`PSA:58712664`): the very same slab.
   - `card_key` is the card's name word, card number, language, grader and grade (`salamence|19|en|PSA|8`): the same card in the same grade, a fair comp.

   CC listings get both keys when ingested (`normalizeListing`). Listings stored before this change get them at worker start (`backfillListingKeys`).
2. **Sources** (`packages/venues/src/sources.ts`). A `CardSource` has one read-only method, `quotesFor(card)`, which returns normalised `SourceQuote`s in micros. `EbaySource` is the only one so far. `sourcesFromEnv` turns on each source that has keys set.
3. **Storage and jobs.**
   - `source_quotes` holds one row per listing or sale elsewhere. `source_lookups` records when each source last looked at each card.
   - The worker's `tickSources` (every 30 s) asks each source about one card that hasn't been looked up in 6 hours, pricier cards first, and skips cards under $10.
   - Listings gone from a fresh answer are marked inactive. `pruneQuotes` deletes rows after 24 hours.
4. **Display** (`apps/gateway/src/elsewhere.ts`).
   - Each listing from `/listings`, `/pulse` and `/cards/:nft` carries `elsewhere`. For each source that is the cheapest live ask (shipping included), how many asks there are, whether the match is by cert, and the latest sale.
   - `/listings?sort=gap` sorts by the gap and `/listings?elsewhere=cheaper` keeps only cards cheaper on CC.
   - `/pulse` adds `under`: cards cheaper on CC than anywhere else.
   - Scanner has an "Elsewhere" column, an "Under other markets" tab and a "Best gap vs other markets" reading. Market has an "Elsewhere" column, an "Under other markets" sort and an "Other markets: cheaper here" filter.

Nothing here can buy anywhere but Collector Crypt. Prices elsewhere link out to that platform.

**Adding a source:** add it to `SOURCES` in core, write a `CardSource` that returns `SourceQuote`s built with `cardKey`/`certKey`, and add it to `sourcesFromEnv`. Nothing else changes.
