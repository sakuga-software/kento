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

## 0.2.1

### Patch Changes

- [#39](https://github.com/sakuga-software/kento/pull/39) [`b3a6b8f`](https://github.com/sakuga-software/kento/commit/b3a6b8fed44bdeffe5ddf70d4ba1600858bd7444) - Add changesets for versions and changelogs (KNT-174). Each pull request carries a changeset, and a pull request "chore: version packages" sets the version and writes this changelog. Its merge tags `vX.Y.Z` and starts the release.

- [#65](https://github.com/sakuga-software/kento/pull/65) [`ef5df54`](https://github.com/sakuga-software/kento/commit/ef5df543ed903a7b9f039b7d14205f240463d762) - **Screens**: `/costs` (KNT-188), for every member of the org: what the reviews and resolutions
  cost over this month, last month, 30 or 90 days (`?period=`), against the period before, by UTC
  day, repo, level and model, the most expensive runs, and for this month the projection and the
  cap. "This month" is compared with the same days of the month before; once the day is past the end
  of a shorter month, with the whole month before, and the label says so with its number of days
  ("All of February, 28 days"). Charts with Chart.js 4.6.1 (MIT), served by the service itself like the other browser
  modules; each chart has its table, and the page works without JavaScript. The tile "Cost of the
  month" of the dashboard opens it. At startup the service checks that it can serve the charts; if
  not, it logs `startup.assets_unavailable` and the screen shows its tables without charts. A request
  for a file of a browser package that is no module (a UMD or CommonJS build, a `.d.ts`) answers 404
  with a warning. No migration, no new variable.

- [#40](https://github.com/sakuga-software/kento/pull/40) [`126e124`](https://github.com/sakuga-software/kento/commit/126e124ed2caa6802f2187226ba63565198a555d) - **Reviews** (KNT-154): a pull request that touches authentication, access control, CI, the supply
  chain, secrets, webhooks, payments, a migration of data or the security of the web layer is a
  critical change. Its review gets a checklist, its risk starts with "Critical change (…)", and it
  scores 3/5 at most unless it names a file of the diff (or a route or a library of the change) and
  a real role that it checked. A `lite` review of it scores 3 at most and advises a deeper one. The
  runner computes it: no change of the protocol, and a service of the release before shows it as it
  is.

- [#60](https://github.com/sakuga-software/kento/pull/60) [`208034d`](https://github.com/sakuga-software/kento/commit/208034d0c8a8ae86209c161ac012502cd591e8e7) - **Screens**: `/feedback` (KNT-176) shows 25 answers a page, the newest first, with "Newer" and
  "Older" links that keep the filters; it showed the 200 newest before, with a count. A link to a page
  after the last one shows "No older feedback" and a link to the newest. KNT-195: a URL with an empty
  filter, a value the screen cannot read or a broken cursor redirects (303) to the same screen with
  only the values in use. The page reads the existing index `feedback_repo_created_at_idx`. No
  migration.

- [#57](https://github.com/sakuga-software/kento/pull/57) [`c5a8405`](https://github.com/sakuga-software/kento/commit/c5a84054ce9ed03769990b9c954953e89ec4903b) - The limits on the questions to GitHub of the forms hold for every process of the service, on the clock of Postgres (KNT-173). The take-back of the owner role asks GitHub once a minute per person and org; before, each process kept its own count. A person can try again 10 s after a failure of GitHub. A person moves or detaches at most 10 installations a minute, whatever the org. Two cases no longer answer 500 when they meet a move of an installation or a webhook of the same org: a check of the repositories, and a new installation of the account. They take the locks in the order of the move, and follow the installation to its new org.
  
  - **Migrations**: `0033_github_asks` adds the table `github_asks`, the counts of these questions. It only adds: the release before runs on it.

- [#72](https://github.com/sakuga-software/kento/pull/72) [`ff54b66`](https://github.com/sakuga-software/kento/commit/ff54b6616195e7d4cc3a0fb9bef1f4538934a348) - A take-back of the owner role that is under way while a move deletes its org writes no count for the deleted org, and asks GitHub nothing (KNT-198). The person gets "not found".

- [#74](https://github.com/sakuga-software/kento/pull/74) [`0ffa0d0`](https://github.com/sakuga-software/kento/commit/0ffa0d009f203ae245a647a95cf54c7e79cd36bf) - A take-back of the owner role by a person who is no longer a member of the org when it is counted is not counted, and asks GitHub nothing: the person gets "not found" (KNT-198).

- [#67](https://github.com/sakuga-software/kento/pull/67) [`c2d9c34`](https://github.com/sakuga-software/kento/commit/c2d9c34e22f01e4f6981341236308e9a3214e6f2) - **Screens** (KNT-186): the lists of the selects, the menus "…", the confirmations and the menu of the
  orgs open with a short fade (140 ms) and close faster (80 ms; the fade-out needs Chromium), and
  nothing moves under "reduce motion". The menu of the orgs is now at least as wide as its box and ends
  on its right edge; on a phone it hangs from the bar, the width of the screen, where it went past the
  left edge before. A long name of org is cut with an ellipsis, in the box and in the menu, with its
  full name as a tooltip, instead of pushing the page sideways.

- [#56](https://github.com/sakuga-software/kento/pull/56) [`f1fd3a1`](https://github.com/sakuga-software/kento/commit/f1fd3a17a58d322029ff40b9650e76108656e09f) - **Dashboard** (KNT-190, KNT-193): "No cap", on the card Cost and in "At a glance", links to the
  section "Costs and cap" of the settings for an owner or an admin (plain text for a member, who keeps
  the hint "An admin sets it in Settings"). The section "To do" shows only when it has something in it.

- [#45](https://github.com/sakuga-software/kento/pull/45) [`cbeac94`](https://github.com/sakuga-software/kento/commit/cbeac94162591f9d4948e081331bce3369c20dd7) - **Reviews** (KNT-152): a finding about a race, an order of events or a timeout gives the steps that
  the runtime allows, each at a file and a line. Without two such steps, or without a number for a
  claim that some work is too slow, it becomes a question.

- [#33](https://github.com/sakuga-software/kento/pull/33) [`da56248`](https://github.com/sakuga-software/kento/commit/da5624893d9ac765a6833fe9ea4d72a57100f58f) - **Screens**: `/settings/organization` (KNT-150): an owner renames the org, and moves an
  installation of the App, with its repositories, to another org of theirs, to a new org, or to a
  new org with no member (a detach). GitHub must count the person as an admin of the accounts that
  the move joins; an installation on a personal account stays in an org of its own. Moving the last
  installation deletes the empty org, after a confirmation by its name that lists its members and
  invitations. Each change writes `org_audit`. Kentō now asks GitHub for the type of the account of
  an installation (`GET /app/installations/{id}`, with the JWT of the App). No migration.

- [#54](https://github.com/sakuga-software/kento/pull/54) [`68202ac`](https://github.com/sakuga-software/kento/commit/68202acfa33b4547068cd491c5686a3db3b838bb) - **Screens**: `/repos` (KNT-179, KNT-180, KNT-181, KNT-182, KNT-194): the table drops the columns
  "Reviews by" and "Switch", their legend and the notes on the switch from review.yml. "Remove
  review.yml" moves to the menu "…" of the row, for an admin at 20 reviews in a row with the file
  still there, and the row says "review.yml can go". The dashboard item "still on review.yml" opens
  the filter "To switch". The visibility of a repository is the icon left of its name (and in the
  title of the name), and the last review fits on one line. No migration.

- [#43](https://github.com/sakuga-software/kento/pull/43) [`70434d7`](https://github.com/sakuga-software/kento/commit/70434d780d6cf30d0411d45ccefa94357639d381) - **Reviews** (KNT-153): a `minor` finding whose whole fix says that no change is needed is dropped,
  and a `minor` finding that only asks the author to confirm becomes a question. A `major` or
  `critical` finding always stays. The block of the description lists the
  questions under « Questions »: no thread, no block, no weight in the score.
  **Order**: the service first, as always. The runner claims the feature `questions`, and the result
  of a review can carry `questions`; a service of the release before refuses the claim of a runner of
  this release.

- [#42](https://github.com/sakuga-software/kento/pull/42) [`bc0bad4`](https://github.com/sakuga-software/kento/commit/bc0bad43b3b5501fa8ed2f36cf291ffb7d9ae743) - **Thread commands** (KNT-160): `reject #<id> <cause>` works in the thread of that finding (another
  id is refused, and an unknown id gets « no finding has this id »); `resolve` in a thread gets an
  answer at once that it goes in the conversation; a reject resolves the thread even when the ledger
  does not know its id yet. A finding not found again is now `fixed` only when a push changed a line
  within 10 lines of it (or its file, when GitHub gives no patch); a change elsewhere in the file
  leaves it open. No migration.

## 0.2.0 (2026-11-21)

The first public release. The runner image is `ghcr.io/sakuga-software/kento-runner:0.2.0`.

- **Content security policy** (KNT-163): `script-src 'self' 'nonce-…'`, a new nonce for each page.
  The one inline script is the import map of the components that hydrate. A proxy in front of the
  service must not cache the pages (they keep `Cache-Control: private, no-store`) nor rewrite this
  header. The service serves the browser modules itself, under `/assets/app/`, `/assets/c/`,
  `/assets/ui/`, `/assets/rp/` and `/assets/fr/`: the proxy routes all of `/assets/`
  to it, as before.
- **Migrations**: 33. `0032_invitations` (KNT-150) adds the tables `invitations` and `org_audit` (one
  row per change of the members). It only adds: the release before runs on it.
- **Screens**: `/settings/members` (the members and the invitations of the org, linked from the menu
  of the org and the settings) and `/invitations` (the invitations of the person). An owner or an
  admin invites a GitHub login; a person whom GitHub counts in no org of the App signs in with a
  pending invitation, and sees only it until they accept. No change leaves an org without an
  active owner.
- **Migrations**: 32. `0031_organization_roles` (KNT-150): the roles of an org are `owner`, `admin`
  and `member`. Every admin of today becomes an owner (nobody loses a right), and every membership
  of today is marked as coming from GitHub. GitHub keeps deciding between admin and member for those:
  an owner holds only while GitHub says admin, and one whom GitHub demotes to member becomes a member
  at the next check (10 minutes), as an admin would. A GitHub admin of an org with no active owner
  (one checked or signed in within 30 days) becomes its owner at their next check.
- **Rollback**: the release before reads `owner` as no admin: each owner reads only until GitHub is
  asked again (10 minutes at most), and that release writes `admin` back. This release makes such an
  admin the owner again at the next check when the org has no active owner.
- **Screens**: the box of the org in the header is a menu of every org of the person, with their
  role in each.
- **Migrations** (before it): `0030_better_auth` (KNT-150): Better Auth runs the sign-in and the sessions.
  `users` gets the e-mail that Better Auth needs (`<github id>@users.github.invalid`, never mailed),
  `accounts` the GitHub account of each user (no token, ever), `verifications` the state of a
  sign-in. **Every session ends**: each person signs in again once, with one click on GitHub, and
  keeps their rights (`memberships` stay). The GitHub App needs no change: the callback URL is the
  same.
- **Session cookie**: still `__Host-kento_session` over HTTPS (HttpOnly, Secure, SameSite=Lax,
  Path=/, no Domain, 7 days), now written by Better Auth. The cookie of the release before opens no
  session: its holder sees "Session ended." once, the cookie is cleared, and they sign in again. The
  state of a sign-in in progress has its own cookie, `__Host-kento_state` (10 minutes).
- **Sign-in limits**: Kentō limits the starts of a sign-in (10 a minute) and the callbacks of GitHub
  (20 a minute) by client; over it, the sign-in page answers 429 (`auth.sign_in_limited`). The
  limiter of Better Auth is off. **Behind a proxy, set `KENTO_TRUSTED_PROXY_HOPS`** (1 behind
  Traefik alone) before the deploy: with the default 0, every client has the address of the proxy
  and shares one limit.
- **Sessions keep** the address of the client (as resolved above) and its user agent, for an
  admin who reads the table; nothing shows them.
- **Variables**: `KENTO_SESSION_SECRET` signs with its first secret only; a new first secret signs
  everybody out (DEPLOY.md, section 9).
- **Variables**: new `KENTO_TRUSTED_PROXY_HOPS`, **required when `KENTO_PUBLIC_URL` is https** (the
  service does not start without it: `1` behind Traefik alone, an explicit `0` when nothing is in
  front), and `KENTO_SIGN_IN_LIMIT` (default 10, per process).
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
  provider"). It stays in view while the page scrolls and marks the section and the part on screen
  (on a phone, the section that the person chose, while they are in it).
  Under 900 px it is a bar, "Sections", at the top of the page, that opens the list under it. It does
  not follow the scroll: a sticky bar covered part of a field after a form came back with its
  errors. Instead, each section ends with a link "Sections" that leads back to the bar and opens
  the list on that section. The addresses of the sections do not change (`/settings#cap`,
  `#defaults`, `#bots`, `#app`, `#org-rules`, `#providers`).

### Fixed

- The thread of a finding that a push fixed is resolved again. The review asked GitHub with a token
  that cannot write the contents, and GitHub refused: Kentō answered "The thread can be resolved."
  and left it open. The publisher now asks a token with `contents: write` for the thread only.
- `@kento-review resolve` works again. The service read the threads with a token that cannot read
  the contents, and GitHub refused the commit of each comment (`FORBIDDEN` on `originalCommit`).
- `compose.yaml` publishes port 3000 on `127.0.0.1` only. Before, the service also answered in plain
  HTTP on every address of the machine, and a firewall such as `ufw` did not close the port. If
  your reverse proxy runs on another machine, publish the port on a private address.
- A job with no choice of models in its config no longer logs `warn job.models_not_sent` when it
  runs on the default provider of the org. That is the normal path. The warning stays for models that
  the config chose and that the job cannot run (KNT-139).

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
