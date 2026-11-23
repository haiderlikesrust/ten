// Read-only card sources besides Collector Crypt (docs/SOURCES.md). A source only ever reads: there is no
// method here that can buy, list or move anything, by construction, as with CcRead.
import { cardKey, certKey, normalGrader, titleMatches, usd, type CardIdentity, type Micros } from "@gemdex/core";

/** One price seen on another platform, already normalised to Tenner's units. */
export interface SourceQuote {
  /** `${source}:${the source's own id}`. */
  id: string;
  source: string;
  kind: "ask" | "sold";
  title: string;
  url: string | null;
  image: string | null;
  grader: string | null;
  gradeNum: number | null;
  certKey: string | null;
  cardKey: string | null;
  price: Micros;
  shipping: Micros | null;
  at: Date | null;
}

/** A card Tenner wants comps for. */
export interface SourceTarget {
  name: string;
  identity: CardIdentity;
  cert: string | null;
}

export interface CardSource {
  id: string;
  /** Prices for this card, matched strictly. Empty when the source has none. */
  quotesFor(target: SourceTarget): Promise<SourceQuote[]>;
}

// eBay ----------------------------------------------------------------------

export interface EbayOptions {
  clientId: string;
  clientSecret: string;
  /** EBAY_US unless told otherwise. Prices are kept only when in USD. */
  marketplace?: string;
  /** eBay Partner Network campaign id. Optional: with it, links earn a commission. */
  campaignId?: string;
  apiBase?: string;
  timeoutMs?: number;
  /** Only tests inject this. */
  fetchImpl?: typeof fetch;
}

interface EbayToken { access_token: string; expires_in: number }

interface EbayItemSummary {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  image?: { imageUrl?: string };
  itemWebUrl?: string;
  itemAffiliateWebUrl?: string;
  buyingOptions?: string[];
  conditionId?: string;
  itemCreationDate?: string;
  shippingOptions?: Array<{ shippingCost?: { value: string; currency: string } }>;
}

/** CCG Individual Cards: Pokémon, One Piece and the rest. */
export const EBAY_CARD_CATEGORY = "183454";
/** eBay's "Graded" condition for trading cards. */
export const EBAY_GRADED = "2750";

/** What to type into eBay's search for this card: few words, so a seller's odd title still turns up. */
export function ebayQuery(t: SourceTarget): string | null {
  const id = t.identity;
  if (!id.main || !id.number || !id.grader || id.grade === null) return null;
  return [id.main, id.number, id.japanese ? "japanese" : null, id.grader, String(id.grade)].filter(Boolean).join(" ");
}

/** A cert number some sellers put in the title: "PSA 10 Cert #12345678". */
function titleCert(title: string): string | null {
  return title.match(/\bcert(?:ification)?\s*(?:#|no\.?|number)?\s*:?\s*(\d{7,10})\b/i)?.[1] ?? null;
}

export function normalizeEbayItem(item: EbayItemSummary, want: SourceTarget): SourceQuote | null {
  if (!item.price || item.price.currency !== "USD") return null;
  const price = Number(item.price.value);
  if (!Number.isFinite(price) || price <= 0) return null;
  // Only buy-it-now asks: an auction's current bid is not a price anyone can pay.
  if (item.buyingOptions && !item.buyingOptions.includes("FIXED_PRICE")) return null;
  if (item.conditionId && item.conditionId !== EBAY_GRADED) return null;
  const cert = titleCert(item.title);
  const sameSlab = !!want.cert && !!cert && certKey(want.identity.grader, cert) === certKey(want.identity.grader, want.cert);
  if (!sameSlab && !titleMatches(want.identity, item.title)) return null;
  const ship = item.shippingOptions?.[0]?.shippingCost;
  return {
    id: `ebay:${item.itemId}`,
    source: "ebay",
    kind: "ask",
    title: item.title,
    url: item.itemAffiliateWebUrl ?? item.itemWebUrl ?? null,
    image: item.image?.imageUrl ?? null,
    grader: normalGrader(want.identity.grader),
    gradeNum: want.identity.grade,
    certKey: cert ? certKey(want.identity.grader, cert) : null,
    cardKey: cardKey(want.identity),
    price: usd(price),
    shipping: ship && ship.currency === "USD" && Number.isFinite(Number(ship.value)) ? usd(Number(ship.value)) : null,
    at: item.itemCreationDate ? new Date(item.itemCreationDate) : null,
  };
}

export class EbayHttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly body: string) {
    super(`eBay ${status} on ${url.split("?")[0]}`);
  }
}

/**
 * eBay's Browse API, with an application token (client credentials, no user sign-in). It has active
 * buy-it-now listings only: eBay sells its sold-price history to approved partners alone (docs/SOURCES.md).
 */
export class EbaySource implements CardSource {
  readonly id = "ebay";
  private token: { value: string; until: number } | null = null;
  private readonly apiBase: string;
  private readonly fetcher: typeof fetch;
  /** Calls made, which the worker counts against eBay's daily limit. */
  calls = 0;

  constructor(private readonly opts: EbayOptions) {
    this.apiBase = opts.apiBase ?? "https://api.ebay.com";
    this.fetcher = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const url = `${this.apiBase}/identity/v1/oauth2/token`;
    this.calls++;
    const res = await this.fetcher(url, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }).toString(),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
    // The body of a refused token request can echo what was sent, so only the status is kept.
    if (!res.ok) throw new EbayHttpError(res.status, url, "");
    const body = (await res.json()) as EbayToken;
    // A minute early, so a token never runs out mid-request.
    this.token = { value: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    return body.access_token;
  }

  async search(q: string, limit = 50): Promise<EbayItemSummary[]> {
    const params = new URLSearchParams({
      q,
      category_ids: EBAY_CARD_CATEGORY,
      filter: `buyingOptions:{FIXED_PRICE},conditionIds:{${EBAY_GRADED}},priceCurrency:USD`,
      sort: "price",
      limit: String(limit),
    });
    const url = `${this.apiBase}/buy/browse/v1/item_summary/search?${params}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "X-EBAY-C-MARKETPLACE-ID": this.opts.marketplace ?? "EBAY_US",
      Accept: "application/json",
    };
    if (this.opts.campaignId) headers["X-EBAY-C-ENDUSERCTX"] = `affiliateCampaignId=${this.opts.campaignId}`;
    this.calls++;
    const res = await this.fetcher(url, { headers, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
    if (res.status === 401) this.token = null;
    if (!res.ok) throw new EbayHttpError(res.status, url, (await res.text()).slice(0, 300));
    const body = (await res.json()) as { itemSummaries?: EbayItemSummary[] };
    return body.itemSummaries ?? [];
  }

  async quotesFor(target: SourceTarget): Promise<SourceQuote[]> {
    const q = ebayQuery(target);
    if (!q) return [];
    const items = await this.search(q);
    return items.map((item) => normalizeEbayItem(item, target)).filter((x): x is SourceQuote => x !== null);
  }
}

/** The sources this deployment has keys for. None is fine: the app runs on Collector Crypt alone. */
export function sourcesFromEnv(env: Record<string, string | undefined>): CardSource[] {
  const sources: CardSource[] = [];
  if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
    sources.push(new EbaySource({ clientId: env.EBAY_CLIENT_ID, clientSecret: env.EBAY_CLIENT_SECRET, campaignId: env.EBAY_CAMPAIGN_ID || undefined, marketplace: env.EBAY_MARKETPLACE || undefined }));
  }
  return sources;
}
