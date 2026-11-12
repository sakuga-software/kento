CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"author_login" text NOT NULL,
	"author_is_bot" boolean NOT NULL,
	"source" text NOT NULL,
	"text" text NOT NULL,
	"url" text,
	"github_comment_id" bigint,
	"github_reaction_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_source" CHECK ("feedback"."source" in ('command', 'quote', 'reaction')),
	CONSTRAINT "feedback_github_id" CHECK (("feedback"."github_comment_id" is null) <> ("feedback"."github_reaction_id" is null))
);
--> statement-breakpoint
CREATE TABLE "feedback_requests" (
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"author_login" text NOT NULL,
	"github_comment_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_requests_repo_id_pr_number_pk" PRIMARY KEY("repo_id","pr_number")
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_github_comment_idx" ON "feedback" USING btree ("github_comment_id") WHERE "feedback"."github_comment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_github_reaction_idx" ON "feedback" USING btree ("github_reaction_id") WHERE "feedback"."github_reaction_id" is not null;--> statement-breakpoint
CREATE INDEX "feedback_repo_created_at_idx" ON "feedback" USING btree ("repo_id","created_at");