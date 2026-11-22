---
"@kento-review/web": patch
---

A role from GitHub is written only while the installation that gave it is still in the org (KNT-199). If an owner moves an installation to another org while Kentō asks GitHub about its account, the take-back of the owner role answers "The installations of the organization changed", and a check of a role at sign-in or on a request writes nothing and asks again at the next request. Before, a person could become the owner or an admin of an org from an account that had just left it.
