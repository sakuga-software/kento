---
"@kento-review/web": patch
---

pr: #42

**Thread commands** (KNT-160): `reject #<id> <cause>` works in the thread of that finding (another
id is refused, and an unknown id gets « no finding has this id »); `resolve` in a thread gets an
answer at once that it goes in the conversation; a reject resolves the thread even when the ledger
does not know its id yet. A finding not found again is now `fixed` only when a push changed a line
within 10 lines of it (or its file, when GitHub gives no patch); a change elsewhere in the file
leaves it open. No migration.
