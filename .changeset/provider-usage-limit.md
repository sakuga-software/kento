---
"@kento-review/web": patch
---

pr: #49

**Usage limit of a provider** (KNT-161): a 429, a 402, or an error that names a usage limit stops
the review at the first model of the provider (its other models get the same refusal), and keeps
the reset time that the provider gives. The comment on the pull request says that the review did
not happen, until when, and how to run it again. Such a refusal no longer marks the key of the
provider as refused, even as a 403 « Key limit exceeded » (a 401 stays a refused key). The reason
of a runner of the release before is read the same way.

**Check of a failed review**: a review that fails for good now posts the check of Kentō on its head
when the head has none: `action_required` for a usage limit, `failure` otherwise, never `success`.
A head that another review already checked keeps its check. It uses the `checks: write` permission
that the App already has. No migration.
