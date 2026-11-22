---
"@kento-review/web": patch
---

pr: #49

**Usage limit of a provider** (KNT-161): a 402, an error that names a quota, credits, a spend
limit or a key limit, or a limit that ends more than 10 minutes away stops the review at the first
model of the provider (its other models get the same refusal), and keeps the reset time that the
provider gives. The comment on the pull request says that the review did not happen, until when,
and how to run it again. Such a refusal no longer marks the key of the provider as refused, even as
a 403 « Key limit exceeded » (a 401 stays a refused key). The reason of a runner of the release
before is read the same way.

**Short rate limit**: another 429 tries the next model of the level, as before. When every model
gets one, the job goes back to the queue until the reset (at least the usual backoff); only when
that attempt fails too does the comment say that the review did not happen. The reset time comes
from `retry-after` (decimals included) or the reset headers (epoch seconds, milliseconds, a delta
or a duration), never from another date of the body, and a time in the past is dropped. Account ids
(`org-…`, `user_…`) are masked in the comment and the check.

**Check of a failed review**: a review that fails for good now posts the check of Kentō on its head
when the head has none: `action_required` for a usage or rate limit, `failure` otherwise, never
`success`. A head that another review already checked keeps its check. It uses the `checks: write`
permission that the App already has. No migration.
