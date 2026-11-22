---
"@kento-review/web": patch
---

**Screens**: `/repos` and the dashboard (KNT-183, KNT-187): a confidence score is drawn as five
marks in the colour of its band, with its number. The Repos screen gets a column "Confidence 30 d",
the average score of the reviews that Kentō published on the repository in the last 30 days, and
the "Score" of the latest reviews of the dashboard uses the same drawing. No migration.
