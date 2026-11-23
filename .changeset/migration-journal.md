---
"@kento-review/web": patch
---

pr: #59

**Reviews** (KNT-155): the pack shows the changes of the journal of the Drizzle migrations (an entry
added, removed, renamed, or whose `when` goes back) and a summary of each changed snapshot (the
snapshot it follows, tables and columns added, removed, changed or renamed), each with its line in
the file, instead of listing them under « Not reviewed ». A journal or a snapshot that is removed or
not valid JSON says so. For a migration or a backfill, the review asks whether the version in
service runs on the new data, whether every write path still fits, what a rollback leaves, and how
mixed or legacy values map.
