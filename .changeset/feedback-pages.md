---
"@kento-review/web": patch
---

**Screens**: `/feedback` (KNT-176) shows 25 answers a page, the newest first, with "Newer" and
"Older" links that keep the filters; it showed the 200 newest before, with a count. A link to a page
after the last one shows "No older feedback" and a link to the newest. KNT-195: a URL with an empty
filter, a value the screen cannot read or a broken cursor redirects (303) to the same screen with
only the values in use. The page reads the existing index `feedback_repo_created_at_idx`. No
migration.
