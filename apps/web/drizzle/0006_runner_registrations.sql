CREATE TABLE "runner_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"trusted" boolean NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"runner_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_registrations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "default_runner_pool" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "runner_registrations" ADD CONSTRAINT "runner_registrations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_registrations" ADD CONSTRAINT "runner_registrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_registrations" ADD CONSTRAINT "runner_registrations_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_registrations_org_id_idx" ON "runner_registrations" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runners_org_id_idx" ON "runners" USING btree ("org_id");