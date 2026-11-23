---
'@kento-review/web': patch
---

Compress the stylesheet, the scripts of the screens and the HTML pages (KNT-202). The build writes brotli and gzip copies of the text files of `public/assets/`, and the service sends the copy that the browser accepts, with `Vary: Accept-Encoding` and an ETag for each copy. The HTML pages are compressed on each request (brotli at quality 5, or gzip). The stream of the live card, the byte ranges, the fonts and the JSON of the runner API stay uncompressed.
