CREATE TABLE "pull_closures" (
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_closures_repo_id_pr_number_pk" PRIMARY KEY("repo_id","pr_number")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "failure_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "failure_dismissed_by" text;--> statement-breakpoint
ALTER TABLE "pull_closures" ADD CONSTRAINT "pull_closures_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;