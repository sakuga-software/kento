---
"@kento-review/web": patch
---

pr: #62

**Reviews** (KNT-167): a finding that asks to undo the fix of an earlier finding of the same pull
request says so in its thread, names that finding, and does not block or lower the score alone,
unless it is critical.
**Order**: the service first, as always. The runner claims the feature `reverses`, and a finding of
the result can carry `reverses`, the key of that earlier finding.
