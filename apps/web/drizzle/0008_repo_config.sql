ALTER TABLE "jobs" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "config_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "config_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "config_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_config_updated_by_users_id_fk" FOREIGN KEY ("config_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;