# Changelog

What each release of Kentō changes for the person who runs it: the migrations, the variables, the
permissions of the GitHub App, the protocol between the service and the runners, and the order of
the deployment. The newest release first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The service (`apps/web`) and the runner (`apps/runner`) share one version. Read the entries since
your release before an upgrade or a rollback. [DEPLOY.md](DEPLOY.md) describes the installation as
it is today.

Each entry says, when it applies:

- **Migrations**: the number that `/healthz` gives after the release.
- **Variables**: the new, changed or removed variables of the service and of the runner.
- **GitHub App**: a new permission or event, which the owners of each installation must accept.
- **Order**: whether the service or the runners go first. By default, the service goes first.

## Unreleased

- **Migrations**: 32. `0031_organization_roles` (KNT-150): the roles of an org are `owner`, `admin`
  and `member`. Every admin of today becomes an owner (nobody loses a right), and every membership
  of today is marked as coming from GitHub. GitHub keeps deciding between admin and member for those;
  the owner role is given in Kentō.
- **Screens**: the box of the org in the header is a menu of every org of the person, with their
  role in each.
- **Migrations** (before it): `0030_better_auth` (KNT-150): Better Auth runs the sign-in and the sessions.
  `users` gets the e-mail that Better Auth needs (`<github id>@users.github.invalid`, never mailed),
  `accounts` the GitHub account of each user (no token, ever), `verifications` the state of a
  sign-in. **Every session ends**: each person signs in again once, with one click on GitHub, and
  keeps their rights (`memberships` stay). The GitHub App needs no change: the callback URL is the
  same.
- **Session cookie**: `__Secure-kento_session` (was `__Host-kento_session`), still HttpOnly,
  SameSite=Lax, no Domain, 7 days.
- **Variables**: `KENTO_SESSION_SECRET` signs with its first secret only; a new first secret signs
  everybody out (DEPLOY.md, section 9).
- **Migrations** (before it): `0029_installations` (KNT-150) moves the GitHub App installation out of
  `orgs` into a new table `installations`: an org of Kentō can now hold several installations. Each
  org keeps its id, its settings and its members, and gets one installation with the same GitHub
  ids; each repository gets the installation of its org (`repos.installation_id`). Orgs get a
  `name` and a unique `slug` (the login; an account that installed the App twice has a second org
  with the installation id as a suffix). The release before it does not run on the new schema:
  **follow [DEPLOY.md](DEPLOY.md#the-deployment-of-migration-0029)**: check that no slug
  collides, take a backup (there is no down migration), stop the previous release before the new
  one starts, and redeliver from the App page the webhooks that failed in between if they overlapped.
  The live org of an account that installed the App twice gets the clean slug. An installation that
  still has repositories cannot be deleted (their history stays).
- **Webhook**: a new installation of an account that had one before joins the org of that earlier
  installation, with its settings, instead of a new org.
- **Order**: the service, then the runners (the engine changes).
- **Database driver**: postgres.js 4. With no `PG*` variable and no ssl parameter in
  `DATABASE_URL`, the service connects as before. Version 4 reads more of the environment:
  - `PGSSLMODE`, which version 3 ignored. `require` uses TLS, and fails against a server without
    it. `prefer` and `allow` use TLS when the server offers it. `verify-ca` and `verify-full` check
    the certificate against the CAs of Node, not `PGSSLROOTCERT` or `~/.postgresql/root.crt`: with
    a private CA, the migrations fail and the service does not start.
  - `sslrootcert`, `sslcert` and `sslkey` in `DATABASE_URL` are read as files. Version 3 sent them
    to the server, which refused the connection (`42704`).
  - `PGCHANNELBINDING`, and `PGPASSFILE` or `~/.pgpass` when `DATABASE_URL` has no password.
  - `PGQUERY_TIMEOUT`, `PGQUEUE_TIMEOUT`, `PGCANCEL_TIMEOUT`, `PGMIN`, `PGINFER`, `PGSCHEDULER` and
    `PGSSLNEGOTIATION`, new options of version 4.

  Before you deploy, check `env | grep '^PG'` and `~/.pgpass` in the container of the service.

### Changed

- The packages of the repository are `@kento-review/web`, `@kento-review/runner`,
  `@kento-review/engine` and `@kento-review/protocol` (before `@sakuga-review/…`): use these names
  with `pnpm -F`. The images, the markers in the texts on GitHub and the commands do not change.
- Kentō is under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). The image of
  the runner says so in `org.opencontainers.image.licenses`.
