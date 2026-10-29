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
   KENTO_REPOS=sakuga-software/sakuga-review
   ```

   `KENTO_TRUSTED_BOTS` defaults to `sakuga-agent[bot]`. The logs at startup show
   `startup.listening` with `kentoRepos`, and no `startup.webhook_disabled`.
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
2. Deploy the release with REV-5. `KENTO_REPOS` must hold the repository, and a runner must run
   (section 6).
3. Push a commit on an open pull request of the repository. In the logs, in order: `job.claimed`,
   `job.result`, `review.published` with the GitHub id of the review, its score, the number of inline
   comments and `"check":true`. On the pull request: a review of `sakuga-review[bot]` whose footer
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

A new comment of an open pull request that starts with `@kento` or `@sakuga-review` is a command,
for the repositories of `KENTO_REPOS` only: another repository keeps its commands in `review.yml`.

| Command | What it does |
| --- | --- |
| `@kento review [lite\|balanced\|heavy]` | Queues a review of the current head at that level (`lite` by default; `@kento` alone is `lite`). |
| `@kento review heavy force` | The same, even when the head already has a review at that level. |
| `@kento resolve [lite\|balanced\|heavy]` | Queues a resolve job: the model reads up to 20 open threads and 150 kB, answers in each, and the service resolves the threads that the code settled. |

The checks, in this order, with the reason in the logs (`webhook.ignored`, `command.not_allowed`,
`command.refused`, `command.accepted`):

- An edited comment, a comment of the App, or of a bot outside `KENTO_TRUSTED_BOTS`: ignored.
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
   - `@kento review heavy`: 👀 at once, then a review « Kentō · Niveau heavy » and 🚀.
   - `@sakuga-review resolve`: 👀, a reply in each open thread, the fixed threads resolved, a comment
     « Kentō · résolution des fils » with the cost, and 🚀.
   - the same comment again: 😕 and the reply about `force`; no second job.
   - `@kento frobnicate`: 😕 and the list of the commands.
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

## 11. Each later deployment

- Automatic deployment on a push to `main` is a choice for Alex (Dokploy → `web` → **Auto Deploy**).
  Without it, deploy by hand after each merge that touches `apps/web`.
- A migration runs while the previous container still serves: it must keep that release working
  (see [README.md](README.md#migrations)).
- Roll back: Dokploy → `web` → **Deployments** → redeploy the previous one. A rollback does not undo a
  migration. The migrations only add, so the previous release still runs on the newer schema.
