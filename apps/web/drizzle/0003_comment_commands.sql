ALTER TABLE "jobs" ADD COLUMN "github_comment_id" bigint;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "command_answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_github_comment_id_unique" UNIQUE("github_comment_id");