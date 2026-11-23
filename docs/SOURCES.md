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

---

# Phase 2 (design only): buy an eBay listing with USDC

> **Status: designed, not built.** Building starts only once the read-only eBay prices work on tenner.trade: `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` set on tenner-worker, real eBay asks showing on Scanner and Market, and the open questions at the end answered. Nothing below exists in code yet.

The flow the user chose:

1. A trader pays USDC on Tenner for an eBay listing.
2. Tenner tops up a **Solcard**, a crypto debit card loaded with USDC on Solana.
3. An admin buys the listing on eBay with that card, shipped to a vault.
4. Once the slab is vaulted and tokenized, the token goes to the trader.

No eBay buying is automated: eBay's Buy Order API needs eBay's approval, so an admin does every eBay step by hand from a queue.

## The quote: full cost, locked

`POST /ebay/quote { itemId }` makes one fresh eBay `getItem` call. That confirms the listing is live, buy-it-now and graded, and gives the current price and shipping to the vault. It then returns a quote with every part shown:

| Line | Where it comes from |
|---|---|
| Item | eBay `getItem` price (USD only) |
| Shipping to the vault | eBay `getItem` shipping to the vault's ZIP code |
| Sales tax | The vault state's rate (setting `ebayBuy.taxBps`), since eBay charges tax at checkout by ship-to address |
| Card / FX fee | `ebayBuy.cardFeeBps` of item + shipping + tax, the Solcard's top-up and spend fee |
| Vault fee | `ebayBuy.vaultFee`, a flat intake and tokenization fee |
| Tenner margin | `ebayBuy.marginBps` of the item |
| **Total** | Everything above, in USDC micros |

- The quote is stored in `ebay_quotes` (user, item, breakdown, total, `expires_at`) and is good for **3 minutes** (`ebayBuy.quoteTtlSec`).
- Ordering after it expires needs a new quote.
- Limits: `ebayBuy.maxOrder` (start at $500), a daily cap, and `ebayBuy.enabled`, which is off by default.
- The $250 rule: eBay's Authenticity Guarantee sends trading cards sold for $250 or more to an authenticator before they ship, which adds days. The quote says so.

`cardCost` = item + shipping + tax + card fee. This is exactly what has to reach the Solcard. The vault fee and margin never leave Tenner.

## Money: escrow first, card second

The user's USDC lives in their trading wallet and is booked as `user:<id>`. Three new book accounts all sit in the **Drops wallet**, next to `gifts` and `buyback_inflight`, and are added to `DROPS_WALLET_ACCOUNTS` so reconciliation still balances. A fourth account, `solcard`, is money on the card, off chain.

| Account | Holds |
|---|---|
| `ebay_escrow` | Paid orders not yet sent to the card |
| `ebay_inflight` | A card top-up signed or sent but not yet confirmed |
| `ebay_reserve` | An admin-funded float that pays refunds once money is already on the card (booked like the Drops float, through Admin → Treasury transfers) |
| `solcard` | Tenner's USDC on the Solcard: topped up and not yet spent. Off chain, so reconcile skips it; Admin shows it so an admin can compare it with the card's own balance. |

Every step below is one `post()` with a ref like `ebay:<orderId>:<step>`, so a retried step never moves money twice. Every chain transfer goes through `sendOnce`, which means the treasury signing path, the kill switch and the mainnet arm (`Paused`) all apply.

| Step | Chain | Book legs |
|---|---|---|
| **Pay** | `usdc` trading wallet → Drops wallet, memo `tenner:ebay:<id>` | `user:<id>` −total, `ebay_escrow` +total |
| **Fund card** (admin presses Start) | `usdc` Drops wallet → `SOLCARD_DEPOSIT_ADDRESS` | First `ebay_escrow` −cardCost, `ebay_inflight` +cardCost; on confirm `ebay_inflight` −cardCost, `solcard` +cardCost |
| **Bought** | none (card spend) | `solcard` −cardCost, `world` +cardCost |
| **Delivered** | `core` vault → trader's trading wallet | `ebay_escrow` −(vault fee + margin), `revenue` +margin, `world` +vault fee (or `ebay_vault_fees` until CC bills it) |
| **Refund before funding** (sold first, admin cancels, quote broken) | `usdc` Drops wallet → trading wallet | `ebay_escrow` −total, `user:<id>` +total |
| **Refund after funding** (eBay buy failed, seller cancelled) | `usdc` Drops wallet → trading wallet | `ebay_escrow` −(total − cardCost), `ebay_reserve` −cardCost, `user:<id>` +total |

