---
"@kento-review/web": patch
---

**Screens**: `/repos` (KNT-184, KNT-185, KNT-195): "Read GitHub again" is an icon button, marked
busy while the check runs, and it brings the list back with its filter, search and page. The result
of a check, an enable or a disable shows in a toast in the corner of the window, which goes away
after 8 seconds or with its close link; an error stays a banner. No migration.
