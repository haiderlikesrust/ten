/** The $CARDS token, which creator fees are paid in. */
export const CARDS_MINT = "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp";

export interface TokenMarket {
  priceUsd: number;
  marketCap: number;
  change24h: number | null;
}

interface DexPair {
  baseToken?: { address?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  priceChange?: { h24?: number };
}

/** Takes the deepest pool for this token, since thin pools can show a misleading price. */
export function readTokenMarket(mint: string, pairs: unknown): TokenMarket | null {
  if (!Array.isArray(pairs)) return null;
  const own = (pairs as DexPair[]).filter((pair) => pair.baseToken?.address === mint);
  const best = own.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const marketCap = best?.marketCap ?? best?.fdv;
  const priceUsd = Number(best?.priceUsd);
  if (!best || !marketCap || !Number.isFinite(priceUsd)) return null;
  return { priceUsd, marketCap, change24h: best.priceChange?.h24 ?? null };
}

/** Read-only and public. Returns null when the data is unavailable, and never throws. */
export async function fetchTokenMarket(mint: string, fetcher: typeof fetch = fetch): Promise<TokenMarket | null> {
  try {
    const response = await fetcher(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    return readTokenMarket(mint, await response.json());
  } catch {
    return null;
  }
}
