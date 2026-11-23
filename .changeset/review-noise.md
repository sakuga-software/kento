---
"@kento-review/web": patch
---

pr: #48

**Reviews** (KNT-158): « Not reviewed » lists a file once for each reason, with no empty line. A
review with a blocking issue no longer says « safe to merge ». When a defect comes back in another
form, the review asks for its root cause. After a merge of the base branch, a review judges only
what the pull request changes.
