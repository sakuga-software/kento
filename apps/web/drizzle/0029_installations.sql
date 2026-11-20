-- KNT-150. An org of Kentō is no longer one installation of the GitHub App: the installation moves to
-- its own table, and an org can hold several. Each existing org keeps its id (and so its repositories,
-- runners, providers, rules and members) and gets one installation with the same GitHub ids.
CREATE TABLE "installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"github_installation_id" bigint NOT NULL,
	"github_account_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installations_github_installation_id_unique" UNIQUE("github_installation_id"),
	CONSTRAINT "installations_id_org_id_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installations_org_id_idx" ON "installations" USING btree ("org_id");--> statement-breakpoint
INSERT INTO "installations" ("org_id", "github_installation_id", "github_account_id", "account_login", "suspended_at", "created_at")
	SELECT "id", "github_installation_id", "github_account_id", "login", "suspended_at", "created_at" FROM "orgs";--> statement-breakpoint
-- The name is the login. The slug is the login in lowercase; an account that installed the App
-- twice (uninstalled, then installed again) has two orgs: the live one (not suspended, then the
-- oldest) takes the clean slug, and the others take the id of their installation as a suffix.
ALTER TABLE "orgs" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "slug" text;--> statement-breakpoint
UPDATE "orgs" SET "name" = "ranked"."login", "slug" = CASE WHEN "ranked"."rank" = 1 THEN lower("ranked"."login") ELSE lower("ranked"."login") || '-' || "ranked"."github_installation_id" END
	FROM (
		SELECT "id", "login", "github_installation_id",
			row_number() OVER (PARTITION BY lower("login") ORDER BY "suspended_at" IS NOT NULL, "created_at", "github_installation_id") AS "rank"
		FROM "orgs"
	) AS "ranked"
	WHERE "orgs"."id" = "ranked"."id";--> statement-breakpoint
ALTER TABLE "orgs" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_slug_unique" UNIQUE("slug");--> statement-breakpoint
-- Each repository takes the one installation of its org. Deleting an installation that still has
-- repositories is refused: their reviews, findings and jobs are never deleted with it. An installation
-- that moves to another org takes its repositories with it.
ALTER TABLE "repos" ADD COLUMN "installation_id" uuid;--> statement-breakpoint
UPDATE "repos" SET "installation_id" = "installations"."id" FROM "installations" WHERE "installations"."org_id" = "repos"."org_id";--> statement-breakpoint
ALTER TABLE "repos" ALTER COLUMN "installation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_installation_org_fk" FOREIGN KEY ("installation_id","org_id") REFERENCES "public"."installations"("id","org_id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "repos_installation_id_idx" ON "repos" USING btree ("installation_id");--> statement-breakpoint
ALTER TABLE "orgs" DROP CONSTRAINT "orgs_github_installation_id_unique";--> statement-breakpoint
ALTER TABLE "orgs" DROP COLUMN "github_installation_id";--> statement-breakpoint
ALTER TABLE "orgs" DROP COLUMN "github_account_id";--> statement-breakpoint
ALTER TABLE "orgs" DROP COLUMN "login";--> statement-breakpoint
ALTER TABLE "orgs" DROP COLUMN "suspended_at";
