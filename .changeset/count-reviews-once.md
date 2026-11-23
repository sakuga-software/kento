---
"@kento-review/web": patch
---

The screen of a pull request counts its reviews as the request for feedback does (KNT-175): only
the reviews on GitHub that a model made. A copy of an earlier review on a commit with no changed
reviewed file shows as "same as R2", and a review that was not published shows as "not published":
neither takes an R number. The count, "Run R{n+1}", the change of the score "since R{n-1}", the
numbers in the detail and the history of a finding, and the count on the user screen follow the
same rule. The user screen lists only the pull requests with a review on GitHub.
