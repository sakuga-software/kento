---
"@kento-review/web": patch
---

pr: #44

**Reviews** (KNT-151): the context of a review holds the functions that a change calls, the schema
and the migrations of the tables that it reads or writes, and the route that a changed test
requests, and a workflow file shows whole. A finding whose premise is code that the review did not
read goes to « Not reviewed » with what to check, and its thread stays open.

**Order**: the service, then the runners. A runner of this release claims the feature `moved`,
which the service of the release before refuses.
