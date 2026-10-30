CREATE TABLE "queue_notices" (
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"github_comment_id" bigint,
	"body" text,
	"gone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_notices_repo_id_pr_number_pk" PRIMARY KEY("repo_id","pr_number")
);
--> statement-breakpoint
ALTER TABLE "queue_notices" ADD CONSTRAINT "queue_notices_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;