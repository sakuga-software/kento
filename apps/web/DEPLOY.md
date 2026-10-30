# Deploy apps/web on Dokploy

Runbook for the first deployment of the Kentō web service on `review.sakuga.dev`, then for each
deployment after it. The agents do not touch Dokploy or production: a person with access to Dokploy
and to the DNS runs these steps.

Target: Dokploy on `prod-host`, one application and one Postgres, in a project named `Kentō`.

## 1. Postgres

1. Dokploy → project `Kentō` (create it if needed) → **Create service → Database → PostgreSQL**.
2. Name `postgres`, image `postgres:18`, database `kento`, user `kento`. Let Dokploy generate the
   password, and keep it only in Dokploy.
3. No external port. The application reaches the database on the internal network of Dokploy.
4. Deploy it. Note the **internal host** that Dokploy shows on the database page.
5. Turn on the daily backup of the database (Dokploy → database → **Backups**) to the S3 destination
   used by the other projects.

## 2. Application

1. Project `Kentō` → **Create service → Application**, name `web`.
2. **Provider**: GitHub, repository `sakuga-software/sakuga-review`, branch `main`.
3. **Build type**: Dockerfile. Dockerfile path `apps/web/Dockerfile`, Docker context path `.` (the root
   of the repository: the pnpm workspace and its lockfile live there).
4. **Build arguments** (optional): `APP_COMMIT=<commit>` puts the commit in `/healthz`. Without it,
   `/healthz` gives `"commit": null` and only the version.
