# Changesets

Each file here is a changeset: the entry of a pull request in the changelog of Kentō
([apps/web/CHANGELOG.md](../apps/web/CHANGELOG.md)), and the bump of the version that it asks for.
The workflow "Changesets" turns them into the pull request "chore: version packages", which sets
the new version, writes the changelog and removes them.

To add one, run `pnpm changeset` at the root, or `pnpm changeset --empty` for a change that nobody
who runs or uses Kentō sees. [CONTRIBUTING.md, "Changesets"](../CONTRIBUTING.md#changesets) says
when to add one and which bump to choose.
