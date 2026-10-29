CREATE TYPE "public"."provider_kind" AS ENUM('openrouter', 'anthropic', 'openai_compatible', 'ollama');--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "provider_kind" NOT NULL,
	"label" text NOT NULL,
	"base_url" text,
	"key_ciphertext" text,
	"key_last4" text,
	"key_set_at" timestamp with time zone,
	"runner_held" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_ok_at" timestamp with time zone,
	"refused_at" timestamp with time zone,
	"refused_status" smallint,
	"refused_message" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_key_or_runner" CHECK (("providers"."runner_held" and "providers"."key_ciphertext" is null) or (not "providers"."runner_held" and "providers"."key_ciphertext" is not null)),
	CONSTRAINT "providers_last4_with_key" CHECK (("providers"."key_ciphertext" is null) = ("providers"."key_last4" is null)),
	CONSTRAINT "providers_ollama_on_runner" CHECK ("providers"."kind" <> 'ollama' or "providers"."runner_held")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "providers_org_id_idx" ON "providers" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "providers_org_default_idx" ON "providers" USING btree ("org_id") WHERE "providers"."is_default";--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_provider_id_idx" ON "jobs" USING btree ("provider_id");