// The eBay source against a mocked eBay. Nothing here touches a network.
import { describe, expect, it } from "vitest";
import { ccIdentity, usd } from "@gemdex/core";
import { EbayHttpError, EbaySource, ebayQuery, normalizeEbayItem, sourcesFromEnv, type SourceTarget } from "../src/index";

const target = (name: string, grader: string, cert: string | null = null): SourceTarget => ({ name, identity: ccIdentity(name, grader), cert });
const salamence = target("2003 #19 Salamence PSA 8 EX Dragon", "PSA", "118624252");

const item = (over: Record<string, unknown> = {}) => ({
  itemId: "v1|1234|0",
  title: "2003 Pokemon EX Dragon Salamence #19 Holo Rare PSA 8 NM-MT",
  price: { value: "71.00", currency: "USD" },
  image: { imageUrl: "https://i.ebayimg.com/x.jpg" },
  itemWebUrl: "https://www.ebay.com/itm/1234",
  buyingOptions: ["FIXED_PRICE"],
  conditionId: "2750",
  shippingOptions: [{ shippingCost: { value: "5.00", currency: "USD" } }],
  ...over,
});

function mockEbay(items: unknown[], opts: { tokenStatus?: number; searchStatus?: number } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/identity/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "app-token", expires_in: 7200 }), { status: opts.tokenStatus ?? 200 });
    }
    if (url.includes("/buy/browse/v1/item_summary/search")) {
      return new Response(JSON.stringify({ itemSummaries: items }), { status: opts.searchStatus ?? 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("eBay search", () => {
  it("searches graded buy-it-now cards with an application token, fetched once", async () => {
    const { calls, fetchImpl } = mockEbay([item()]);
    const ebay = new EbaySource({ clientId: "id", clientSecret: "secret", fetchImpl });
    await ebay.quotesFor(salamence);
    await ebay.quotesFor(salamence);
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(1);
    const token = calls[0]!;
    expect((token.init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(String(token.init?.body)).toContain("grant_type=client_credentials");
    const search = new URL(calls[1]!.url);
    expect(search.searchParams.get("q")).toBe("salamence 19 PSA 8");
    expect(search.searchParams.get("category_ids")).toBe("183454");
    expect(search.searchParams.get("filter")).toContain("buyingOptions:{FIXED_PRICE}");
    expect(search.searchParams.get("filter")).toContain("conditionIds:{2750}");
    const headers = calls[1]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer app-token");
    expect(headers["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_US");
    expect(headers["X-EBAY-C-ENDUSERCTX"]).toBeUndefined();
    expect(ebay.calls).toBe(3);
  });

  it("sends the partner campaign when there is one, and links through it", async () => {
    const { calls, fetchImpl } = mockEbay([item({ itemAffiliateWebUrl: "https://www.ebay.com/itm/1234?campid=5" })]);
    const ebay = new EbaySource({ clientId: "id", clientSecret: "secret", campaignId: "5", fetchImpl });
    const [quote] = await ebay.quotesFor(salamence);
    expect((calls[1]!.init?.headers as Record<string, string>)["X-EBAY-C-ENDUSERCTX"]).toBe("affiliateCampaignId=5");
    expect(quote?.url).toBe("https://www.ebay.com/itm/1234?campid=5");
  });

  it("normalises a matching listing to Tenner's units", async () => {
    const { fetchImpl } = mockEbay([item()]);
    const [quote] = await new EbaySource({ clientId: "id", clientSecret: "secret", fetchImpl }).quotesFor(salamence);
    expect(quote).toMatchObject({
      id: "ebay:v1|1234|0", source: "ebay", kind: "ask", price: usd(71), shipping: usd(5), grader: "PSA", gradeNum: 8,
      cardKey: "salamence|19|en|PSA|8", certKey: null, url: "https://www.ebay.com/itm/1234",
    });
  });

  it("keeps only the same card in the same grade, priced in dollars, for sale outright", () => {
    expect(normalizeEbayItem(item({ title: "2003 Pokemon EX Dragon Salamence #19 PSA 9 MINT" }), salamence)).toBeNull();
    expect(normalizeEbayItem(item({ price: { value: "90", currency: "GBP" } }), salamence)).toBeNull();
    expect(normalizeEbayItem(item({ buyingOptions: ["AUCTION"] }), salamence)).toBeNull();
    expect(normalizeEbayItem(item({ conditionId: "4000" }), salamence)).toBeNull();
    expect(normalizeEbayItem(item({ price: { value: "0", currency: "USD" } }), salamence)).toBeNull();
  });

  it("marks the very same slab when the title carries its cert", () => {
    const quote = normalizeEbayItem(item({ title: "Salamence EX Dragon PSA 8 Cert #118624252" }), salamence);
    expect(quote?.certKey).toBe("PSA:118624252");
  });

  it("skips a card it cannot search for well, without calling eBay", async () => {
    const { calls, fetchImpl } = mockEbay([]);
    const quotes = await new EbaySource({ clientId: "id", clientSecret: "secret", fetchImpl }).quotesFor(target("2026 #NA One Piece PSA 10 Natsucomi", "PSA"));
    expect(quotes).toEqual([]);
    expect(calls).toEqual([]);
    expect(ebayQuery(target("2025 #064 Shuckle CGC 10 Pristine Mega Symphonia - M1S - Japanese", "CGC"))).toBe("shuckle 64 japanese CGC 10");
  });

  it("reports a refused token without echoing what was sent", async () => {
    const { fetchImpl } = mockEbay([], { tokenStatus: 401 });
    const error = await new EbaySource({ clientId: "id", clientSecret: "secret", fetchImpl }).quotesFor(salamence).catch((e) => e);
    expect(error).toBeInstanceOf(EbayHttpError);
    expect(error.status).toBe(401);
    expect(String(error.message)).not.toContain("secret");
  });
});

describe("sources from the environment", () => {
  it("reads eBay only when both keys are set", () => {
    expect(sourcesFromEnv({})).toEqual([]);
    expect(sourcesFromEnv({ EBAY_CLIENT_ID: "id" })).toEqual([]);
    expect(sourcesFromEnv({ EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "s" }).map((s) => s.id)).toEqual(["ebay"]);
  });
});
