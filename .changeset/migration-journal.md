---
"@kento-review/web": patch
---

pr: #59

**Reviews** (KNT-155): the pack shows the journal of the Drizzle migrations whole and a summary of
each changed snapshot (tables and columns added, removed, changed or renamed), instead of listing
them under « Not reviewed ». For a migration or a backfill, the review asks whether the version in
service runs on the new data, whether every write path still fits, what a rollback leaves, and how
mixed or legacy values map.
