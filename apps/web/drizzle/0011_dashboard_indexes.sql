CREATE INDEX "jobs_failed_repo_finished_idx" ON "jobs" USING btree ("repo_id","finished_at") WHERE "jobs"."state" = 'failed';--> statement-breakpoint
CREATE INDEX "resolutions_repo_created_at_idx" ON "resolutions" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE INDEX "reviews_repo_created_at_idx" ON "reviews" USING btree ("repo_id","created_at");