**Money left on the card.** After a refund that came after funding, the cardCost stays on the Solcard as float, which can't usually be withdrawn back to crypto. The next order spends that float before topping up again:
- Book legs: `ebay_escrow` −x, `ebay_reserve` +x.
- When that purchase happens: `solcard` −x, `world` +x.
- Nothing moves on chain.

That pays the reserve back. If `ebay_reserve` is too small for a refund after funding, the order waits as **Refund pending**, with an admin alert, instead of borrowing from the Pulse pool.

Before an admin presses Start, the saga re-reads the listing with `getItem`:
- If it has ended, it refunds.
- If the price plus shipping is higher than quoted, it refunds; Tenner never absorbs a rise silently.
- Only the exact cardCost goes to the card, never the whole escrow.

## Order states

Table `ebay_orders`:
- user, quote, item id and URL, breakdown, total, cardCost, state
- eBay order number, carrier and tracking, NFT address, chain signatures, error, timestamps, `next_run_at`/`lease_until`

It is a resumable saga like `orders` and `buybacks`: each tick picks up where the last one stopped.

```
Paid ──Start──► Funding card ──confirmed──► (waiting for the admin's eBay buy)
                    │                               │
                    ▼                               ▼ admin enters eBay order no.
                 Refunded ◄──────────────────── Bought ──admin enters tracking──► Shipped
                    ▲                               │                               │
                    └──── Failed (needs an admin) ◄─┴── vault rejects / lost ◄──────┤
                                                                                    ▼ admin enters NFT address
                                                              Delivered ◄── core transfer ◄── Vaulted
```

- **Paid:** the trader's transfer confirmed, and the money is in `ebay_escrow`.
- **Funding card:** set by Start. The top-up is in flight, then confirmed. The admin then buys on eBay with the card.
- **Bought:** the admin enters the eBay order number. Can't be undone from Tenner; after this point, refunds go through eBay's own process.
- **Shipped:** the admin enters the carrier and tracking number.
- **Vaulted:** the admin enters the NFT address once the vault has tokenized the slab into Tenner's vault wallet. The saga checks on chain that the vault wallet holds that NFT.
- **Delivered:** the `core` transfer to the trader's trading wallet confirmed. A `holdings` row is added, and Portfolio shows the card.
- **Refunded / Failed:** Refunded pays back as in the table above. Failed means something needs a person (a lost parcel, a slab the vault rejected); every Failed order needs an admin's decision to Refund or Retry.

**Admin queue** (`/admin/ebay`): one row per order, with the next action button only. The buttons are Start, Mark bought, Mark shipped, Mark vaulted, Refund and Fail, and each is recorded with who pressed it. Admin also shows the `solcard` and `ebay_reserve` balances.

## Configuration

- **`SOLCARD_DEPOSIT_ADDRESS`** (tenner-worker only, never in the repo): the Solcard's Solana deposit address, which the user will provide.
  - The worker refuses to start eBay orders when it is unset or not a valid address.
  - USDC goes to that address's USDC token account, as with any `usdc` op to `{ kind: "address" }`.
- Settings under `ebayBuy` (Admin): `enabled`, `taxBps`, `cardFeeBps`, `vaultFee`, `marginBps`, `quoteTtlSec`, `maxOrder`, `dailyCap`, and the vault's ship-to ZIP code.
- Paper mode: the Solcard is a paper address, and admins press the same buttons with made-up order numbers, so the whole flow can be tested end to end without money.

## Open questions for the user

1. **Solcard terms:** does it allow commercial or reseller use (buying goods for other people)? What are its per-purchase, daily and monthly spend limits, its top-up and FX fees, and can a balance ever be withdrawn back to USDC? The spend limits cap `ebayBuy.maxOrder`.
2. **The vault:** does Collector Crypt accept slabs shipped straight from third-party eBay sellers to its intake, under Tenner's account? What does intake and tokenization cost, how long does it take, and what happens to a slab whose cert doesn't match the listing? If CC won't accept direct shipments, slabs go to an admin's address first, which needs a new step and changes the risk.
3. **Legal review:** taking crypto from users to buy goods for them on another marketplace may make Tenner a money transmitter, or an agent or reseller with sales-tax duties. It also raises consumer-protection questions: returns, items not as described, and who carries the loss on a parcel lost in transit. Get counsel's advice before this runs with real money, as with gift draws (docs/FLYWHEEL.md).
4. **eBay's rules:** check that buying as a regular eBay buyer on other people's behalf is allowed under eBay's User Agreement. Also check whether showing an "order through Tenner" button next to eBay data fits the API License Agreement.
