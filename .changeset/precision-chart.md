---
"@kento-review/web": patch
---

pr: #70

**Dashboard** (KNT-191): the cards "Recent failures" and "Precision by repo" take the whole width,
one under the other. The precision by repo has a chart (Chart.js, above the list that stays without
JavaScript) and a choice of window, 30 days or 7 (`?precision=7`); the tile "Precision" of "At a
glance" follows it.
