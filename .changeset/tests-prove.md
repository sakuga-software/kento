---
"@kento-review/web": patch
---

pr: #47

**Reviews** (KNT-156): a changed test shows its whole test in the pack (three lines of context when
its tests pass 40 kB, or when the pack is over its size), and the review asks which change of the
code makes each assertion fail. After a fix of an earlier finding, the review checks the cases next
to the fix.
