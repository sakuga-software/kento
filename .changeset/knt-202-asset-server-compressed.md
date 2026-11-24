---
'@kento-review/web': patch
---

Serve the browser modules from the asset server of Remix again, with no build step (KNT-202, replaces the bundles of KNT-170). A page with components preloads all of its modules at once, and the HTML pages, the stylesheet, the scripts and the modules are compressed with brotli or gzip. The stream of the live card, the fonts and the JSON of the runner API stay uncompressed.
