-- Public profiles: a username unique ignoring case, a short bio, an X handle and a picture.
ALTER TABLE "users" ADD COLUMN "username" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "x_handle" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_idx" ON "users" USING btree (lower("username"));
--> statement-breakpoint
CREATE TABLE "avatars" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id"),
	"content_type" text NOT NULL,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "avatars_user_idx" ON "avatars" USING btree ("user_id");
--> statement-breakpoint
-- Sell to Tenner: where a Pulse card came from.
ALTER TABLE "drops" ADD COLUMN "origin" text DEFAULT 'pack' NOT NULL;
--> statement-breakpoint
CREATE INDEX "drops_origin_state_idx" ON "drops" USING btree ("origin", "state");
