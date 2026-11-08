-- USDC an admin moves into or out of the Drops or Cashback wallet by hand, recorded by signature so the books follow.
CREATE TABLE "treasury_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signature" text NOT NULL,
	"wallet" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"amount" bigint,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_moves_signature_unique" UNIQUE("signature")
);
--> statement-breakpoint
ALTER TABLE "treasury_moves" ADD CONSTRAINT "treasury_moves_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
