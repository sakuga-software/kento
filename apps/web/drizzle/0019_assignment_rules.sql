CREATE TABLE "assignment_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"authors" text[] DEFAULT '{}'::text[] NOT NULL,
	"paths" text[] DEFAULT '{}'::text[] NOT NULL,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"action" text NOT NULL,
	"level" "review_level",
	"mention" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_rules_action" CHECK ("assignment_rules"."action" in ('review', 'command_only')),
	CONSTRAINT "assignment_rules_level" CHECK (("assignment_rules"."action" = 'review') = ("assignment_rules"."level" is not null)),
	CONSTRAINT "assignment_rules_condition" CHECK (cardinality("assignment_rules"."authors") + cardinality("assignment_rules"."paths") + cardinality("assignment_rules"."labels") > 0),
	CONSTRAINT "assignment_rules_counts" CHECK (cardinality("assignment_rules"."authors") <= 20 and cardinality("assignment_rules"."paths") <= 20 and cardinality("assignment_rules"."labels") <= 20),
	CONSTRAINT "assignment_rules_position" CHECK ("assignment_rules"."position" between 0 and 20)
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "level_source" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "assignment_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_rules_repo_position_idx" ON "assignment_rules" USING btree ("repo_id","position");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assignment_rule_id_assignment_rules_id_fk" FOREIGN KEY ("assignment_rule_id") REFERENCES "public"."assignment_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_assignment_rule_id_idx" ON "jobs" USING btree ("assignment_rule_id") WHERE "jobs"."assignment_rule_id" is not null;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_level_source" CHECK ("jobs"."level_source" in ('rule', 'preference', 'repo', 'command', 'retry'));