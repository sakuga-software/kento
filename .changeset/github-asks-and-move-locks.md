---
'@kento-review/web': patch
---

The limits on the questions to GitHub of the forms of an org hold for every process of the service (KNT-173). The take-back of the owner role asks GitHub once a minute per person and org; before, each process kept its own count. A person can try again 10 s after a failure of GitHub. A person moves or detaches at most 10 installations of an org a minute. Two cases no longer answer 500 when they meet a move of an installation: a check of the repositories, and a new installation of the account. They wait for the move, then follow the installation to its new org.

- **Migrations**: `0033_github_asks` adds the table `github_asks`, the counts of these questions. It only adds: the release before runs on it.
