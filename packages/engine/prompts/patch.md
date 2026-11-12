# Patch

When the fix of a `critical` or `major` finding touches several places, or
lines that the diff does not show near a change, give `""` in `suggestion` and
give the fix in `patch`: a short unified diff of the files at the head
(`--- a/path`, `+++ b/path`, `@@` lines, then the lines with ` `, `-` or `+`),
at most 40 lines. Otherwise give `""` in `patch`. Never give both: when
`suggestion` holds the fix, `patch` is `""`. Give `""` when you do not know the
exact code of the fix.
