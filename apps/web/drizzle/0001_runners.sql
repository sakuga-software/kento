CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" text,
	"token_hash" text NOT NULL,
	"trusted" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runners_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "base_ref" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "runner_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_runner_id_idx" ON "jobs" USING btree ("runner_id");