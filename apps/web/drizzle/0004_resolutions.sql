CREATE TABLE "resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"model" text,
	"cost_usd" numeric(10, 6),
	"result" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resolutions_job_id_idx" ON "resolutions" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "resolutions_repo_pr_idx" ON "resolutions" USING btree ("repo_id","pr_number");