# Deploy apps/web

The installation guide of the Kentō web service on `review.sakuga.dev`, as it is today. It describes
the end state: follow it from the top for a new installation, and use sections 8 and 9 for each
later deployment. What each release changed, with its migration and its checks, is in
[CHANGELOG.md](CHANGELOG.md).

The agents do not touch Dokploy or production. A person with access to Dokploy, to the DNS and to the
settings of the GitHub App runs these steps.

Target: Dokploy on `prod-host`, one application `web` and one database `postgres`, in a project
named `Kentō`. The runners are a separate service: [apps/runner/DEPLOY.md](../runner/DEPLOY.md).

## 1. Prerequisites

- Access to Dokploy on `prod-host`, and to the zone `sakuga.dev` at Gandi.
- An owner of the GitHub organization `sakuga-software`: the GitHub App « Sakuga Review » (client id
  `Iv23liesB1xzywavcnv2`, bot `kento-review[bot]`) belongs to it, and its owners accept each change of
  its permissions.
- `openssl` on your machine, to make the secrets.
- A password manager. Each secret below lives there and in Dokploy, and nowhere else: never in a
  ticket, a chat, a commit or a log.
- For the reviews: an OpenRouter key of the service, or a provider of the org added on the Settings
  screen after the installation (section 7, step 6).

## 2. Postgres

1. Dokploy > project `Kentō` (create it if needed) > **Create service > Database > PostgreSQL**.
2. Name `postgres`, image `postgres:18`, database `kento`, user `kento`. Let Dokploy generate the
   password, and keep it only in Dokploy.
3. No external port. The application reaches the database on the internal network of Dokploy.
4. Deploy it. Note the **internal host** that Dokploy shows on the database page.
5. Turn on the daily backup of the database (Dokploy > database > **Backups**) to the S3 destination
   of the other projects.

## 3. The GitHub App

Kentō uses the existing App « Sakuga Review ». Its settings are under GitHub > organization
`sakuga-software` > **Settings > Developer settings > GitHub Apps > Sakuga Review**.

### Permissions

**Permissions & events**:

| Permission | Access | What needs it |
| --- | --- | --- |
| Repository: Contents | Read and write | Read: the clone of a job, the files of `.github/workflows` on the Repos screen. Write: a resolve job resolves the threads that the code settled. With Read only, it answers in each thread and resolves none. |
| Repository: Pull requests | Read and write | The review, its inline comments and threads, the block of the description, the files of a pull request for the paths of a config. |
| Repository: Issues | Read and write | The label `review: N/5`, the reactions and the replies to a command, the comment of a failed job. |
| Repository: Checks | Read and write | The check « Sakuga Review », and « Kentō · plafond » at the cost limit. Without it, the review is published without its check (`review.check_token_refused`). |
| Organization: Members | Read-only | The role of a person who signs in (`admin` or `member`). Without it, nobody but the owner of a personal account can sign in (`auth.sign_in_refused`). |

Save. GitHub then asks the owners of the organization to accept the change: accept it
(**Settings > GitHub Apps > Sakuga Review > Review request**).

### Events

**Subscribe to events**: `Pull request` and `Issue comment`. Save. `Installation` and
`Installation repositories` need no box: GitHub always sends them to an App.

### Webhook

**General > Webhook**:

- **Active**: on.
- **Webhook URL**: `https://review.sakuga.dev/webhooks/github`.
- **Webhook secret**: the value of `GITHUB_WEBHOOK_SECRET` (section 4).
- **SSL verification**: enabled.

### Sign-in of the screens

The screens sign in with the user authorization of this App (no OAuth App). **General**:

- **Callback URL**: `https://review.sakuga.dev/auth/github/callback`.
- **Expire user authorization tokens**: on (the default). Kentō uses the user token once and keeps
  none.
- **Request user authorization (OAuth) during installation**: off.
- **Client secrets > Generate a new client secret**: the value of `GITHUB_APP_CLIENT_SECRET`. GitHub
  shows it once.

### Private key

**General > Private keys > Generate a private key**: the downloaded PEM is the value of
`GITHUB_APP_PRIVATE_KEY`. Put it in Dokploy, then delete the file. Note the **App ID** at the top of
the page: the value of `GITHUB_APP_ID`.

## 4. Environment variables

Dokploy > `web` > **Environment**. The service reads them once at startup. A missing or invalid
value stops the process before it listens, with `startup.config_invalid` and the name of the
variable, never its value; the previous container keeps serving.

Make each secret on your machine: `openssl rand -hex 32` for the webhook, registration and session
secrets, `openssl rand -base64 32` for `KENTO_SECRETS_KEY`.

### For a working service

