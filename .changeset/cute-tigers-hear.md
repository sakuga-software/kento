---
"@kento-review/web": patch
---

Reviews read a shorter system prompt. The rules of the sections that only a later review holds (answered threads, rejected and earlier findings, the zones changed since the last review) go at the end of the message, only when the pack holds them. A defect that depends on a caller or a definition that the review does not see is no longer a finding: the review names it in its summary or in the reason of a deeper review. A finding that breaks code of the Context section sits on the changed line that causes it, so it gets a thread. The review asks for tests only when CLAUDE.md or AGENTS.md asks for them (KNT-110).
