---
"@kento-review/web": patch
---

pr: #67

**Screens** (KNT-186): the lists of the selects, the menus "…", the confirmations and the menu of the
orgs open with a short fade (140 ms) and close faster (80 ms; the fade-out needs Chromium), and
nothing moves under "reduce motion". The menu of the orgs is now at least as wide as its box and ends
on its right edge; on a phone it hangs from the bar, the width of the screen, where it went past the
left edge before. A long name of org is cut with an ellipsis, in the box and in the menu, with its
full name as a tooltip, instead of pushing the page sideways.
