import { describe, expect, it } from "vitest";
import { usd } from "@gemdex/core";
import { isUsdcListing, normalizeListing, type CcListingRow } from "../src/index";

const row = (listing: CcListingRow["listing"]): CcListingRow =>
  ({ nftAddress: "nft1", itemName: "2023 #051 Snorlax PSA 9", insuredValue: "50", listing }) as CcListingRow;

describe("listing prices", () => {
  it("reads a USDC price as dollars", () => {
    expect(normalizeListing(row({ price: 48.5, currency: "USDC", marketplace: "CC" }))?.price).toBe(usd(48.5));
  });

  it("drops a listing priced in SOL instead of calling 0.45 SOL $0.45", () => {
    expect(normalizeListing(row({ price: 0.45, currency: "SOL", marketplace: "ME" }))).toBeNull();
    expect(isUsdcListing({ currency: "SOL" })).toBe(false);
  });

  it("treats a listing with no currency as Collector Crypt's own USDC", () => {
    expect(isUsdcListing({})).toBe(true);
    expect(normalizeListing(row({ price: 20 }))?.price).toBe(usd(20));
  });
});
