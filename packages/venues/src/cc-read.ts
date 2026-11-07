/**
 * Read-only Collector Crypt client. GET only, by construction: there is no method
 * here that can move money, so market data can safely point at mainnet in every mode.
 */
export interface CcEndpoints {
  gachaBase: string;
  apiBase: string;
  metaBase: string;
}

export const CC_MAINNET: CcEndpoints = {
  gachaBase: "https://gacha.collectorcrypt.com",
  apiBase: "https://api.collectorcrypt.com",
  metaBase: "https://nft.collectorcrypt.com",
};

export const CC_DEVNET: CcEndpoints = {
  gachaBase: "https://dev-gacha.collectorcrypt.com",
  apiBase: "https://dev-api.collectorcrypt.com",
  metaBase: "https://nft.collectorcrypt.com",
};

export interface CcMachine {
  code: string;
  name: string;
  shortName?: string | null;
  thumbnailUrl?: string | null;
  imageNobg?: string | null;
  image?: string | null;
  public?: boolean;
  price: number;
  instantBuyback: number;
  turboMode?: boolean;
  odds: Record<string, number>;
  tierRanges: Record<string, { start: number; end: number }>;
  stock: Record<string, number>;
  ev: number | null;
  menuCategory?: string | null;
}

export interface CcStatus {
  machineStatus: string;
  gachas: Array<{ code: string; status: string; isOpen: boolean }>;
}

export interface CcPoolCard {
  nft_address: string;
  name: string;
  rarity: string;
  image?: string | null;
  insured_value: number | string;
  attributes?: Array<{ trait_type: string; value: unknown }>;
}

export interface CcWinner {
  winner: string;
  nft_address: string;
  insuredValue: number | string | null;
  created_at: string;
  memo_slug: string | null;
  pack_type: string;
  prize_tier: number | null;
  nft?: {
    content?: {
      files?: Array<{ uri?: string; cc_cdn?: string; cdn_uri?: string }>;
      links?: { image?: string };
      metadata?: { name?: string; attributes?: Array<{ trait_type: string; value: unknown }> };
    };
  };
}

export interface CcListingRow {
  nftAddress: string;
  itemName: string;
  category?: string | null;
  set?: string | null;
  year?: number | null;
  grade?: string | null;
  gradeNum?: number | null;
  gradingCompany?: string | null;
  gradingID?: string | null;
  insuredValue?: string | number | null;
  frontImage?: string | null;
  vault?: string | null;
  listedAt?: string | null;
  images?: { frontM?: string; frontS?: string } | null;
  offers?: Array<{ id: string }> | null;
  owner?: { id: string; name?: string | null; wallet?: string | null } | null;
  listing?: { price: number; currency?: string; marketplace?: string; createdAt?: string } | null;
}

export interface CcMarketPage {
  filterNFtCard: CcListingRow[];
  nextCursor: string | null;
  total: number;
  findTotal: number;
  cardsQtyByCategory: Record<string, number>;
}

export interface MarketQuery {
  step?: number;
  cursor?: string;
  orderBy?: string;
  search?: string;
  ownerAddress?: string;
  marketplaceSource?: "CC" | "ME";
  listPriceMin?: number;
  listPriceMax?: number;
}

export interface CcCardMarket {
  listing: { price: number; currency?: string; marketplace?: string } | null;
  owner: { wallet?: string | null; name?: string | null } | null;
  status?: string;
  nftStatus?: string;
}

export interface CcReadOptions {
  endpoints?: CcEndpoints;
  apiKey?: string;
  timeoutMs?: number;
}

export class CcHttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly body: string) {
    super(`CC ${status} on ${url}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CcRead {
  readonly endpoints: CcEndpoints;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(opts: CcReadOptions = {}) {
    this.endpoints = opts.endpoints ?? CC_MAINNET;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async get<T>(url: string, attempt = 0): Promise<T> {
    const headers: Record<string, string> = { "User-Agent": "tenner/0.1", Accept: "application/json" };
    if (this.apiKey) {
      if (url.startsWith(this.endpoints.apiBase)) headers.Authorization = `Bearer ${this.apiKey}`;
      else headers["x-api-key"] = this.apiKey;
    }
    const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(this.timeoutMs) });
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      const body = (await res.json().catch(() => ({}))) as { retryAfter?: number };
      await sleep(Math.min(30, body.retryAfter ?? 2 ** attempt) * 1000);
      return this.get<T>(url, attempt + 1);
    }
    if (!res.ok) throw new CcHttpError(res.status, url, (await res.text()).slice(0, 300));
    return (await res.json()) as T;
  }

  async machines(): Promise<CcMachine[]> {
    const body = await this.get<{ machines: CcMachine[] }>(`${this.endpoints.gachaBase}/api/machines`);
    return body.machines ?? [];
  }

  status(): Promise<CcStatus> {
    return this.get<CcStatus>(`${this.endpoints.gachaBase}/api/status`);
  }

  async pool(code: string, rarity: string, limit = 100): Promise<CcPoolCard[]> {
    const q = new URLSearchParams({ code, rarity, limit: String(limit) });
    const body = await this.get<{ nfts: CcPoolCard[] }>(`${this.endpoints.gachaBase}/api/getNfts?${q}`);
    return body.nfts ?? [];
  }

  async winners(count = 50): Promise<CcWinner[]> {
    const body = await this.get<{ data: CcWinner[] }>(`${this.endpoints.gachaBase}/api/getAllWinners?count=${count}`);
    return body.data ?? [];
  }

  marketplace(query: MarketQuery = {}): Promise<CcMarketPage> {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") q.set(key, String(value));
    }
    return this.get<CcMarketPage>(`${this.endpoints.apiBase}/marketplace?${q}`);
  }

  card(id: string): Promise<Record<string, unknown>> {
    return this.get(`${this.endpoints.apiBase}/cards/publicNft/${encodeURIComponent(id)}`);
  }

  cardMarket(id: string): Promise<CcCardMarket> {
    return this.get(`${this.endpoints.apiBase}/cards/publicNft/${encodeURIComponent(id)}/market`);
  }
}
