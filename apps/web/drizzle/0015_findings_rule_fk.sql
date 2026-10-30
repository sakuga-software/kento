-- REV-55. A finding that cites a rule that no longer exists (removed before this constraint) keeps its
-- row and loses the reference, as ON DELETE SET NULL does from now on.
UPDATE "findings" SET "rule_id" = NULL WHERE "rule_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "rules" WHERE "rules"."id" = "findings"."rule_id");--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "findings_rule_idx" ON "findings" USING btree ("rule_id") WHERE "findings"."rule_id" is not null;