CREATE TYPE "public"."finding_event_type" AS ENUM('opened', 'reopened', 'fixed', 'stale', 'dismissed', 'wontfix');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('open', 'fixed', 'stale', 'dismissed', 'wontfix');--> statement-breakpoint
CREATE TABLE "finding_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid NOT NULL,
	"review_id" uuid,
	"type" "finding_event_type" NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"key" text NOT NULL,
	"rule_id" uuid,
	"path" text NOT NULL,
	"line" integer NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"confidence" smallint NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"status_reason" text,
	"first_review_id" uuid,
	"last_review_id" uuid,
	"first_seen_sha" text NOT NULL,
	"last_seen_sha" text NOT NULL,
	"github_comment_id" bigint,
	"github_thread_id" text,
	"reactions_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_pr_number_positive" CHECK ("findings"."pr_number" > 0),
	CONSTRAINT "findings_severity" CHECK ("findings"."severity" in ('critical', 'major', 'minor')),
	CONSTRAINT "findings_confidence_range" CHECK ("findings"."confidence" between 0 and 100),
	CONSTRAINT "findings_reason_with_status" CHECK ("findings"."status_reason" is null or "findings"."status" in ('dismissed', 'wontfix'))
);
--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_first_review_id_reviews_id_fk" FOREIGN KEY ("first_review_id") REFERENCES "public"."reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_last_review_id_reviews_id_fk" FOREIGN KEY ("last_review_id") REFERENCES "public"."reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_events_finding_created_at_idx" ON "finding_events" USING btree ("finding_id","created_at","id");--> statement-breakpoint
CREATE INDEX "finding_events_review_idx" ON "finding_events" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "findings_repo_pr_idx" ON "findings" USING btree ("repo_id","pr_number");--> statement-breakpoint
CREATE INDEX "findings_repo_created_at_idx" ON "findings" USING btree ("repo_id","created_at","id");--> statement-breakpoint
CREATE INDEX "findings_open_comment_idx" ON "findings" USING btree ("reactions_checked_at") WHERE "findings"."status" = 'open' and "findings"."github_comment_id" is not null;--> statement-breakpoint
CREATE INDEX "findings_first_review_idx" ON "findings" USING btree ("first_review_id");--> statement-breakpoint
CREATE INDEX "findings_last_review_idx" ON "findings" USING btree ("last_review_id");