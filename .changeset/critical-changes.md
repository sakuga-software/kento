---
"@kento-review/web": patch
---

pr: #40

**Reviews** (KNT-154): a pull request that touches authentication, access control, CI, the supply
chain, secrets, webhooks, payments, a migration of data or the security of the web layer is a
critical change. Its review gets a checklist, its risk starts with "Critical change (…)", and it
scores 3/5 at most unless it names a file of the diff (or a route or a library of the change) and
a real role that it checked. A `lite` review of it scores 3 at most and advises a deeper one. The
runner computes it: no change of the protocol, and a service of the release before shows it as it
is.
