## What and why

<!-- What this pull request changes, and why. Link the issue: "Closes #123". -->

## How it was tested

<!-- The tests that you added, the commands that you ran, and for a change of a screen, a screenshot. -->

## Checklist

- [ ] The title follows Conventional Commits: `type(scope): imperative lowercase summary`.
- [ ] A fix comes with a test that fails without it.
- [ ] `pnpm typecheck` and `pnpm test` pass, and the commands of the package that I changed.
- [ ] A migration only adds, and the previous release still runs on the new schema.
- [ ] The documentation is up to date.
- [ ] A changeset in `.changeset/` gives the entry of the changelog (`pnpm changeset`), or an empty one says that nobody who runs Kentō sees the change (`pnpm changeset --empty`).
- [ ] No secret, token, private code or personal data in the diff, the fixtures or this text.
