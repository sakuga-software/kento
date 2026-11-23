---
"@kento-review/web": patch
---

**Reviews** (KNT-201): a review whose model costs more above a number of prompt tokens (Claude
Haiku 5.5 at `lite`: 5 times more above 100,000 tokens) keeps its whole call under that number. On
a large pull request, the pack cuts the same files in the same order as before, earlier. The other
levels and models keep the pack that they had.
