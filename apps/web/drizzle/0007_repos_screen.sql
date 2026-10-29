CREATE TYPE "public"."workflow_mode" AS ENUM('none', 'reusable', 'copy');--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "private" boolean;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "default_branch" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "workflow" "workflow_mode";--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "workflow_path" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "workflow_ref" text;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "workflow_checked_at" timestamp with time zone;