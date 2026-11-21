---
"@kento-review/web": patch
---

The limits on the questions to GitHub of the forms hold for every process of the service, on the clock of Postgres (KNT-173). The take-back of the owner role asks GitHub once a minute per person and org; before, each process kept its own count. A person can try again 10 s after a failure of GitHub. A person moves or detaches at most 10 installations a minute, whatever the org. Two cases no longer answer 500 when they meet a move of an installation or a webhook of the same org: a check of the repositories, and a new installation of the account. They take the locks in the order of the move, and follow the installation to its new org.

- **Migrations**: `0033_github_asks` adds the table `github_asks`, the counts of these questions. It only adds: the release before runs on it.
