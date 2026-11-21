-- KNT-150. The invitations of a GitHub account to an org, by an owner or an admin of Kentō, and the
-- audit of the changes of the members. Only adds tables: the release before runs on this schema.
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"github_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"inviter_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_role" CHECK ("invitations"."role" in ('admin', 'member')),
	CONSTRAINT "invitations_status" CHECK ("invitations"."status" in ('pending', 'accepted', 'declined', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "org_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"org_name" text NOT NULL,
	"actor_id" uuid,
	"actor_login" text NOT NULL,
	"action" text NOT NULL,
	"target_login" text,
	"target_github_id" bigint,
	"invitation_id" uuid,
	"role_before" text,
	"role_after" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_audit" ADD CONSTRAINT "org_audit_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_audit" ADD CONSTRAINT "org_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_pending_idx" ON "invitations" USING btree ("org_id","github_id") WHERE "invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "invitations_github_id_idx" ON "invitations" USING btree ("github_id");--> statement-breakpoint
CREATE INDEX "org_audit_org_idx" ON "org_audit" USING btree ("org_id","created_at");