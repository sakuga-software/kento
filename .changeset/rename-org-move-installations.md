---
"@kento-review/web": patch
---

pr: #33

**Screens**: `/settings/organization` (KNT-150): an owner renames the org, and moves an
installation of the App, with its repositories, to another org of theirs, to a new org, or to a
new org with no member (a detach). GitHub must count the person as an admin of the accounts that
the move joins; an installation on a personal account stays in an org of its own. Moving the last
installation deletes the empty org, after a confirmation by its name that lists its members and
invitations. Each change writes `org_audit`. Kentō now asks GitHub for the type of the account of
an installation (`GET /app/installations/{id}`, with the JWT of the App). No migration.
