-- Listings from other marketplaces are priced in SOL or other tokens, and were stored as if the
-- number were dollars, so a 0.45 SOL card showed as $0.45. A USDC trading wallet can't buy them,
-- so they leave the market along with the prices and sales recorded from them.
DELETE FROM "price_points" WHERE "nft" IN (SELECT "nft" FROM "listings" WHERE "source" <> 'CC');--> statement-breakpoint
DELETE FROM "sales" WHERE "source" = 'listing_diff' AND "nft" IN (SELECT "nft" FROM "listings" WHERE "source" <> 'CC');--> statement-breakpoint
UPDATE "listings" SET "active" = false WHERE "source" <> 'CC';
