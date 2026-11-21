---
"@kento-review/web": patch
---

pr: #43

**Reviews** (KNT-153): a `minor` finding whose whole fix says that no change is needed is dropped,
and a `minor` finding that only asks the author to confirm becomes a question. A `major` or
`critical` finding always stays. The block of the description lists the
questions under « Questions »: no thread, no block, no weight in the score.
**Order**: the service first, as always. The runner claims the feature `questions`, and the result
of a review can carry `questions`; a service of the release before refuses the claim of a runner of
this release.
