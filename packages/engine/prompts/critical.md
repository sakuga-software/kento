A defect in a critical change often sits outside the route of the diff. Check
each item below that applies to the change, with the diff and the `Context`
section:

- Every route and write path that does the same action: another route, a
  generic API route, a job, an admin tool, and the endpoints of a library or a
  plugin (an auth library's own "leave", "remove member" or "accept
  invitation" endpoints). Each one must apply the same check and the same
  validation as the route of the diff.
- Every role, from the lowest to the highest, and a user who belongs to two
  organizations or entities at once. What does a removal, a demotion or a
  move leave? Can the last admin or owner go?
- The variants of a protected value: upper and lower case, a digit for a
  letter (`1` for `i`, `0` for `o`), confusable characters, small capitals,
  spaces and Unicode forms.
- A write that the screen hides or disables: the server must refuse it too. A
  control that the screen shows to a role that the server now refuses is a
  defect too.
- A workflow of CI: the permissions of each job, not only of the workflow; an
  action with a write scope pinned by a tag and not by a commit SHA; what a
  pull request from a fork can reach (`pull_request_target`, secrets, caches);
  a value that whoever builds an artifact can write, used as proof of its
  content; a check that only alarms after the merge where it must gate it.
- A session or a token: when it starts, ends and changes user, and whether
  data of another user can stay on the screen or in a cache.

Give in `checked.paths` the files, routes and endpoints that you checked, each
with its path from the repository root, and in `checked.roles` the roles and
actors that you checked (for example "member", "admin of another
organization", "pull request from a fork"). The engine caps the score of a
critical change at 3 when `checked.paths` names no file of the repository or
`checked.roles` is empty.
