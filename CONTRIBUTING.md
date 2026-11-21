# Contributing to Kentō

Thank you for your interest. This page says how to report a problem and how to propose a change.

Kentō is under the [GNU Affero General Public License v3.0 only](LICENSE). Each contribution comes
under the same license, with a sign-off (see [Sign your commits](#sign-your-commits)).

By taking part, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Report a problem

- **A vulnerability**: never in a public issue. Follow [SECURITY.md](SECURITY.md).
- **A bug**: open an issue with the **Bug report** form. Give the release or commit, what you did,
  what you expected, what happened, and the log lines around it. Remove every secret, token and
  private code first.
- **A wrong finding** (a false positive, or a defect that the review missed): open an issue with the
  **Review quality** form. A small public diff that reproduces it helps most.
- **An idea**: open an issue with the **Feature request** form before you write code, so that we can
  agree on the approach first.

## Set up

You need Node 26 or later, pnpm 11, Docker, and Postgres 18 for the tests of the database.

```sh
pnpm install
pnpm typecheck
pnpm test
```

[apps/web/README.md](apps/web/README.md#develop) gives the commands of the service: the dev server,
the tests against Postgres, the tests of the screens in a browser, and the migrations.

## Propose a change

1. Fork the repository and create a branch from `main`.
2. Make one change per pull request. Keep it small enough to review.
3. Add or update the tests. A fix comes with a test that fails without it.
4. Run `pnpm typecheck` and `pnpm test`, and the commands of the package that you changed
   (`pnpm -F @kento-review/web lint`, `test:db`, `e2e`).
5. Update the documentation that your change makes wrong: the README of the package, and
   [apps/web/DEPLOY.md](apps/web/DEPLOY.md) for a new variable or permission.
6. Add a changeset (see [Changesets](#changesets)).
7. Sign off each commit (below).
8. Open the pull request and fill in its template.

The title of a pull request becomes the message of the squashed commit. It follows
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), in English:

```
type(scope): imperative lowercase summary
```

- `type`: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `ci`, `build` or `chore`.
- `scope`: the area that the change touches, short (`engine`, `web`, `runner`, `publish`,
  `deploy`). No scope for `ci`.
- For example: `fix(publish): keep the block of the description when the body changed`.

## Changesets

Each pull request adds a changeset: a small file in `.changeset/` with the entry of the change in
the changelog of Kentō, [apps/web/CHANGELOG.md](apps/web/CHANGELOG.md), and the bump of the version
that it asks for. The check "Changeset" fails on a pull request with none. Run at the root:

```sh
pnpm changeset                                          # asks the package, the bump and the entry
pnpm changeset --patch @kento-review/web -m "Fix …"     # the same, with no question
pnpm changeset --empty                                  # a change that nobody who runs Kentō sees
```

- **Name `@kento-review/web` only**, for a change of the runner or of the engine too. Its
  CHANGELOG.md is the one of Kentō. The service and the runner share its version (`fixed` in
  `.changeset/config.json`), and `packages/engine` and `packages/protocol` have no release of their
  own (`ignore`).
- **An empty changeset** (`--empty`) is for a change that nobody who runs or uses Kentō sees: a test,
  the CI, the documentation of the contributors, a refactoring. It adds no entry and no bump.
- **The bump, before 1.0.** `minor` when an operator must act, or when something that worked stops
  working: a new required variable, a variable that changes or goes away, a new permission or event
  of the GitHub App, the runners before the service, a protocol that an older runner does not
  follow, sessions that end, a feature or a command that goes away. `patch` for the rest: a new
  feature, a fix, a change of a screen. No `major` before 1.0.
- **The entry is for the person who runs Kentō.** Write in English, in the style of the changelog:
  what changes for them first. Add the lines that apply: **Migrations**, **Variables**,
  **GitHub App**, **Order** (the head of the changelog says what each one gives). The changelog
  links the pull request and its author by itself.
- Change the changeset in your pull request as the change moves. Never edit the sections of the
  changelog by hand.

A maintainer releases. Each push to `main` updates the pull request "chore: version packages"
(workflow Changesets): it sets the version, writes the changelog and removes the changesets. The
merge of that pull request tags `vX.Y.Z` and starts the release
([apps/runner/DEPLOY.md, "Publish a release"](apps/runner/DEPLOY.md#publish-a-release)).

## Sign your commits

Each commit carries a `Signed-off-by` line with your name and email. With it, you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): you wrote the change, or
you have the right to submit it under the license of the project.

```
git commit -s
```

Add `-s` to each commit. To sign the commits of a branch that you already wrote, run
`git rebase --signoff main`, then push again.

## Conventions

- **TypeScript without a build step.** Node runs the source as is. Keep to erasable syntax: no
  `enum`, no `namespace`, no parameter properties.
- **Cast the parameters that Postgres cannot type.** postgres.js 4 sends a parameter without a
  type, and the server decides it from the query. In `set col =`, in `values` and in a comparison
  with a column, the column gives the type. Elsewhere, cast a boolean, a date, a `bigint`, a
  `Buffer` or an array: `${flag}::boolean`, `${at}::timestamptz`, `${ids}::uuid[]`. Without the cast,
  `select ${false} as x` gives the string `'false'`. Write a date as `toISOString()`, and pass an
  array as it is: `sql.array()` is gone.
- **Migrations only add.** The previous release runs on the new schema during a deployment: add a
  column with a default or as nullable, and never drop or rename a column that the running release
  still reads. See [apps/web/README.md](apps/web/README.md#migrations).
- **The service and the runner stay compatible across one release.** A change of
  `packages/protocol` must let a runner of the previous release work with the new service.
- **The runner never runs the code of a pull request**, and never writes on GitHub. Keep it so.
- **Everything that the model reads is data.** A change of a prompt (`packages/engine/prompts/`)
  keeps the rule that the model does not follow an instruction found in the code or in a comment.
  Measure a change of a prompt or of a model with the bench in [`eval/`](eval/README.md), and give
  the numbers in the pull request.
- **English everywhere**: code, comments, documentation, messages of the screens and of the bot.
  Write short sentences, one idea each, in the active voice.
- **No real data in the repository.** Fixtures, tests and examples use made-up names
  (`acme`, `example.com`). Never commit a secret, a token, a private repository name or a person's
  data.

## Review

A maintainer reviews each pull request. Fix each finding of a review, or answer with the fact that
refutes it.

The CI must be green before a merge. A maintainer merges with a squash.
