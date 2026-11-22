---
"@kento-review/web": patch
---

**Screens**: `/findings` (KNT-178) reads the size of its pages from `?per=n`, 10 to 100 (a size out of
those bounds reads as the nearest one). Without `per` a page still has 25 rows. With JavaScript, the
first visit of a session without `per` replaces the URL once with the size that fits the height of
the window, on the page that keeps the first row on screen; the page takes no input while it leaves,
and the links to the list then carry that size for the rest of the session (`sessionStorage`), so
later visits load once. Every link of the list and the form of the filters keep `per`. KNT-195: a URL
with empty fields (the form sends them), a value the screen cannot read, a size out of bounds or a
page after the last one redirects (303) to the URL of the same list with only the values in use; the
notice after "Mark dismissed" or "Mark wontfix" stays. No migration.
