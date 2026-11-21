---
"@kento-review/web": patch
---

pr: #65

**Screens**: `/costs` (KNT-188), for every member of the org: what the reviews and resolutions
cost over this month, last month, 30 or 90 days (`?period=`), against the period before, by UTC
day, repo, level and model, the most expensive runs, and for this month the projection and the
cap. "This month" is compared with the same days of the month before; once the day is past the end
of a shorter month, with the whole month before, and the label says so with its number of days
("All of February, 28 days"). Charts with Chart.js 4.6.1 (MIT), served by the service itself like the other browser
modules; each chart has its table, and the page works without JavaScript. The tile "Cost of the
month" of the dashboard opens it. At startup the service checks that it can serve the charts; if
not, it logs `startup.assets_unavailable` and the screen shows its tables without charts. A request
for a file of a browser package that is no module (a UMD or CommonJS build, a `.d.ts`) answers 404
with a warning. No migration, no new variable.
