CREATE TABLE "activity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"delta" bigint DEFAULT 0 NOT NULL,
	"ref" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_fires" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"nft" text NOT NULL,
	"price" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"category" text,
	"grader" text,
	"min_grade" double precision,
	"max_price" bigint NOT NULL,
	"min_discount_pct" integer DEFAULT 0 NOT NULL,
	"search" text,
	"daily_budget" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balances" (
	"account" text PRIMARY KEY NOT NULL,
	"micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "no_negative_balance" CHECK ("balances"."account" in ('cc','world') or "balances"."micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cashback_accruals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"memo" text NOT NULL,
	"machine_code" text NOT NULL,
	"pack_price" bigint NOT NULL,
	"rate_bps" integer NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'accrued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "cashback_accruals_memo_unique" UNIQUE("memo")
);
--> statement-breakpoint
CREATE TABLE "cc_packs" (
	"memo" text PRIMARY KEY NOT NULL,
	"drop_id" uuid,
	"user_id" uuid,
	"machine_code" text NOT NULL,
	"price" bigint NOT NULL,
	"deliver_to" text NOT NULL,
	"turbo" boolean DEFAULT false NOT NULL,
	"raw" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"nft" text,
	"rarity" text,
	"insured_value" bigint,
	"roll" bigint,
	"buyback_amount" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chain_tx" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"ref" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"signature" text NOT NULL,
	"raw" text NOT NULL,
	"status" text DEFAULT 'signed' NOT NULL,
	"deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drop_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"deliver_to" text NOT NULL,
	"price" bigint NOT NULL,
	"hold_id" uuid NOT NULL,
	"state" text DEFAULT 'won' NOT NULL,
	"settle_by" timestamp with time zone NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" serial NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"machine_code" text NOT NULL,
	"pack_price" bigint NOT NULL,
	"price" bigint,
	"common_floor" bigint NOT NULL,
	"insured_value" bigint,
	"nft" text,
	"rarity" text,
	"card" jsonb,
	"memo" text,
	"sold_back_for" bigint,
	"relists" integer DEFAULT 0 NOT NULL,
	"pack_pay_attempts" integer DEFAULT 0 NOT NULL,
	"opens_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"buyback_deadline" timestamp with time zone,
	"winner_claim_id" uuid,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage" text DEFAULT 'PENDING' NOT NULL,
	"cards_in" double precision,
	"usdc_out" bigint,
	"cashback" bigint,
	"drops" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holder_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"balance" double precision NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"nft" text NOT NULL,
	"wallet" text NOT NULL,
	"card" jsonb NOT NULL,
	"source" text NOT NULL,
	"cost" bigint NOT NULL,
	"insured_value" bigint,
	"buyback_until" timestamp with time zone,
	"buyback_amount" bigint,
	"status" text DEFAULT 'held' NOT NULL,
	"list_price" bigint,
	"exit_price" bigint,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"ref" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_batches" (
	"ref" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"account" text NOT NULL,
	"delta" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"nft" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"set" text,
	"year" integer,
	"grader" text,
	"grade" text,
	"grade_num" double precision,
	"cert" text,
	"image" text,
	"insured_value" bigint,
	"price" bigint NOT NULL,
	"source" text NOT NULL,
	"seller" text,
	"seller_name" text,
	"offers" integer DEFAULT 0 NOT NULL,
	"vault" text,
	"listed_at" timestamp with time zone,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"image" text,
	"price" bigint NOT NULL,
	"buyback_pct" integer NOT NULL,
	"ev" bigint,
	"odds" jsonb NOT NULL,
	"tiers" jsonb NOT NULL,
	"stock" jsonb NOT NULL,
	"turbo" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"is_open" boolean DEFAULT true NOT NULL,
	"menu_category" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"step" text DEFAULT 'start' NOT NULL,
	"hold_id" uuid,
	"memo" text,
	"result" jsonb,
	"error" text,
	"idempotency_key" text NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_chain" (
	"account" text PRIMARY KEY NOT NULL,
	"micros" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_tx" (
	"signature" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"op" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_cards" (
	"nft" text PRIMARY KEY NOT NULL,
	"machine_code" text NOT NULL,
	"rarity" text NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"insured_value" bigint NOT NULL,
	"grader" text,
	"grade" text,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "price_points" (
	"nft" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ask" bigint,
	"insured_value" bigint,
	CONSTRAINT "price_points_nft_at_pk" PRIMARY KEY("nft","at")
);
--> statement-breakpoint
CREATE TABLE "pulls" (
	"id" text PRIMARY KEY NOT NULL,
	"nft" text NOT NULL,
	"winner" text NOT NULL,
	"pack_type" text NOT NULL,
	"source" text,
	"name" text NOT NULL,
	"image" text,
	"grader" text,
	"grade" text,
	"rarity" text,
	"insured_value" bigint,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconcile_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ok" boolean NOT NULL,
	"mismatches" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"nft" text NOT NULL,
	"name" text NOT NULL,
	"price" bigint NOT NULL,
	"insured_value" bigint,
	"seller" text,
	"buyer" text,
	"source" text NOT NULL,
	"sold_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_wallets" (
	"user_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_wallets_user_id_wallet_pk" PRIMARY KEY("user_id","wallet")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_did" text,
	"handle" text NOT NULL,
	"trading_wallet" text NOT NULL,
	"connected_wallet" text NOT NULL,
	"holder_wallet" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"strikes" integer DEFAULT 0 NOT NULL,
	"last_win_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_privy_did_unique" UNIQUE("privy_did"),
	CONSTRAINT "users_trading_wallet_unique" UNIQUE("trading_wallet"),
	CONSTRAINT "users_holder_wallet_unique" UNIQUE("holder_wallet")
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"user_id" uuid NOT NULL,
	"nft" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_user_id_nft_pk" PRIMARY KEY("user_id","nft")
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_fires" ADD CONSTRAINT "auto_fires_rule_id_auto_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."auto_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_rules" ADD CONSTRAINT "auto_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashback_accruals" ADD CONSTRAINT "cashback_accruals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_drop_id_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."drops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."holds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_ref_ledger_batches_ref_fk" FOREIGN KEY ("ref") REFERENCES "public"."ledger_batches"("ref") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_wallets" ADD CONSTRAINT "tracked_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_user_idx" ON "activity" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "auto_fire_once_idx" ON "auto_fires" USING btree ("rule_id","nft");--> statement-breakpoint
CREATE INDEX "cashback_user_idx" ON "cashback_accruals" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "cc_packs_user_idx" ON "cc_packs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_tx_attempt_idx" ON "chain_tx" USING btree ("purpose","ref","attempt");--> statement-breakpoint
CREATE INDEX "chain_tx_open_idx" ON "chain_tx" USING btree ("status") WHERE "chain_tx"."status" in ('signed','sent');--> statement-breakpoint
CREATE UNIQUE INDEX "claims_idem_idx" ON "claims" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "claims_one_active_idx" ON "claims" USING btree ("user_id") WHERE "claims"."state" = 'won';--> statement-breakpoint
CREATE INDEX "claims_drop_idx" ON "claims" USING btree ("drop_id");--> statement-breakpoint
CREATE INDEX "drops_state_idx" ON "drops" USING btree ("state","next_run_at");--> statement-breakpoint
CREATE INDEX "drops_live_idx" ON "drops" USING btree ("expires_at") WHERE "drops"."state" = 'LIVE';--> statement-breakpoint
CREATE INDEX "holder_wallet_idx" ON "holder_snapshots" USING btree ("wallet","taken_at");--> statement-breakpoint
CREATE INDEX "holdings_user_idx" ON "holdings" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "holds_active_idx" ON "holds" USING btree ("user_id") WHERE "holds"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ledger_account_idx" ON "ledger_entries" USING btree ("account","id");--> statement-breakpoint
CREATE INDEX "ledger_ref_idx" ON "ledger_entries" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "listings_active_idx" ON "listings" USING btree ("active","listed_at");--> statement-breakpoint
CREATE INDEX "listings_price_idx" ON "listings" USING btree ("active","price");--> statement-breakpoint
CREATE INDEX "listings_seller_idx" ON "listings" USING btree ("seller");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idem_idx" ON "orders" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_due_idx" ON "orders" USING btree ("state","next_run_at");--> statement-breakpoint
CREATE INDEX "pool_pick_idx" ON "pool_cards" USING btree ("machine_code","rarity","used_at");--> statement-breakpoint
CREATE INDEX "pulls_time_idx" ON "pulls" USING btree ("at");--> statement-breakpoint
CREATE INDEX "pulls_winner_idx" ON "pulls" USING btree ("winner","at");--> statement-breakpoint
CREATE INDEX "sales_nft_idx" ON "sales" USING btree ("nft","sold_at");--> statement-breakpoint
CREATE INDEX "sales_time_idx" ON "sales" USING btree ("sold_at");