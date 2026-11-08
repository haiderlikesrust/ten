-- The $TENR flywheel (docs/FLYWHEEL.md): gift draws every 30 minutes, long-holder streaks, and buyback and burn.
CREATE TABLE "gift_draws" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_at" timestamp with time zone NOT NULL,
	"grp" text,
	"state" text NOT NULL,
	"prize" bigint,
	"machine_code" text,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entries_hash" text,
	"target_slot" bigint,
	"blockhash" text,
	"seed" text,
	"winner_user_id" uuid,
	"winner_wallet" text,
	"order_id" uuid,
	"reason" text,
	"drawn_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holder_streaks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"held" double precision DEFAULT 0 NOT NULL,
	"above_since" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buybacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage" text DEFAULT 'PENDING' NOT NULL,
	"usdc_in" bigint NOT NULL,
	"tenr_out" double precision,
	"swap_sig" text,
	"burn_sig" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gift_draws" ADD CONSTRAINT "gift_draws_winner_user_id_users_id_fk" FOREIGN KEY ("winner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holder_streaks" ADD CONSTRAINT "holder_streaks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gift_draws_slot_idx" ON "gift_draws" USING btree ("slot_at");--> statement-breakpoint
CREATE INDEX "gift_draws_winner_idx" ON "gift_draws" USING btree ("winner_user_id","drawn_at");
