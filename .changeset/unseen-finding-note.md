---
"@kento-review/web": patch
---

pr: #68

**A finding that the reviews no longer see** (KNT-192): when 2 reviews in a row that read the code
no longer find an open finding, and pushes changed its file since, the finding becomes `stale` and
Kentō says in its thread that it no longer sees it and that `resolve` can confirm. The thread stays
open. A stale finding counts neither as fixed nor as a false positive. No migration.
