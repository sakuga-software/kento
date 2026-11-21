---
"@kento-review/web": patch
---

**Screens**: `/repos` (KNT-179, KNT-180, KNT-181, KNT-182, KNT-194): the table drops the columns
"Reviews by" and "Switch", their legend and the notes on the switch from review.yml. "Remove
review.yml" moves to the menu "…" of the row, for an admin at 20 reviews in a row with the file
still there, and the row says "review.yml can go". The dashboard item "still on review.yml" opens
the filter "To switch". The visibility of a repository is the icon left of its name (and in the
title of the name), and the last review fits on one line. No migration.
