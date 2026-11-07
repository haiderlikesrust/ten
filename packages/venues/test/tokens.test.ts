import { describe, expect, it } from "vitest";
import { fetchTokenMarket, readTokenMarket } from "../src/tokens";

const MINT = "TokenMint111";
const pair = (over: object) => ({ baseToken: { address: MINT }, priceUsd: "0.5", marketCap: 1000, liquidity: { usd: 10 }, priceChange: { h24: 2 }, ...over });

describe("token market data", () => {
  it("uses the deepest pool", () => {
    const market = readTokenMarket(MINT, [pair({ marketCap: 1, liquidity: { usd: 5 } }), pair({ marketCap: 9000, liquidity: { usd: 500 } })]);
    expect(market?.marketCap).toBe(9000);
    expect(market?.change24h).toBe(2);
  });

  it("ignores pools where this token is only the quote side", () => {
    expect(readTokenMarket(MINT, [pair({ baseToken: { address: "Other" } })])).toBeNull();
  });

  it("falls back to fully diluted value when market cap is missing", () => {
    expect(readTokenMarket(MINT, [pair({ marketCap: undefined, fdv: 4200 })])?.marketCap).toBe(4200);
  });

  it("treats bad data as no data", () => {
    expect(readTokenMarket(MINT, { error: "nope" })).toBeNull();
    expect(readTokenMarket(MINT, [])).toBeNull();
  });

  it("never throws when the service is down", async () => {
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await fetchTokenMarket(MINT, down)).toBeNull();
  });
});
