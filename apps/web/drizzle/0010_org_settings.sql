CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" text NOT NULL,
	"github_installation_id" bigint,
	"event" text NOT NULL,
	"action" text,
	"status" smallint NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "daily_cap_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "monthly_cap_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "cap_alert_pct" smallint DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "trusted_bots" text[] DEFAULT '{sakuga-agent[bot]}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "settings_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "settings_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "settings_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_installation_idx" ON "webhook_deliveries" USING btree ("github_installation_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received_at_idx" ON "webhook_deliveries" USING btree ("received_at");--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_settings_updated_by_users_id_fk" FOREIGN KEY ("settings_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_cap_alert_pct_range" CHECK ("orgs"."cap_alert_pct" between 1 and 100);--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_caps_not_negative" CHECK (coalesce("orgs"."daily_cap_usd", 0) >= 0 and coalesce("orgs"."monthly_cap_usd", 0) >= 0);--> statement-breakpoint
-- REV-13. The level of a repository becomes a key of its config, inherited from the org when absent.
-- A repository that chose a level other than the default of Kentō keeps it as its own choice.
UPDATE "repos" SET "config" = "config" || jsonb_build_object('level', "default_level"::text) WHERE "default_level" <> 'lite' AND NOT ("config" ? 'level');
