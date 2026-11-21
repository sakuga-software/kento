---
"@kento-review/web": patch
---

pr: #68

**A finding that the reviews no longer see** (KNT-192): when 2 reviews in a row that read its file
again no longer find an open finding, and pushes changed its file since, the finding becomes `stale`
and Kentō says in its thread that it no longer sees it, that `resolve` can confirm the fix, and that
`reject` dismisses it if it is wrong. A push review that did not read the file again is not a miss.
The thread stays open, and the Findings screen shows the finding under "open" with the badge
"Not seen in the last reviews". A stale finding counts neither as fixed nor as a false positive.

- A fix that `@kento-review resolve` confirms now makes its finding `fixed` (open or stale), so the
  precision counts it.
- `@kento-review reject` now dismisses a `stale` finding, instead of refusing it.

No migration.