- The Settings screen has a sidebar in place of the tabs under its title: the sections, and under
  each one its parts (the levels, the parts of the GitHub App, each provider, "New rule", "Add a
  provider"). It stays in view while the page scrolls and marks the section and the part on screen.
  Under 900 px it is a bar, "Section", that stays at the top and opens the list. The addresses of
  the sections do not change (`/settings#cap`, `#defaults`, `#bots`, `#app`, `#org-rules`,
  `#providers`).

### Fixed

- The thread of a finding that a push fixed is resolved again. The review asked GitHub with a token
  that cannot write the contents, and GitHub refused: Kentō answered "The thread can be resolved."
  and left it open. The publisher now asks a token with `contents: write` for the thread only.
- `@kento-review resolve` works again. The service read the threads with a token that cannot read
  the contents, and GitHub refused the commit of each comment (`FORBIDDEN` on `originalCommit`).
- `compose.yaml` publishes port 3000 on `127.0.0.1` only. Before, the service also answered in plain
  HTTP on every address of the machine, and a firewall such as `ufw` did not close the port. If
  your reverse proxy runs on another machine, publish the port on a private address.

### Security

- The OpenRouter key of the service (`KENTO_PROVIDER_API_KEY`) goes only to a trusted runner of the
  service, never to a runner of an organization: its admin could read the key and spend it outside
  Kentō. A trusted runner of an organization still gets the keys of the providers of its
  organization. A job of an organization with no provider now runs on a runner of the service, or on
  a runner of the organization with its own OpenRouter key. On the Runners screen, the mode "Key of
  the service" is now "Keys stored in Kentō". An instance whose runners are all runners of the
  service sees no change.
- On the Settings screen, the text that confirms the removal of the default provider says what
  the jobs use next, with and without the OpenRouter key of the service.
- The Dashboard says why a job with no provider waits: after 10 min, "To do" says that it waits for
  a runner with an OpenRouter key. "Getting started" counts the key of the service only while the
  service has a trusted runner.
- `returnTo` can no longer send a signed-in member to another site: `/.//host` became `//host` after
  the parse. The path is now checked after the parse.
- The tools of the engine can no longer block the runner or fill its memory. git runs
  asynchronously, so the heartbeat goes on during a call. One call stops after 10 s, and the calls
  of one review after 60 s in all. Each git process has at most 512 MB of virtual memory
  (`ulimit -v`) and 2 grep threads: a pattern such as `((a{1,100}){1,100}){1,100}b`, which filled the
  2 GB of the runner in 3 s, now makes git stop with "Memory exhausted" in 0.2 s, and the model gets
  that cause. `grep` also refuses a back reference (`\1` to `\9`) and a pattern whose repetitions
  make more than 1,000 copies, as a first filter.
- What the memory limit costs. `ulimit -v` counts the address space, so the maps of the pack files
  count in full: with maps of up to 256 MB, 5 to 10 % of the greps with no glob failed on a pack of
  288 MB, and every grep failed on a pack of three files of 99 MB. git now maps at most 96 MB of the
  pack files at once, keeps at most 16 MB of delta bases, and uses one malloc arena. Measured on the
  same packs: no failure, and a peak of 240 MB and 317 MB. The price is time: the median grep with
  no glob on the pack of 288 MB takes 2.4 s instead of 2.2 s (7 % more). A grep that holds several
  files of close to 100 MB rebuilt from deltas still comes near the limit (500 MB at most, no
  failure in 30). When git runs out of memory, `grep` now says why: a pattern that git cannot
  compile gets "use a simpler pattern", and files that git cannot map or read get "narrow the
  glob". The cause comes from the error of git, not from the words of the pattern that git quotes.
- The test of a provider refuses more addresses: `::ffff:0:a.b.c.d` and 6to4 (`2002::/16`) are
  judged by their IPv4, and local NAT64 (`64:ff9b:1::/48`), Teredo (`2001::/32`) and `192.0.0.0/24`
  are refused.

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