5. **Environment**:

   ```sh
   DATABASE_URL=postgresql://kento:<password>@<internal host>:5432/kento
   ```

   The other variables have defaults (see [README.md](README.md#configuration)). Leave `PORT` at
   3000 and `MIGRATE_ON_START` at `true`.
6. **Domains**: `review.sakuga.dev`, container port `3000`, HTTPS with Let's Encrypt.
7. **DNS** (Gandi, zone `sakuga.dev`): a record `review` to `prod-host`, the same way as the other
   services of that host. Wait until `dig +short review.sakuga.dev` gives the address of the host.
8. Deploy.

The image has a `HEALTHCHECK` on `/healthz` (every 30 s, 3 failures). Swarm replaces a container
that stays unhealthy, and a new container that does not become healthy does not replace the old one.

## 3. Check the deployment

1. Dokploy → `web` → **Logs**. In order:

   ```json
   {"level":"info","event":"startup.migrations_applied","durationMs":…}
   {"level":"info","event":"startup.listening","host":"0.0.0.0","port":3000,"version":"0.1.0",…}
   ```

   `startup.config_invalid` names a missing or invalid variable. `startup.migrations_failed` gives the
   error of the database: check `DATABASE_URL` and that the Postgres service is running. In both
   cases the process stops before it listens, and the previous container keeps serving.
2. The health check:

   ```sh
   curl -sS https://review.sakuga.dev/healthz
   # 200 {"status":"ok","version":"0.1.0","commit":…,"database":{"status":"ok","latencyMs":…,"migrations":1}}
   ```

3. A redeploy applies no migration twice and keeps the rows: **Redeploy**, then the same `curl` gives
   the same `migrations` count. The tests prove the same thing against Postgres
   (`apps/web/test/db/migrations.test.ts`: applied twice, then a new migration on top of seeded rows).
   The first real new migration (REV-3 or REV-4) checks it in production: the count goes up by one,
   and the rows of `orgs` and `repos` are still there.

## 4. Logs in Grafana

1. <https://grafana.sakuga.dev> → **Explore** → the Loki source.
2. Look for the lines of the service, for example `{host="prod-host"} |= "startup.listening"`, and
   note the labels that the line carries.
3. If the line has no `project` / `app` labels, the Alloy collector of the host does not know the
   service yet. Add it as the monitoring runbook of the host describes (`/home/mheos/monitoring/README.md`
   on `prod-host`): a rule on the name of the Swarm service that sets `project="Kentō"` and `app="web"`
   (and `app="postgres"` for the database), then reload Alloy.
4. Check: `{project="Kentō", app="web"}` shows the `startup.*` lines.

Useful queries once the labels exist:

```logql
{project="Kentō", app="web"} | json | level="error"
{project="Kentō", app="web"} | json | event="http.request" | status >= 500
```

## 5. GitHub App webhook (REV-3)

The existing App « Sakuga Review » (client id `Iv23liesB1xzywavcnv2`) gets a webhook. No new App.
Deploy the release with REV-3 first: without its secret the route answers 503, and that is safe.

1. Generate the secret on your machine, and keep it only in Dokploy and in the App settings:

   ```sh
   openssl rand -hex 32
   ```

2. Dokploy → `web` → **Environment**, add, then **Deploy**:

   ```sh
   GITHUB_WEBHOOK_SECRET=<the 64 characters>
   ```

   The trusted bots are a setting of each org since REV-13 (section 15). The logs at startup show
   `startup.listening`, and no `startup.webhook_disabled`. Since REV-9 a repository gets jobs once an
   admin enables it on the Repos screen (section 12); before REV-9 it was `KENTO_REPOS`.
3. GitHub → organization `sakuga-software` → **Settings → Developer settings → GitHub Apps → Sakuga
   Review → General**:
   - **Webhook → Active**: on.
   - **Webhook URL**: `https://review.sakuga.dev/webhooks/github`
   - **Webhook secret**: the same 64 characters.
   - SSL verification: enabled.
   - **Save changes**.
4. Same App → **Permissions & events → Subscribe to events**: `Pull request`, `Issue comment`
   (`Installation` and `Installation repositories` need no box: GitHub always sends them to an
   App). Save. If GitHub asks the organization to accept a change of permissions, accept it.
5. **Advanced → Recent Deliveries**: the `ping` has the answer 200 `{"outcome":"pong"}`.

### Check the four steps of the ticket

1. Push a commit on an open pull request of `sakuga-software/sakuga-review`. Recent Deliveries shows
   `pull_request.synchronize` with 202 `{"outcome":"queued",…}`, and in the database:

   ```sql
   select pr_number, left(head_sha, 8), state, github_delivery_id from jobs order by created_at desc limit 5;
   ```

   gives one `queued` row with the head of the push.
2. Push again: the first row is `cancelled`, the new one `queued`.
3. A wrong signature: `curl -i -X POST https://review.sakuga.dev/webhooks/github -H 'X-GitHub-Event: ping' -H 'X-GitHub-Delivery: manual-1' -H 'X-Hub-Signature-256: sha256=00' -d '{}'`
   gives 401 `invalid signature`, and `jobs` has no new row.
4. Recent Deliveries → the delivery of step 2 → **Redeliver**: 202 `{"outcome":"duplicate",…}`, and
   no new row.

Rotate the secret: a new value in Dokploy and in the App settings, one right after the other. The
deliveries in between get 401; redeliver them from Recent Deliveries.

Turn it off: uncheck **Webhook → Active** in the App, or remove `GITHUB_WEBHOOK_SECRET` (503).

## 6. Runner API (REV-4)

The runners call `POST /api/runner/*` on the same domain. Deploy the release with REV-4 first: its
migration `0001_runners` adds the table `runners` and the columns `jobs.base_ref` and
`jobs.runner_id`. Without the variables below the API is closed (register: 401; claim: no job), and
that is safe.

1. The App « Sakuga Review » must have the permission **Repository contents: Read** (it has it for
   the reviews of the Action). The service asks GitHub for tokens with this permission only.
2. App settings → **General → Private keys → Generate a private key**. Keep the downloaded PEM only
   in Dokploy, then delete the file. Note the **App ID** at the top of the page.
3. Dokploy → `web` → **Environment**, add, then **Deploy**:

   ```sh
   KENTO_RUNNER_REGISTRATION_TOKEN=<openssl rand -hex 32>
   GITHUB_APP_ID=<App ID>
   GITHUB_APP_PRIVATE_KEY=<the PEM; on one line, write each new line as \n>
   KENTO_PROVIDER_API_KEY=<the OpenRouter key of the service, for the trusted runners>
   ```

   An invalid key stops the start with `startup.config_invalid` naming `GITHUB_APP_PRIVATE_KEY`,
   never its value.
4. Start the runner: [apps/runner/DEPLOY.md](../runner/DEPLOY.md).

Close the registration once the runners are registered: remove `KENTO_RUNNER_REGISTRATION_TOKEN`.
The registered runners keep working.

## 7. Publication of the reviews (REV-5)

The service publishes the review that a runner sends: the review with its score and its inline
comments, the block at the end of the description, the label `review: N/5` and the check
« Sakuga Review ». The format is the one of `review.yml`. No migration, and no new variable: the
publisher runs when `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set (section 6), and
`startup.listening` shows `"publisher":true`.

1. App settings → **Permissions & events → Repository permissions**:
   - **Contents: Read**, **Pull requests: Read and write**, **Issues: Read and write**: the App has
     them for the Action.
   - **Checks: Read and write**: new. Save, then accept the change of permissions in the
     organization (GitHub sends a request to its owners). Until then the review is published without
     its check, and each review logs `review.check_token_refused`.
2. Deploy the release with REV-5. The repository must be enabled (`KENTO_REPOS` before REV-9, the
   Repos screen since), and a runner must run
   (section 6).
3. Push a commit on an open pull request of the repository. In the logs, in order: `job.claimed`,
   `job.result`, `review.published` with the GitHub id of the review, its score, the number of inline
   comments and `"check":true`. On the pull request: a review of `kento-review[bot]` whose footer
   starts with `Kentō · Niveau`, its inline comments, the block of the description, the label and the
   check « Sakuga Review ».
4. While `.github/workflows/sakuga-review.yml` still reacts to `pull_request`, the pull request gets
   two reviews per push: the one of the Action and the one of Kentō. Compare them (step 4 of the
   ticket), then merge the pull request that removes the trigger.

What the publisher does not publish, on purpose, with the reason in `review.publication_skipped`:

- `superseded`: the head of the pull request moved since the job. The review of the new head
  replaces it, as a push cancelled the run of the Action.
- `closed`: the pull request is closed or merged.
- `suspended`: the installation of the App is suspended.

A failure before the review is posted (`review.publication_failed`: the token, the pull request,
the list of the threads) is tried again, three times per process, for 30 minutes. An error on one
thread only leaves that thread open (`publish.thread_failed`, or `publish.step_failed` for its
reply). The threads of the findings that are gone are closed only once the review is on GitHub. A failure after it (`publish.step_failed`: the dismissal, the description,
the label or the check) is not: the review is on GitHub, and a second one would repeat it. Each
review carries a hidden `<!-- kento:review <id> -->`: when the row could not be marked (a restart, a
lost connection), the next try finds that review on GitHub, marks the row and posts nothing again
(`publish.already_posted`).

```sql
select pr_number, left(head_sha, 8), score, published_at, github_review_id from reviews order by created_at desc limit 5;
```

`published_at` set with `github_review_id` null: a review that was skipped.

## 8. Expired leases and attempts (REV-6)

The release with REV-6 adds the migration `0002_job_retries` (column `jobs.not_before` and a partial
index on the leases of the running jobs; additive only) and changes the runner protocol: each job
carries an `attempt`, and the heartbeat and the result send it back.

1. Stop the runner first (`docker stop kento-runner` on `runners-host`). A runner of the earlier
   release would claim a job of the new service, refuse its message (`attempt` is a key it does not
   know) and log `runner.claim_failed`: the job would come back only after its lease, and each such
   claim spends one of its 2 attempts. The jobs queued while no runner runs just wait.
2. Deploy `web`. Its logs show `startup.migrations_applied`, and `/healthz` gives `"migrations":3`.
3. Publish the runner image of the same commit and recreate the runner
   ([apps/runner/DEPLOY.md](../runner/DEPLOY.md#1-publish-the-image)).
4. Check, with one runner and one open pull request:
   - push a commit, then `docker stop kento-runner` during the review. About 2 min later the web logs
     show `job.lease_expired` with `"state":"queued"`; start the runner again, and the job ends
     `done` with `attempts = 2`. One row in `reviews`.
   - stop it twice on the same job: the job ends `failed` with `failure_reason = 'lease expired 2 times'`.
   - push twice in a row during a review: the first job ends `cancelled`, the runner logs
     `job.cancelled_by_service` then `job.finished` with `"outcome":"cancelled"`, and only the new head
     gets a review.

## 9. Commands in the comments (REV-7)

The release with REV-7 adds two migrations, additive only: `0003_comment_commands` (columns
`jobs.github_comment_id`, unique, and `jobs.command_answered_at`) and `0004_resolutions` (table
`resolutions`). No new variable. The runner protocol gains a job kind `resolve`: a runner says in its
claim which kinds it runs, and a runner of an earlier release, which says nothing, gets review jobs
only. So the order web, then runner, is safe: resolve jobs wait in the queue until the new runner.

A new comment of an open pull request that starts with `@kento-review` or `@sakuga-review` is a command,
for the enabled repositories only (`KENTO_REPOS` before REV-9, the Repos screen since): another
repository keeps its commands in `review.yml`.

| Command | What it does |
| --- | --- |
| `@kento-review [lite\|balanced\|heavy]` | Queues a review of the current head at that level (`lite` by default; `@kento-review` alone is `lite`). |
| `@kento-review heavy force` | The same, even when the head already has a review at that level. |
| `@kento-review resolve [lite\|balanced\|heavy]` | Queues a resolve job: the model reads up to 20 open threads and 150 kB, answers in each, and the service resolves the threads that the code settled. |

The checks, in this order, with the reason in the logs (`webhook.ignored`, `command.not_allowed`,
`command.refused`, `command.accepted`):

- An edited comment, a comment of the App, or of a bot outside the trusted bots of the org: ignored.
- A person without `write`, `maintain` or `admin` on the repository: no job and no answer.
- A pull request from a fork: 😕 and a short reply.
- An unknown command: 😕 and the list of the commands.
- A head that already has a review at that level, queued, running or done (the lite review of the
  push counts): 😕 and a reply that names `force`. A failed or cancelled review does not count.
- A resolve while another resolve of the pull request is queued or running: 😕 and a reply. A
  resolve at a head that a resolve already answered costs nothing: the threads that carry its mark
  wait for a new push, and with no thread left the runner calls no model.
- Otherwise: one job, and 👀. After the publication of its review the comment gets 🚀; when the job
  fails, or a newer push cancels it, 😕.

A comment creates one job at most, whatever its deliveries: GitHub's « Redeliver » and a replay with
a new delivery id give `duplicate`. A reply goes only with a new reaction, so a redelivery posts no
second reply. When GitHub fails during the command (token, permission, pull request), the delivery
answers 500: send it again from **Advanced → Recent Deliveries**.

The resolve job, step by step:

- At the claim, the service reads the open threads with a token `pull_requests: read` of its own,
  and sends them in the job, cleaned. The runner clones with `contents: read` as for a review,
  builds the pack, calls the model, and tells for each thread whether its file changed since the
  thread. It writes nothing on GitHub.
- The publisher replies in each thread, resolves with a token `contents: write` + `pull_requests:
  write` asked for this repository at that moment, and posts the summary with the cost. It marks the
  row before it writes: a failure in the middle never posts twice (`resolve.publication_failed`, 😕).
- A thread of a person closes only when its file changed since the thread; a finding of the bot
  closes when the code fixed it or a reply settled it. Without `contents: write` the reply says that a
  person can resolve the thread (`resolve.write_token_refused`).

1. The App already has **Issue comment** in its events (section 5) and **Issues: Read and write**
   (section 7). For `resolve`: **Repository permissions → Contents: Read and write**, then accept the
   change in the organization. Until then resolve answers in each thread and resolves none.
2. Merge REV-7 (both pull requests), then deploy `web` at once: the second pull request removes
   `.github/workflows/sakuga-review.yml`, so between the merge and the deploy a command on this
   repository gets no answer, and never two. `/healthz` gives `"migrations":5`.
3. Publish the runner image of the same commit and recreate the runner
   ([apps/runner/DEPLOY.md](../runner/DEPLOY.md#1-publish-the-image)).
4. Check on a pull request of `sakuga-software/sakuga-review`:
   - `@kento-review heavy`: 👀 at once, then a review « Kentō · Niveau heavy » and 🚀.
   - `@sakuga-review resolve`: 👀, a reply in each open thread, the fixed threads resolved, a comment
     « Kentō · résolution des fils » with the cost, and 🚀.
   - the same comment again: 😕 and the reply about `force`; no second job.
   - `@kento-review frobnicate`: 😕 and the list of the commands.
   - a comment of an account without write access: no job, and `command.not_allowed` in the logs.

```sql
select level, state, left(head_sha, 8), github_comment_id, command_answered_at from jobs
where github_comment_id is not null order by created_at desc limit 5;
select pr_number, left(head_sha, 8), model, cost_usd, published_at from resolutions order by created_at desc limit 5;
```

## 10. GitHub sign-in of the screens (REV-8)

The screens of `review.sakuga.dev` sign in with the **user authorization of the GitHub App** « Sakuga
Review » (the same App, no OAuth App). Deploy the release with REV-8 first: its migration
`0005_users_sessions` adds the tables `users`, `memberships` and `sessions`. Without the variables
below, every screen leads to « Connexion indisponible », and nobody gets in: that is safe.

1. GitHub → organization `sakuga-software` → **Settings → Developer settings → GitHub Apps → Sakuga
   Review → General**:
   - **Callback URL**: add `https://review.sakuga.dev/auth/github/callback`.
   - **Expire user authorization tokens**: on (the default). Kentō uses the user token once and
     keeps none.
   - **Request user authorization (OAuth) during installation**: off.
   - **Client secrets → Generate a new client secret**. Copy it once; keep it only in Dokploy.
   - Note the **Client ID** at the top (`Iv23liesB1xzywavcnv2`).
   - **Save changes**.
2. Same App → **Permissions & events → Organization permissions → Members: Read-only**. Save. An owner
   of `sakuga-software` accepts the new permission (GitHub sends a mail; or **Settings → GitHub Apps →
   Sakuga Review → Review request**). Without it, nobody but the owner of a personal account can sign
   in, and the logs show `auth.sign_in_refused`.
3. Dokploy → `web` → **Environment**, add, then **Deploy**:

   ```sh
   KENTO_PUBLIC_URL=https://review.sakuga.dev
   GITHUB_APP_CLIENT_ID=Iv23liesB1xzywavcnv2
   GITHUB_APP_CLIENT_SECRET=<the client secret of step 1>
   KENTO_SESSION_SECRET=<openssl rand -hex 32>
   ```

   `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (section 6) are needed too: the service reads the role
   of a person with an installation token. A missing variable of the four stops the start with
   `startup.config_invalid` naming it. The log `startup.listening` shows `"signIn": true`.
4. Check, in this order:
   - Open `https://review.sakuga.dev/` in a private window: it goes to « Se connecter à Kentō ».
   - « Continuer avec GitHub » → GitHub asks to authorize « Sakuga Review » once → back on the
     dashboard, with `alex` and « Admin » at the bottom of the sidebar. The log has
     `auth.signed_in` with `sakuga-software:admin`.
   - A member of the org who is not an owner sees « Lecture seule » on every screen.
   - An account outside of `sakuga-software` comes back to « Accès refusé », and `users` has no row
     for it.

Rotate the session secret: put the new one first and keep the old one after a comma
(`KENTO_SESSION_SECRET=<new>,<old>`), deploy; remove the old one 7 days later. Removing it at once
signs everybody out, and that is the way to end every session now.

Remove a person: remove them from the org on GitHub. Their access ends within 10 minutes (the role is
read again from GitHub); `delete from users where login = '…'` ends it at once.

## 11. The Runners screen (REV-10)

The release with REV-10 adds the migration `0006_runner_registrations`, additive only: the table
`runner_registrations`, the columns `runners.org_id` and `repos.default_runner_pool`. No new
variable, and no change of the runner protocol: deploy `web`, and the runners keep running.
`/healthz` gives `"migrations":7`.

What changes:

- An admin of the org makes a registration token at `/runners` (« Nouveau runner »): name, labels,
  key mode. The token (`kento_reg_…`) is shown once with its `docker run`, works once, and ends after
  one hour; the database keeps only its SHA-256. The runner gets the org, the name, the labels and
  the trust of the token, whatever its environment says.
- A runner of an org runs the jobs of that org only. A runner registered with
  `KENTO_RUNNER_REGISTRATION_TOKEN` (no org, « Runner du service ») runs the jobs of every org, as
  before; the screen shows it, and only an operator changes it, in the database.
- `repos.default_runner_pool`: when set, the jobs of the repository go only to a runner with that
  label. Null (the default, and every existing row) changes nothing.
- « Marquer de confiance » / « Retirer la confiance »: the trust of a runner of the org, read again
  at each claim. « Révoquer… »: the token stops at the next call, and its running job goes back to
  the queue at once, without spending an attempt.
- A member of the org sees the screen, and no form. Every write needs the session, its CSRF token and
  a same-origin request.

Check, after the deploy (the steps of the ticket):

1. `/runners` → « Nouveau runner » → `mac-mini`, labels `macos`, « Clé de l’app » → copy the command,
   run it on the Mac mini. The card shows « En ligne » within 30 s. Publish the runner image with its
   version tag first ([apps/runner/DEPLOY.md](../runner/DEPLOY.md#1-publish-the-image)).
2. Set the pool of `sakuga-review` to its label, then push on a pull request: the job goes to
   `mac-mini` (`job.claimed` with its `runnerId`).

   ```sql
   update repos set default_runner_pool = 'macos' where full_name = 'sakuga-software/sakuga-review';
   ```

3. « Révoquer… » `mac-mini` during a job: the logs show `runner.revoked` with the job in `requeued`,
   then `runner.auth_refused` for its heartbeat and claim. Set the pool back to null (or to a label of
   `runners-host`): the job ends on `runners-host`.
4. Make a token and start nothing: one hour later its card says « Token expiré » with the help and
   « Nouveau token ».

`KENTO_RUNNER_REGISTRATION_TOKEN` is no longer needed for a new runner: remove it once
`runners-host` is registered (it keeps working without it).

## 12. The Repos screen (REV-9)

The release with REV-9 adds the migration `0007_repos_screen` (type `workflow_mode` and six nullable
columns of `repos`: `private`, `default_branch`, `workflow`, `workflow_path`, `workflow_ref`,
`workflow_checked_at`; additive only) and drops the variable `KENTO_REPOS`. `/healthz` gives
`"migrations":8`.

`repos.enabled` keeps its value: a repository that `KENTO_REPOS` enabled stays enabled
(`sakuga-software/sakuga-review` today), and every other one stays disabled. No data migration.

1. Deploy `web`. With `KENTO_REPOS` still set, the log shows `startup.kento_repos_ignored`: remove
   the variable in Dokploy → `web` → **Environment** (it changes nothing any more).
2. The App already has **Contents: Read** (section 7): the screen reads the list of the repositories
   and their `.github/workflows` with it. No new permission.
3. Check, signed in as an owner of `sakuga-software`:
   - `/repos` lists the repositories of the installation; « Actualiser » gives « Liste à jour. », and
     the log `repos.checked` with the number of repositories. `sakuga-review` shows « App Kentō »;
     a repository with `.github/workflows/sakuga-review.yml` shows `review.yml@stable`, `fruitback`
     and `boo` « copie de review.yml ».
   - The test of the ticket, on `orchard`: « Activer » (log `repos.enabled`), then push a commit on a
     pull request of orchard: a job, then a review « Kentō ». The pull request also gets the review
     of the Action while `review.yml` stays. « Désactiver », confirm (log `repos.disabled`), push
     again: no job, and the review stays on GitHub.
   - A member who is not an owner sees the list under « Lecture seule », with no button; a POST of
     theirs gets 403 (`repos.change_refused`).
   - A job that fails on orchard brings its counter back to 0/20, « remis à zéro après un échec ».

At 20/20, « Retirer review.yml » opens the deletion of the file on GitHub: the person commits it on a
branch and merges it like any change. Kentō never writes the repository itself.

## 13. The Config screen of a repository (REV-12)

The release with REV-12 adds the migration `0008_repo_config`, additive only: `orgs.config` and
`repos.config` (`jsonb`, default `{}`), `repos.config_version` (default 0), `config_updated_by`,
`config_updated_at`, and `jobs.config` (null on a job queued before it). `/healthz` gives one migration
more. No data migration: every repository starts at « config v0 », everything inherited, which is
the behaviour of the previous release (each push, the models of the engine, no limit).

**Deploy `web` before the runners.** A runner of this release sends `features: ['providers',
'models']` in its claim; a service of an earlier release refuses that claim (400). A runner of an
earlier release keeps working with this service: it gets no `models` key, runs the models of the
engine, and the log says `job.models_not_sent`.

What changes for the cost and the rights:

- An admin of the org (not a member) sets, per repository, the provider and the models of each
  level, the default level, the trigger (each push, « Ready for review » only, commands only), the
  paths, and a monthly limit of the automatic reviews. Every change is a POST under `cop()` and the
  CSRF token, logged as `repo_config.saved` / `repo_config.reset` with the login and the version.
- A limit stops only the automatic reviews (webhook outcome `skipped`, reason « monthly cost limit of
  the repository is reached »); a command `@kento-review` still runs: a person with the right to
  write asked for it.
- The paths read the files of the pull request on GitHub with a token `pull_requests: read` (the App
  already has it). When GitHub does not answer, the job is queued anyway.

Check, signed in as an owner of `sakuga-software`, on `orchard` (the tests of the ticket):

1. `/repos` → « Config » of orchard → « Provider et modèles »: set the model of `balanced` to
   `anthropic/claude-sonnet-5.5` (or another one), « Remplacer ici », then « Niveaux et passes » →
   `balanced`. Push a commit: the review that Kentō publishes names the model and OpenRouter in its
   footer.
2. « Revenir à l’org » on `balanced`: the next push takes the value of the org again.
3. « Déclenchement » → « Au passage en « Ready for review » »: a push on a draft creates no job, the
   passage to « Ready for review » creates one, and a later push none (webhook outcome `skipped`,
   « trigger of the config is ready »).

## 14. Providers and encrypted keys (REV-11)

The release with REV-11 adds the migration `0009_providers` (type `provider_kind`, table `providers`,
column `jobs.provider_id` with its index; additive only) and the variables `KENTO_SECRETS_KEY` and
`KENTO_SECRETS_PREVIOUS_KEYS`. `/healthz` gives `"migrations":10`. The threat model is in
[SECURITY.md](../../SECURITY.md).

An org without a provider keeps running on `KENTO_PROVIDER_API_KEY` as before: nothing changes until
an admin adds a provider.

Which provider a job uses: the one that the config of the repository or of the org chose for the
level (section 13, « Provider et modèles », which lists the providers of the org); `service` there
means `KENTO_PROVIDER_API_KEY`. With no choice in the config, the default provider of the org
(« Mettre par défaut » in `/settings`), else `KENTO_PROVIDER_API_KEY`.

1. **Generate the master key** on your machine: `openssl rand -base64 32`. Keep it in the password
   manager (« Kentō · KENTO_SECRETS_KEY »). Never paste it in a ticket, a chat or a commit.
2. **Dokploy** → `web` → **Environment**: add `KENTO_SECRETS_KEY=<the 44 characters>`. Save, then
   deploy `web`. The log shows `startup.secrets` with a `keyId` (not the key), and
   `startup.migrations_applied`. Without the variable, the log shows `startup.secrets_disabled` and the
   screen stores no key.
3. **Deploy the service before the runners.** A runner of this release sends `features` and
   `ownProvider` in its claim; an earlier service would refuse it. Then update `runners-host` to the
   image of this release (section 6). A runner of an earlier release keeps running the jobs of the
   orgs without a provider.
4. **Move `KENTO_PROVIDER_API_KEY` into a provider of `sakuga-software`** (optional, recommended):
   - signed in as an owner, `/settings` → « Ajouter un provider »: type OpenRouter, name
     « OpenRouter de Sakuga », the key of `KENTO_PROVIDER_API_KEY` (from the password manager, not
     from a log), models empty (the levels of today). « Ajouter le provider », then « Tester »: « Le
     provider a accepté la clé. » and the state « Valide ».
   - Check that a job runs with it: `@kento-review` on a pull request of `sakuga-review`; the log
     `job.claimed` has `"provider":{"id":…,"kind":"openrouter"}` and `"keyFromService":true`, and the
     provider shows « Valide · dernier appel il y a … ».
   - `KENTO_PROVIDER_API_KEY` then only serves the orgs that have no provider. Remove it from Dokploy
     once every org that should run on Sakuga's key has its own provider (today: only
     `sakuga-software`), and redeploy. Without it, the jobs of an org with no provider wait for a
     runner with its own key.
5. **The test of the ticket**, with an Anthropic key of Sakuga:
   - « Ajouter un provider »: type Anthropic, the key, models empty (Haiku 5.5, Sonnet 5.5, Opus 5.5).
     « Tester » → « Valide ». « Mettre par défaut » if OpenRouter is the default.
   - `@kento-review balanced` on a pull request of `sakuga-review`: the review is published, and its
     footer gives `claude-sonnet-5-5` and a cost (from the price table, `costSource: "table"`).
   - « Remplacer la clé » with a wrong key (`sk-ant-wrong-0000000000`), then `@kento-review`: the job
     fails with `the provider « … » refused its key (401): …`, the state shows « Refusée · 401 depuis
     9 h 40 » and a banner on top of the settings. Replace it with the right key: the banner goes.
   - `docker exec` into Postgres (or the Dokploy console):
     `select id, kind, key_last4, left(key_ciphertext, 24) from providers;` shows `v1:<key id>:…` and
     4 characters, never a key.
6. **Rotation of the master key**: see [SECURITY.md](../../SECURITY.md#the-master-key).

## 15. Settings of the org: cost limit, defaults, trusted bots, state of the App (REV-13)

The release with REV-13 adds the migration `0010_org_settings` and removes the variable
`KENTO_TRUSTED_BOTS`. `/healthz` gives `"migrations":11`.

What the migration does:

- `orgs`: `daily_cap_usd` and `monthly_cap_usd` (`numeric(10,2)`, null: no limit), `cap_alert_pct`
  (default 80), `trusted_bots` (`text[]`, default `{sakuga-agent[bot]}`), `settings_version`,
  `settings_updated_by`, `settings_updated_at`, and two checks (limits not negative, alert from 1 to
  100). Every existing org starts with no limit and trusts `sakuga-agent[bot]`: the behaviour of the
  previous release with the default of `KENTO_TRUSTED_BOTS`.
- A new table `webhook_deliveries`: one row per delivery that passed the signature (event, action,
  status, outcome), kept 30 days, for « Dernier événement » and « Échecs sur 24 h ».
- **Data migration**: the level of a repository becomes a key of its config, inherited from the org.
  A repository whose `default_level` is not `lite` gets `config.level` with the same value, so it keeps
  its level. The column stays and is still written: the previous release reads it after a rollback.

What changes for the cost and the rights:

- **Cost limit of the org.** An admin sets, in `/settings`, a limit per UTC day and per UTC month, and
  an alert threshold. The cost is the sum of the reviews and resolutions of every repository of the org.
  At a limit, a new job is not queued: a push answers 202 `capped` and its head gets the neutral check
  « Kentō · plafond » (« Plafond du jour atteint : pas de review », with the cost, the limit, and the
  hour when the reviews start again); a command `@kento-review …` gets 😕 and a reply. A job already queued or
  running finishes. The cost of a job is known only when it ends: the jobs queued just before the limit
  can take the cost a little over it. The daily limit of 10 $ of the OpenRouter key stays a second guard.
  The check has its own name: a required check « Sakuga Review » stays missing, and the pull request
  stays blocked until a review.
- **Trusted bots.** The list is in the database, one per org, edited in `/settings` by an admin.
  `KENTO_TRUSTED_BOTS` is not read any more.
- **Defaults of the org.** The level of a push and the provider and models of each level, inherited by
  the Config screen of each repository (« hérité de l’org »), which can replace them.
- **State of the App.** The screen reads `GET /app`, `GET /app/installations/{id}` and
  `GET /app/hook/config` with the JWT of the App (kept 5 minutes): no new permission.
- Every change is a POST under `cop()` and the CSRF token, for an admin only (a member gets 403 and
  reads the screen), logged as `org_settings.saved` / `org_settings.reset` with the login, the version,
  and for the limits and the bots the values before and after.

Steps:

1. Before the deploy, note the value of `KENTO_TRUSTED_BOTS` in Dokploy → `web` → **Environment** (if
   it is set and differs from `sakuga-agent[bot]`).
2. Deploy `web`. The logs show `startup.migrations_applied`, and `/healthz` gives `"migrations":11`.
   With `KENTO_TRUSTED_BOTS` still set, the log shows `startup.kento_trusted_bots_ignored` with its
   value.
3. Signed in as an owner of `sakuga-software`, `/settings` → « Bots de confiance »: put the bots of
   step 1 (one per line), « Enregistrer les bots ». Then remove `KENTO_TRUSTED_BOTS` from Dokploy →
   `web` → **Environment** and redeploy: `startup.kento_trusted_bots_ignored` is gone.
4. `/settings` → « Plafond de coût »: set the limits (for example 8 $ per day, the ticket's value, and a
   monthly limit), « Enregistrer le plafond ». The log `org_settings.saved` gives `before` and `after`.
5. « App GitHub » must say « Tout est en place ». Otherwise it names what is missing: a permission
   (App settings → **Permissions & events**, then accept it in the org), an event, or another webhook
   URL than `https://review.sakuga.dev/webhooks/github`.
6. The tests of the ticket:
   - Set the daily limit to `0,01`, push a commit on an open pull request of `sakuga-review`: no review,
     Recent Deliveries shows 202 `{"outcome":"capped",…}`, and the pull request has the check
     « Kentō · plafond » with « Plafond du jour atteint ». The settings show the red banner. Set `8`
     again and push: a job, then a review.
   - Add `renovate[bot]` to the trusted bots: the next pull request or push of Renovate on `orchard`
     gets a review (orchard enabled on the Repos screen).
   - « Dernier push ou PR » shows the `pull_request.synchronize` of the last push, with its time.
7. Rollback: the previous release runs on the new schema (the columns only add, `default_level` is
   still written). It reads `KENTO_TRUSTED_BOTS` again, and has no cost limit of the org: put the
   variable back before a rollback if the trusted bots differ from the default.

## 16. The dashboard (REV-14)

The release with REV-14 adds the migration `0011_dashboard_indexes`: three indexes, additive only —
`reviews (repo_id, created_at)`, `resolutions (repo_id, created_at)`, and `jobs (repo_id, finished_at)`
where `state = 'failed'`. `/healthz` gives `"migrations":12`. The migration runs in the transaction of
the migrator and holds a `SHARE` lock on the three tables while it builds them: writes of results and
of new jobs wait until it ends (milliseconds on the tables of today; on a database of 600 000 jobs and
456 000 reviews, the migration took 0,3 s).

The home screen `/` is now the dashboard of the org on screen: a member reads it; an admin can also
« Relancer en <niveau> » the last failed review (`POST /jobs/:id/retry`, under `cop()` and the CSRF
token, logged as `dashboard.retry`). A retry queues a review of the same head and base branch, with the
config of today; like a command, it skips the trigger, the paths and the monthly limit of the
repository, but not the cost limit of the org (section 15): at the limit, nothing is queued. It first reads the pull request on GitHub (installation token `pull_requests: read`):
it is refused when the pull request is closed, when its head on GitHub or a newer job is another
commit, when GitHub does not answer, or when a review of that level is already queued or running on
the head.

The cost of the day and of the month is the sum of `reviews.cost_usd` and `resolutions.cost_usd` of
the repositories of the org since 00:00 UTC (the first of the month, UTC), per provider of the job.
The limits and the alert threshold are those of the settings of the org (section 15); the totals are
`readOrgCosts` of `app/org-settings/costs.ts`, the same as the settings screen.

Check, signed in as an owner of `sakuga-software`:

1. `/`: the reviews of the week, the last reviews, the queue and the runners match the database
   (`select state, count(*) from jobs group by 1;`).
2. The cost of the day equals
   `select sum(cost_usd) from reviews where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';`
   plus the same sum on `resolutions`.
3. Stop the runner twice during a job (section 11): after the second expired lease, the banner says
   « le bail a expiré deux fois sur <runner> ». « Relancer en balanced » queues a job; the banner says
   « Relance en balanced en file », and goes away when its review is published.

## 17. Comment of a failed job (REV-35)

The release with REV-35 adds the migration `0012_failure_notice`: the column
`jobs.failure_noticed_at`, additive only. `/healthz` gives `"migrations":13`. No new variable.

A job that fails for good (a failed result, the expired lease of its last attempt, or a job that its
runner gives back at its last attempt) used to leave
no trace on the pull request, except 😕 on the comment of a command. Now the publisher posts one
comment on the pull request for each failed review or resolve job: the level, the commit, the first
line of `jobs.failure_reason` (300 characters at most, the keys and the long tokens masked), the
command that runs it again, and a link to the Config screen of the repository when
`KENTO_PUBLIC_URL` is set. For a command, the comment names its author, and the comment of the
command still gets 😕. The comment carries a hidden `<!-- kento:failure <job id> -->`.

The publisher marks the job before it posts, so a job gets one comment at most, and only one try.
In the logs:

- `job.failure_noticed`: the comment is on the pull request.
- `job.failure_notice_skipped`, with `reason` `closed` or `superseded`: the pull request is closed, or
  a newer push moved its head. The job is marked, with no comment.
- `job.failure_notice_failed` (warn): GitHub refused the token, the pull request or the comment. The
  job is marked and gets no second try.
- `job.failure_commenter_unknown` (warn): the comment of the command is gone; the comment names nobody.

Only a failure of the last 30 minutes gets a comment, so the deploy posts nothing for older failures.
A failed result does not wake the publisher: the comment comes with its next run, within 30 seconds.
A cancelled job, or a job of a suspended installation, gets no comment. The test is
`apps/web/test/db/failure-notice.test.ts`.

Check: on a pull request of a test repository, set a model that the provider does not know on its
Config screen, push a commit, and wait for the failure. The pull request gets « Kentō · review en
échec » with the 404 of the provider, and the logs `job.failure_noticed`.

```sql
select level, state, left(head_sha, 8), left(failure_reason, 80), failure_noticed_at from jobs
where state = 'failed' order by finished_at desc limit 5;
```

## 18. Retention of the jobs, reviews and resolutions (REV-38)

No migration, no new variable. Each instance deletes, once an hour and once at its start, the jobs
that ended (`done`, `failed`, `cancelled`) and were created more than 180 days ago, 2 000 per
statement. Their review or resolution goes with them (`on delete cascade`). A finding or a finding
event that names such a review keeps its row, with its review set to null (`on delete set null`).

What stays, whatever its age:

- the queued and running jobs;
- for each repository, the jobs of its last 20 published reviews and its last failed job: the Repos
  screen reads them for the streak, its reset and the last review;
- the findings and their events, the rules, the repositories and their settings.

What goes, after 180 days: the summary, the findings JSON, the score, the model and the cost of each
review; the verdicts of each resolution; the config, the rules sent and the failure reason of each job.
The screens read at most a month (costs, cap), a week (dashboard chart) or the last rows above, so
none of them changes. Two things can read further back: the dashboard, for a failed job, shows the
previous score of its pull request and averages the cost of the last 20 reviews of a level; past 180
days they show nothing, as for a new repository.

Volume measured on a local database with 200 000 jobs and 180 000 reviews (150 000 of them older than
180 days): the first purge deletes 150 000 jobs in 13.7 s (75 statements of about 180 ms), the next
one finds nothing in 10 ms. The tables go from 159 MB to 110 MB after `VACUUM` (the space is reused
by the next rows, not given back to the disk), and to 63 MB after `VACUUM FULL`. Steady state: 180
days of reviews, about 200 MB at 1 000 reviews a day.

In the logs: `jobs.purged` with `deleted` and `durationMs` when a run deleted something,
`jobs.purge_failed` (error) when the database refused it; the next run tries again.

```sql
select count(*) filter (where created_at < now() - interval '180 days') as older, count(*) from jobs;
```

## 19. Each later deployment

- Automatic deployment on a push to `main` is a choice for Alex (Dokploy → `web` → **Auto Deploy**).
  Without it, deploy by hand after each merge that touches `apps/web`.
- A migration runs while the previous container still serves: it must keep that release working
  (see [README.md](README.md#migrations)).
- Roll back: Dokploy → `web` → **Deployments** → redeploy the previous one. A rollback does not undo a
  migration. The migrations only add, so the previous release still runs on the newer schema.
