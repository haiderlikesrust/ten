-- A transfer is recorded once per wallet, not once ever. One recorded under the wrong wallet can then be recorded
-- under the right one, and a transfer between Drops and Cashback can be booked on both sides.
ALTER TABLE "treasury_moves" DROP CONSTRAINT "treasury_moves_signature_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_moves_signature_wallet_idx" ON "treasury_moves" USING btree ("signature","wallet");
