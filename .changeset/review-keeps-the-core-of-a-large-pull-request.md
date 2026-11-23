---
"@kento-review/web": patch
---

pr: #46

**Reviews** (KNT-166): when a large pull request does not fit in a review, the generated files and
the docs go first, then the files of logic keep their hunks with three lines of context, and the
schema, the migrations and the stores go last. The summary lists the files that the review did not
read, and when one holds logic, the risk starts with « Partial review » and the score is at most 4,
or 3 for a schema, a migration or a store.
