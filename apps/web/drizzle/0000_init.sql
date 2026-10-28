CREATE TYPE "public"."job_kind" AS ENUM('review', 'resolve');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."review_level" AS ENUM('lite', 'balanced', 'heavy');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"kind" "job_kind" DEFAULT 'review' NOT NULL,
	"level" "review_level" NOT NULL,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"github_delivery_id" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_github_delivery_id_unique" UNIQUE("github_delivery_id"),
	CONSTRAINT "jobs_pr_number_positive" CHECK ("jobs"."pr_number" > 0),
	CONSTRAINT "jobs_attempts_not_negative" CHECK ("jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_installation_id" bigint NOT NULL,
	"github_account_id" bigint NOT NULL,
	"login" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_github_installation_id_unique" UNIQUE("github_installation_id")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"default_level" "review_level" DEFAULT 'lite' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_github_repo_id_unique" UNIQUE("github_repo_id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"score" smallint NOT NULL,
	"model" text NOT NULL,
	"cost_usd" numeric(10, 6),
	"result" jsonb NOT NULL,
	"github_review_id" bigint,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_score_range" CHECK ("reviews"."score" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_state_created_at_idx" ON "jobs" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "jobs_repo_pr_idx" ON "jobs" USING btree ("repo_id","pr_number");--> statement-breakpoint
CREATE INDEX "repos_org_id_idx" ON "repos" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_job_id_idx" ON "reviews" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "reviews_repo_pr_idx" ON "reviews" USING btree ("repo_id","pr_number");