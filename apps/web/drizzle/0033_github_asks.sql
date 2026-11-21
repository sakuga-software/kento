-- KNT-173. The questions to GitHub that a person asks through a form of an org, counted in a
-- window, so their limit holds for every process. Only adds a table: the release before runs on it.
CREATE TABLE "github_asks" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "github_asks_org_id_user_id_action_pk" PRIMARY KEY("org_id","user_id","action")
);
--> statement-breakpoint
ALTER TABLE "github_asks" ADD CONSTRAINT "github_asks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_asks" ADD CONSTRAINT "github_asks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;