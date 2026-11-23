---
"@kento-review/web": patch
---

**Screens** (KNT-170): a page with a component that hydrates also preloads the bundle of that component, so the browser loads it with the runtime instead of after the page. Measured at 40 ms and 10 Mbit/s: 44 to 68 ms sooner to hydrated on a first visit.
