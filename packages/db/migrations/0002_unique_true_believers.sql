CREATE TABLE "drop_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drop_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"max_price" bigint NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "path" jsonb;--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "bought_by" text;--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "sim_buyer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drop_limits" ADD CONSTRAINT "drop_limits_drop_id_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."drops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_limits" ADD CONSTRAINT "drop_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drop_limits_one_idx" ON "drop_limits" USING btree ("drop_id","user_id") WHERE "drop_limits"."state" = 'open';--> statement-breakpoint
CREATE INDEX "drop_limits_open_idx" ON "drop_limits" USING btree ("state","drop_id");
--> statement-breakpoint
DROP TABLE IF EXISTS "market_trades";--> statement-breakpoint
DROP TABLE IF EXISTS "market_positions";--> statement-breakpoint
DROP TABLE IF EXISTS "market_orders";--> statement-breakpoint
DROP TABLE IF EXISTS "markets";
