---
"@kento-review/web": patch
---

**Screens**: `/settings` (KNT-177): on a desktop, a link of the sidebar scrolls smoothly to its
section. A load of `/settings#section` (after a save, from a link, a reload), Tab and the history
still jump at once, as before; so does the page with reduced motion and under 900 px. No migration.
