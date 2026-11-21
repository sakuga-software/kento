# Changelog

What each release of Kentō changes for the person who runs it: the migrations, the variables, the
permissions of the GitHub App, the protocol between the service and the runners, and the order of
the deployment. The newest release first. The versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Do not edit the sections by hand: Changesets writes each one from the changesets of the merged pull
requests, in the pull request "chore: version packages". Each entry links its pull request. To add
an entry, see [CONTRIBUTING.md, "Changesets"](../../CONTRIBUTING.md#changesets).

The service (`apps/web`) and the runner (`apps/runner`) share one version. Read the entries since
your release before an upgrade or a rollback. [DEPLOY.md](DEPLOY.md) describes the installation as
it is today.

Each entry says, when it applies:

- **Migrations**: the number that `/healthz` gives after the release.
- **Variables**: the new, changed or removed variables of the service and of the runner.
- **GitHub App**: a new permission or event, which the owners of each installation must accept.
- **Order**: whether the service or the runners go first. By default, the service goes first.

## 0.1.0

The state of Kentō before its first public release. The earlier changes are in the history of
git.

- **Migrations**: 29.
- **Variables**: see [DEPLOY.md, section 4](DEPLOY.md#4-environment-variables) and
  [the variables of the runner](../runner/README.md#variables).
- **GitHub App**: Contents read and write, Pull requests read and write, Issues read and write,
  Checks read and write, Organization members read-only. Events `Pull request`, `Issue comment` and
  `Pull request review comment`.

### Added

- The review of each push to a pull request at three levels (`lite`, `balanced`, `heavy`), published
  as a review with inline comments, a block in the description, a score label and a check.
- The commands `@kento-review [lite|balanced|heavy]`, `force`, `resolve` and `reject`.
- The screens: dashboard, pull requests and findings, repositories and their config, runners, and
  the settings of an organization (providers and keys, cost limits, defaults, trusted bots, state of
  the GitHub App), with the GitHub sign-in and the roles of GitHub.
- Runners in Docker that claim jobs over HTTPS, with leases and attempts, and the providers
  OpenRouter, Anthropic, a server of the OpenAI API, and Ollama.
- The keys of the providers, encrypted with AES-256-GCM under `KENTO_SECRETS_KEY`.
- `KENTO_ALLOWED_ORGS`, to serve only the accounts that it lists.
- `compose.yaml`, to run the service, its database and one runner on one machine.
