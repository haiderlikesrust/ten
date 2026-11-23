-- Prices for the same cards on other platforms (docs/SOURCES.md). Read-only: nothing here can be bought through Tenner.
CREATE TABLE "source_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"image" text,
	"grader" text,
	"grade_num" double precision,
	"cert_key" text,
	"card_key" text,
	"price" bigint NOT NULL,
	"shipping" bigint,
	"at" timestamp with time zone,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX "source_quotes_cert_idx" ON "source_quotes" USING btree ("cert_key");
--> statement-breakpoint
CREATE INDEX "source_quotes_card_idx" ON "source_quotes" USING btree ("card_key","active");
--> statement-breakpoint
CREATE INDEX "source_quotes_seen_idx" ON "source_quotes" USING btree ("source","seen_at");
--> statement-breakpoint
CREATE TABLE "source_lookups" (
	"source" text NOT NULL,
	"card_key" text NOT NULL,
	"looked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "source_lookups_source_card_key_pk" PRIMARY KEY("source","card_key")
);
