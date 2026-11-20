-- KNT-150. The members of an org become the `member` of the organization plugin of Better Auth, with
-- the roles owner, admin and member. Every admin of today (an owner of the GitHub organization, or
-- the owner of a personal account) becomes an owner: nobody loses a right, and each org keeps
-- someone who can manage it. Every membership of today came from GitHub.
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_user_id_org_id_pk";--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
UPDATE "memberships" SET "role" = 'owner' WHERE "role" = 'admin';--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "source" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "logo" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "metadata" text;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_org_idx" ON "memberships" USING btree ("user_id","org_id");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role" CHECK ("memberships"."role" in ('owner', 'admin', 'member'));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_source" CHECK ("memberships"."source" in ('github', 'invitation'));--> statement-breakpoint
DROP TYPE "public"."org_role";