| Variable | Required | Example | Effect |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | `postgresql://kento:<password>@<internal host>:5432/kento` | The database. A secret. |
| `GITHUB_WEBHOOK_SECRET` | for the webhook | 64 hex characters | Checks the signature of each delivery; 32 characters or more. Without it, `/webhooks/github` answers 503 and nothing is queued. A secret. |
| `GITHUB_APP_ID` | for the jobs | `1234567` | With the private key: the installation token of each job, the publication of the reviews, the role of a person, the state of the App. Without them, a claim gives no job and nothing is published. |
| `GITHUB_APP_PRIVATE_KEY` | for the jobs | the PEM on one line, each new line written `\n` | The private key of the App. It never leaves the service. An invalid key stops the start. A secret. |
| `KENTO_PUBLIC_URL` | for the sign-in | `https://review.sakuga.dev` | The origin as the browser sees it: the callback URL, the expected `Origin` of a form, the `Secure` cookie. `http://` only on `localhost` or `127.0.0.1`. Also the link to the Config screen in the comment of a failed job. |
| `GITHUB_APP_CLIENT_ID` | for the sign-in | `Iv23liesB1xzywavcnv2` | The client of the user authorization. |
| `GITHUB_APP_CLIENT_SECRET` | for the sign-in | from section 3 | A secret. |
| `KENTO_SESSION_SECRET` | for the sign-in | 64 hex characters | Signs the session cookie; 32 characters or more. Comma-separated during a rotation (section 9). A secret. |
| `KENTO_SECRETS_KEY` | to store provider keys | 44 base64 characters | The master key of the keys of the providers (AES-256-GCM). Without it, the Settings screen stores no key (`startup.secrets_disabled`). See [SECURITY.md](../../SECURITY.md#the-master-key). A secret. |
| `KENTO_PROVIDER_API_KEY` | no | an OpenRouter key | The key of the service, for the jobs of an org that has no provider. Sent with a job only to a trusted runner with no key of its own. A secret. |

The sign-in needs its four variables together, plus `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`.
Without them, every screen says « Connexion indisponible » and nobody gets in.

### Optional

| Variable | Default | Effect |
| --- | --- | --- |
| `DATABASE_POOL_MAX` | `10` | The connections of the pool, 1 to 100. The migrations at startup use one more, closed before the server listens. |
| `HOST` | `0.0.0.0` | The address the server listens on. |
| `PORT` | `3000` | The port the server listens on. Keep 3000: the domain of section 5 points to it. |
| `MIGRATE_ON_START` | `true` | Apply the pending migrations before listening. Keep `true`. |
| `APP_COMMIT` | none | The commit shown by `/healthz`. Set it with the build argument of the same name (section 5). |
| `KENTO_RUNNER_REGISTRATION_TOKEN` | none | Registers a runner of the service with `POST /api/runner/register`; 32 characters or more. Not needed when the runners are made on the Runners screen. A secret. |
| `KENTO_SECRETS_PREVIOUS_KEYS` | none | Earlier master keys, comma-separated, during a rotation only. A secret. |
| `GITHUB_API_URL` | `https://api.github.com` | The GitHub API, for GitHub Enterprise Server (`https://<host>/api/v3`) or a local test. |
| `GITHUB_URL` | the server of `GITHUB_API_URL` | The server where the runners clone, HTTPS only, on the server of `GITHUB_API_URL`. |
| `KENTO_BOT_LOGIN` | `kento-review[bot]` | The login of the App: the publisher finds its threads and reviews with it. |
| `KENTO_APP_SLUG` | `KENTO_BOT_LOGIN` without `[bot]` | The slug of the App, for the install link of the page « Accès refusé ». |

`KENTO_REPOS` and `KENTO_TRUSTED_BOTS` are not read any more: the Repos screen and the settings of
the org replaced them. When one is still set, the log at startup says `startup.kento_repos_ignored`
or `startup.kento_trusted_bots_ignored`: remove it.

## 5. The application

1. Project `Kentō` > **Create service > Application**, name `web`.
2. **Provider**: GitHub, repository `sakuga-software/sakuga-review`, branch `main`.
3. **Build type**: Dockerfile. Dockerfile path `apps/web/Dockerfile`, Docker context path `.` (the
   root of the repository: the pnpm workspace and its lockfile live there).
4. **Build arguments** (optional): `APP_COMMIT=<commit>` puts the commit in `/healthz`. Without it,
   `/healthz` gives `"commit": null` and only the version.
5. **Environment**: the variables of section 4.
6. **Domains**: `review.sakuga.dev`, container port `3000`, HTTPS with Let's Encrypt.
7. **DNS** (Gandi, zone `sakuga.dev`): a record `review` to `prod-host`, the same way as the other
   services of that host. Wait until `dig +short review.sakuga.dev` gives the address of the host.
8. Deploy.

The image has a `HEALTHCHECK` on `/healthz` (every 30 s, 3 failures). Swarm replaces a container that
stays unhealthy, and a new container that does not become healthy does not replace the old one.

## 6. Migrations

The service applies the SQL files of `apps/web/drizzle/` at startup, before it listens: in one
transaction, under an advisory lock (two instances that start together migrate one after the other).
A migration already applied is skipped, and a redeploy applies nothing twice.

- `/healthz` gives `database.migrations`, the number of applied migrations. It equals the number of
  `.sql` files in `apps/web/drizzle/` of the deployed commit (16 on 2026-10-30, `0000_init` to
  `0015_findings_rule_fk`).
- A migration runs while the previous container still serves, so each one only adds: a column with
  a default or nullable, a table, an index. A rollback does not undo a migration, and the previous
  release still runs on the newer schema.
- `startup.migrations_failed` gives the error of the database. The process stops before it listens,
  and the previous container keeps serving.
- How to write one: [README.md](README.md#migrations).

## 7. Checks after a deployment

1. **Logs**, Dokploy > `web` > **Logs**, in order:

   ```json
   {"level":"info","event":"startup.migrations_applied","durationMs":…}
   {"level":"info","event":"startup.listening","host":"0.0.0.0","port":3000,"version":"…","publisher":true,"signIn":true,…}
   ```

   `startup.secrets` shows the `keyId` of the master key (never the key). No `startup.webhook_disabled`.
2. **Health**:

   ```sh
   curl -sS https://review.sakuga.dev/healthz
   # 200 {"status":"ok","version":"…","commit":…,"database":{"status":"ok","latencyMs":…,"migrations":16}}
   ```

3. **Webhook**: the App > **Advanced > Recent Deliveries**. The `ping` has the answer 200
   `{"outcome":"pong"}`. A wrong signature is refused:

   ```sh
   curl -i -X POST https://review.sakuga.dev/webhooks/github -H 'X-GitHub-Event: ping' \
     -H 'X-GitHub-Delivery: manual-1' -H 'X-Hub-Signature-256: sha256=00' -d '{}'
   # 401 invalid signature
   ```

4. **Sign-in**, in a private window:
   - `https://review.sakuga.dev/` goes to « Se connecter à Kentō ».
   - « Continuer avec GitHub » opens GitHub, which asks once to authorize « Sakuga Review ». It then
     comes back to the dashboard, with your login and « Admin » at the bottom of the sidebar. The log
     has `auth.signed_in`.
   - A member of the org who is not an owner sees « Lecture seule » on every screen. An account
     outside the org gets « Accès refusé », and `users` has no row for it.
5. **State of the App**: `/settings` > « App GitHub » says « Tout est en place ». Otherwise it names
   what is missing: a permission or an event (section 3, then accept it in the org), or another
   webhook URL.
6. **A provider** (once): `/settings` > « Ajouter un provider », its key, then « Tester »: « Le
   provider a accepté la clé. » An org with no provider runs on `KENTO_PROVIDER_API_KEY`.
7. **A runner**: start one as [apps/runner/DEPLOY.md](../runner/DEPLOY.md) says. The Runners screen
   shows it « En ligne » within 30 s.
8. **A repository**: `/repos` lists the repositories of the installation. « Activer » on one of them.
9. **A review, end to end**: push a commit on an open pull request of that repository. The logs show
   `job.claimed`, `job.result`, then `review.published` with `"check":true`. On the pull request: a
   review of `kento-review[bot]` whose footer starts with `Kentō · Niveau`, its inline comments, the
   block of the description, the label `review: N/5` and the check « Sakuga Review ».
10. **A command**: `@kento-review heavy` in a comment of the pull request gets 👀, then a review
    « Niveau heavy », then 🚀. `@kento-review resolve` answers in the open threads and posts
    « Kentō · résolution des fils ».

The state of the queue, from the database:

```sql
select state, count(*) from jobs group by 1;
select pr_number, left(head_sha, 8), score, published_at, github_review_id from reviews order by created_at desc limit 5;
```

## 8. Each later deployment

1. Read the entries of [CHANGELOG.md](CHANGELOG.md) since the deployed release: a release that adds
   a variable, a permission of the App or a step before the runners says so there.
2. Deploy `web` (Dokploy > `web` > **Deploy**). Automatic deployment on a push to `main` is a choice
   for Alex (Dokploy > `web` > **Auto Deploy**). Without it, deploy by hand after each merge that
   touches `apps/web`.
3. Check steps 1 and 2 of section 7: the version, and the number of migrations.
4. **The service before the runners.** A runner of a new release can send a claim that an older
   service refuses (400). A runner of the previous release keeps working with the new service. Then
   publish the runner image of the same commit and update the runners
   ([apps/runner/DEPLOY.md](../runner/DEPLOY.md#1-publish-the-image)).

**Roll back**: Dokploy > `web` > **Deployments**, redeploy the previous one. It does not undo a
migration, and the previous release runs on the newer schema. Read the entry of the release in
[CHANGELOG.md](CHANGELOG.md) first: a release that removed a variable may need it back.

## 9. Operations

### Rotate a secret

- **Webhook secret**: a new value in Dokploy, deploy, then the same value in the App settings, one
  right after the other. The deliveries in between get 401: redeliver them from **Recent
  Deliveries**.
- **Session secret**: put the new one first and keep the old one after a comma
  (`KENTO_SESSION_SECRET=<new>,<old>`), deploy, and remove the old one 7 days later. Removing it at
  once signs everybody out: that is the way to end every session now.
- **Master key of the provider keys**: [SECURITY.md](../../SECURITY.md#the-master-key)
  (`KENTO_SECRETS_PREVIOUS_KEYS`, then `node app/providers/rotate-keys.ts --apply`).
- **Private key of the App**: generate a new key in the App settings, put it in Dokploy, deploy, then
  delete the old key in the App settings.
- **OpenRouter key of the service**: replace `KENTO_PROVIDER_API_KEY` and deploy. The key of a
  provider of an org is replaced on the Settings screen (« Remplacer la clé »).

### Cost limit

The limits of an org are on `/settings` > « Plafond de coût », for an admin: per UTC day, per UTC
month, and an alert threshold. At a limit, a push queues nothing (202 `capped`) and its head gets the
neutral check « Kentō · plafond »; a command gets 😕 and a reply. A job already queued or running
finishes. A repository can also have a monthly limit of its automatic reviews on its Config screen.
The daily limit of the OpenRouter key stays a second guard.

### Repositories, runners and people

- **Enable or disable a repository**: `/repos`, « Activer » or « Désactiver ». A disabled repository
  gets no job; its queued jobs are cancelled.
- **Trusted bots** (bots whose pull requests and commands count as a person's): `/settings` > « Bots
  de confiance ».
- **A new runner**: `/runners` > « Nouveau runner » gives a token that works once, for one hour. See
  [apps/runner/DEPLOY.md](../runner/DEPLOY.md).
- **Revoke a runner**: `/runners` > « Révoquer… ». Its token stops at the next call, and its running
  job goes back to the queue without spending an attempt.
- **Remove a person**: remove them from the org on GitHub. Their access ends within 10 minutes;
  `delete from users where login = '…'` ends it at once.

### Turn off the webhook

Uncheck **Webhook > Active** in the App, or remove `GITHUB_WEBHOOK_SECRET` and deploy (503). No job
is queued, and the deliveries can be sent again from **Recent Deliveries** later.

### Retention

Each instance deletes, once an hour and at its start, the jobs that ended more than 180 days ago,
with their review or resolution. It keeps the queued and running jobs, the jobs of the last 20
published reviews and the last failed job of each repository, the findings and their events, and
the rules. The logs say `jobs.purged` (with `deleted` and `durationMs`) or `jobs.purge_failed`; the
next run tries again.

```sql
select count(*) filter (where created_at < now() - interval '180 days') as older, count(*) from jobs;
```

## 10. Logs in Grafana

1. <https://grafana.sakuga.dev> > **Explore** > the Loki source.
2. Look for the lines of the service, for example `{host="prod-host"} |= "startup.listening"`, and
   note the labels of the line.
3. If the line has no `project` / `app` labels, the Alloy collector of the host does not know the
   service yet. Add it as the monitoring runbook of the host describes
   (`/home/mheos/monitoring/README.md` on `prod-host`): a rule on the name of the Swarm service
   that sets `project="Kentō"` and `app="web"` (and `app="postgres"` for the database), then reload
   Alloy.
4. Check: `{project="Kentō", app="web"}` shows the `startup.*` lines.

Useful queries:

```logql
{project="Kentō", app="web"} | json | level="error"
{project="Kentō", app="web"} | json | event="http.request" | status >= 500
{project="Kentō", app="web"} | json | event=~"review.publication_failed|job.failure_notice_failed|jobs.purge_failed"
```

The events that need a person:

| Event | Meaning |
| --- | --- |
| `startup.config_invalid`, `startup.migrations_failed` | The new container did not start; the previous one serves. |
| `review.check_token_refused` | The App lacks **Checks: Read and write** (section 3). |
| `resolve.write_token_refused` | The App lacks **Contents: Read and write**: resolve answers and resolves no thread. |
| `auth.sign_in_refused` | The App lacks **Members: Read-only**, or the person is not in the org. |
| `review.publication_failed` | GitHub refused the publication; tried again three times per process, for 30 minutes. |
| `job.failure_notice_failed` | The comment of a failed job could not be posted. |
| `job.lease_expired` with `"state":"failed"` | A job lost its runner twice. |
| `jobs.purge_failed` | The database refused the purge of the old jobs. |
