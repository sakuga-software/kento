ALTER TABLE "feedback_requests" ADD COLUMN "skipped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- REV-107. A pull request that has 3 published reviews and no request at this migration is never
-- asked for feedback: one skipped row for each. A pull request already asked keeps its row.
INSERT INTO "feedback_requests" ("repo_id", "pr_number", "author_login", "skipped")
SELECT "reviews"."repo_id", "reviews"."pr_number", coalesce(max("pull_authors"."login"), ''), true
FROM "reviews"
LEFT JOIN "pull_authors" ON "pull_authors"."repo_id" = "reviews"."repo_id" AND "pull_authors"."pr_number" = "reviews"."pr_number"
WHERE "reviews"."github_review_id" IS NOT NULL
GROUP BY "reviews"."repo_id", "reviews"."pr_number"
HAVING count(*) >= 3
ON CONFLICT ("repo_id", "pr_number") DO NOTHING;