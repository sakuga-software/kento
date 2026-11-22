---
"@kento-review/web": patch
---

**A rejected finding no longer comes back under a new id, and `resolve` reads the fix in another file**
(KNT-197). Both changes are in the runner.

- A finding that says again what a person rejected, in the same area of the file (40 lines, with 2
  words of the title in common), is left out, also after a push that changed the file away from it.
  A push that changes the code near the rejected line can bring a new fact: the finding then stays,
  and its text names the rejected finding, its cause and the lines that changed.
- `@kento-review resolve` reads the diffs of the other files changed since a thread opened, the
  files that the thread names first, within a budget. A thread whose own file did not change can be
  closed by a fix in one of them.
