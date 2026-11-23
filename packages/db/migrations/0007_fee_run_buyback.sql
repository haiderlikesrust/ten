-- The smart fee split can send part of a fee run to the buyback and burn. Older runs have none.
ALTER TABLE "fee_runs" ADD COLUMN "buyback" bigint;
