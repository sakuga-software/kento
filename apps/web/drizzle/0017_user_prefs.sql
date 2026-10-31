CREATE TABLE "pull_authors" (
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"github_id" bigint NOT NULL,
	"login" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_authors_repo_id_pr_number_pk" PRIMARY KEY("repo_id","pr_number")
);
--> statement-breakpoint
CREATE TABLE "user_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repo_id" uuid,
	"auto_review" boolean DEFAULT true NOT NULL,
	"level" "review_level",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pull_authors" ADD CONSTRAINT "pull_authors_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD CONSTRAINT "user_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD CONSTRAINT "user_prefs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pull_authors_github_id_idx" ON "pull_authors" USING btree ("github_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_prefs_global_idx" ON "user_prefs" USING btree ("user_id") WHERE "user_prefs"."repo_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_prefs_repo_idx" ON "user_prefs" USING btree ("user_id","repo_id") WHERE "user_prefs"."repo_id" is not null;