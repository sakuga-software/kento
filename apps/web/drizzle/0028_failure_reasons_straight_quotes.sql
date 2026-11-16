-- REV-115. The service wrote the label of a provider in French quotation marks in the reason of a
-- failed job. The screens read only straight quotes now. The statement is idempotent.
UPDATE "jobs" SET "failure_reason" = regexp_replace("failure_reason", '^(the provider|the key of the provider) « (.*?) » ', '\1 "\2" ')
WHERE "failure_reason" ~ '^(the provider|the key of the provider) « .*? » ';
