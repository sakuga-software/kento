CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"paths" text[] DEFAULT '{}'::text[] NOT NULL,
	"severity_floor" text,
	"active" boolean DEFAULT true NOT NULL,
	"disabled_by" uuid,
	"disabled_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rules_title_length" CHECK (char_length("rules"."title") between 1 and 200),
	CONSTRAINT "rules_body_length" CHECK (char_length("rules"."body") between 1 and 4000),
	CONSTRAINT "rules_paths_count" CHECK (cardinality("rules"."paths") <= 20),
	CONSTRAINT "rules_severity_floor" CHECK ("rules"."severity_floor" is null or "rules"."severity_floor" in ('critical', 'major', 'minor')),
	CONSTRAINT "rules_disabled_when_inactive" CHECK ("rules"."active" = ("rules"."disabled_at" is null))
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "sent_rules" jsonb;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rules_repo_id_idx" ON "rules" USING btree ("repo_id") WHERE "rules"."repo_id" is not null;--> statement-breakpoint
CREATE INDEX "rules_org_id_idx" ON "rules" USING btree ("org_id") WHERE "rules"."repo_id" is null;