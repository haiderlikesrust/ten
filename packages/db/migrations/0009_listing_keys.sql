-- The same keys on Collector Crypt's own listings, so a listing finds its prices elsewhere with one join.
ALTER TABLE "listings" ADD COLUMN "cert_key" text;
--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "card_key" text;
--> statement-breakpoint
CREATE INDEX "listings_card_key_idx" ON "listings" USING btree ("card_key");
