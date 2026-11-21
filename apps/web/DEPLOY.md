# Deploy apps/web

How to run the Kentō web service on your own infrastructure. Follow it from the top for a new
installation, and use sections 8 and 9 for each later deployment. What each release changed, with
its migration and its checks, is in [CHANGELOG.md](CHANGELOG.md).

The examples use `https://kento.example.com` for the service: put your own domain in its place.

The service is one container (`apps/web/Dockerfile`) and one Postgres database. The runners, which
call the model, are separate containers: [apps/runner/README.md](../runner/README.md) for a runner of
an organization, [apps/runner/DEPLOY.md](../runner/DEPLOY.md) for the runners of the service. To
run the service, its database and one runner on a single machine, the root of the repository has a
`compose.yaml` and a `.env.example`: copy `.env.example` to `.env`, fill it in with sections 3 and
4, then `docker compose up -d --build`.

## 1. Prerequisites

- A host that runs containers, and a domain whose HTTPS reaches port 3000 of the service: a reverse
  proxy with TLS, or a platform that gives one. GitHub sends the webhook over HTTPS only.
- Postgres 18.
- A GitHub account or organization that owns the GitHub App of section 3.
- `openssl`, to make the secrets.
- A secret store. Each secret below lives there and in the environment of the service, and nowhere
  else: never in a ticket, a chat, a commit or a log.
- For the reviews: a key of the service for a model provider (OpenRouter by default), or a provider
  of the org added on the Settings screen after the installation (section 7, step 6).

## 2. Postgres

1. Create a database `kento` and a user `kento` that owns it, with a generated password.
2. Do not publish its port: the service reaches it on a private network.
3. Back it up every day. The database holds the settings, the jobs, the reviews, the findings and
   the encrypted keys of the providers.

## 3. The GitHub App

Kentō posts on GitHub as a GitHub App. Create one under **Settings > Developer settings > GitHub
Apps > New GitHub App** of your account or organization, with the permissions, the events, the
webhook and the callback below. Then set `KENTO_BOT_LOGIN` to `<slug of your App>[bot]` (section 4).
`KENTO_COMMAND_NAMES` does not follow `KENTO_BOT_LOGIN`: set it to the slug of your App too, or the
commands stay `@kento-review`.

For **Where can this GitHub App be installed?**, choose **Only on this account**, unless other
accounts must install it. In that case, set `KENTO_ALLOWED_ORGS` (section 4).

### Permissions

**Permissions & events**:

| Permission | Access | What needs it |
| --- | --- | --- |
| Repository: Contents | Read and write | Read: the clone of a job, the files of `.github/workflows` on the Repos screen. Write: a resolve job resolves the threads that the code settled. With Read only, it answers in each thread and resolves none. |
| Repository: Pull requests | Read and write | The review, its inline comments and threads, the block of the description, the files of a pull request for the paths of a config. |
| Repository: Issues | Read and write | The label `review: N/5`, the reactions and the replies to a command, the comment of a failed job. |
| Repository: Checks | Read and write | The check of a review (`KENTO_CHECK_NAME`), and "Kentō · cap" at the cost limit. Without it, the review is published without its check (`review.check_token_refused`). |
| Organization: Members | Read-only | The role of a person who signs in (`admin` or `member`). Without it, nobody but the owner of a personal account can sign in (`auth.sign_in_refused`). |

Save. When the App is installed on an organization, GitHub asks its owners to accept each change of
the permissions: accept it (**Settings > GitHub Apps > your App > Review request**).

### Events

**Subscribe to events**: `Pull request`, `Issue comment` and `Pull request review comment` (the
`reject` command in the thread of a finding). Save. `Installation` and `Installation repositories`
need no box: GitHub always sends them to an App.

### Webhook

**General > Webhook**:

- **Active**: on.
- **Webhook URL**: `https://kento.example.com/webhooks/github`.
- **Webhook secret**: the value of `GITHUB_WEBHOOK_SECRET` (section 4).
- **SSL verification**: enabled.

### Sign-in of the screens

The screens sign in with the user authorization of this App (no OAuth App). **General**:

- **Callback URL**: `https://kento.example.com/auth/github/callback`.
- **Expire user authorization tokens**: on (the default). Kentō uses the user token once and keeps
  none.
- **Request user authorization (OAuth) during installation**: off.
- **Client ID**: the value of `GITHUB_APP_CLIENT_ID`.
- **Client secrets > Generate a new client secret**: the value of `GITHUB_APP_CLIENT_SECRET`. GitHub
  shows it once.

### Private key

**General > Private keys > Generate a private key**: the downloaded PEM is the value of
`GITHUB_APP_PRIVATE_KEY`. Put it in your secret store, then delete the file. Note the **App ID** at
the top of the page: the value of `GITHUB_APP_ID`.

## 4. Environment variables

The service reads them once at startup. A missing or invalid value stops the process before it
listens, with `startup.config_invalid` and the name of the variable, never its value; a platform
that waits for the health check keeps the previous container.

Make each secret with `openssl rand -hex 32` for the webhook, registration and session secrets, and
`openssl rand -base64 32` for `KENTO_SECRETS_KEY`.

### For a working service

| Variable | Required | Example | Effect |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | `postgresql://kento:<password>@<database host>:5432/kento` | The database. A secret. |
| `GITHUB_WEBHOOK_SECRET` | for the webhook | 64 hex characters | Checks the signature of each delivery; 32 characters or more. Without it, `/webhooks/github` answers 503 and nothing is queued. A secret. |
| `GITHUB_APP_ID` | for the jobs | `1234567` | With the private key: the installation token of each job, the publication of the reviews, the role of a person, the state of the App. Without them, a claim gives no job and nothing is published. |
| `GITHUB_APP_PRIVATE_KEY` | for the jobs | the PEM on one line, each new line written `\n` | The private key of the App. It never leaves the service. An invalid key stops the start. A secret. |
| `KENTO_PUBLIC_URL` | for the sign-in | `https://kento.example.com` | The origin as the browser sees it: the callback URL, the expected `Origin` of a form, the `Secure` cookie. `http://` only on `localhost` or `127.0.0.1`. Also the link to the Config screen in the comment of a failed job, the page of the commands and the icons of the texts on GitHub. |
| `GITHUB_APP_CLIENT_ID` | for the sign-in | `Iv23li…` | The client of the user authorization. |
| `GITHUB_APP_CLIENT_SECRET` | for the sign-in | from section 3 | A secret. |
| `KENTO_SESSION_SECRET` | for the sign-in | 64 hex characters | The first one signs the session cookie and the state of a sign-in, and keys the CSRF tokens; 32 characters or more. A new first one signs everybody out (section 9). A secret. |
| `KENTO_SECRETS_KEY` | to store provider keys | 44 base64 characters | The master key of the keys of the providers (AES-256-GCM). Without it, the Settings screen stores no key (`startup.secrets_disabled`). See [SECURITY.md](../../SECURITY.md#the-master-key). A secret. |
| `KENTO_PROVIDER_API_KEY` | no | an OpenRouter key | The key of the service, for the jobs of an org that has no provider. Sent with a job only to a trusted runner of the service with no key of its own, never to a runner of an org. A secret. |

The sign-in needs its four variables together, plus `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`.
Without them, every screen says "Sign-in unavailable." and nobody gets in.

### Optional

| Variable | Default | Effect |
| --- | --- | --- |
| `DATABASE_POOL_MAX` | `10` | The connections of the pool, 1 to 100. The migrations at startup use one more, closed before the server listens. |
| `KENTO_TRUSTED_PROXY_HOPS` | required when `KENTO_PUBLIC_URL` is https; else `0` | The proxies in front of the service, 0 to 10. Each one appends to `X-Forwarded-For` the address it got the request from; the client is the entry this many from the end, and the entries before it are never read. `1` behind Traefik alone, `2` behind a CDN then Traefik. With `0` the address of the socket is the client: behind a proxy, every client then shares one sign-in limit. A chain shorter than this, or an entry that is not an address, gives the address of the socket. With 1 or more, the port of the service must be reachable only through the proxy: a client that reaches it directly writes its own address. |
| `KENTO_SIGN_IN_LIMIT` | `10` | The starts of a GitHub sign-in per minute and per client (an IPv6 client by its /64), 1 to 10000; the callbacks of GitHub get twice as many. Over it, the sign-in page answers 429 and nothing is written. Each start writes a row of `verifications` for 10 minutes. The limit lives in the memory of each process: a restart resets it, and N replicas allow N times as many. |
| `HOST` | `0.0.0.0` | The address the server listens on. |
| `PORT` | `3000` | The port the server listens on. |
| `MIGRATE_ON_START` | `true` | Apply the pending migrations before listening. Keep `true`. |
| `APP_COMMIT` | none | The commit shown by `/healthz`. Set it with the build argument of the same name (section 5). |
| `KENTO_RUNNER_REGISTRATION_TOKEN` | none | Registers a runner of the service with `POST /api/runner/register`; 32 characters or more. Not needed when the runners are made on the Runners screen. A secret. |
| `KENTO_SECRETS_PREVIOUS_KEYS` | none | Earlier master keys, comma-separated, during a rotation only. A secret. |
| `GITHUB_API_URL` | `https://api.github.com` | The GitHub API, for GitHub Enterprise Server (`https://<host>/api/v3`) or a local test. |
| `GITHUB_URL` | the server of `GITHUB_API_URL` | The server where the runners clone, HTTPS only, on the server of `GITHUB_API_URL`. |
| `KENTO_BOT_LOGIN` | `kento-review[bot]` | The login of the App: the publisher finds its threads and reviews with it. |
| `KENTO_APP_SLUG` | `KENTO_BOT_LOGIN` without `[bot]` | The slug of the App, for the install link of the page "Access refused.". |
| `KENTO_ALLOWED_ORGS` | none: every account | The GitHub logins that Kentō serves, comma-separated. The webhook ignores every event of another installation: no org, no repository, no job, and so no call with the key of the service. A removal (uninstall, removed repository, closed pull request) still applies. The log at startup gives `startup.allowed_orgs`, and each ignored event `webhook.org_not_allowed`. Set it while the App is public. |

### The names of the instance

The command of the comments, the check of a review, the image of the runners and the bots that a
new org trusts. Their defaults are the names of the first instance of Kentō: set them to the names
of yours. The log at startup gives them in `startup.instance`.

| Variable | Default | Effect |
| --- | --- | --- |
| `KENTO_COMMAND_NAMES` | `kento-review,sakuga-review` | The names that start a command in a comment (`@kento-review heavy`), comma-separated, 5 at most. Each one is a GitHub login, without `@` and without `[bot]`; the case does not count. The first one is the name that the bot, the review and the screens show; the others are aliases. Usually the slug of your App, so that the mention is also the account of the App. |
| `KENTO_CHECK_NAME` | `Sakuga Review` | The name of the check run of a review, 100 characters at most, never `Kentō · cap`. A branch rule that requires the check names it. When you change it, change the required check too: GitHub waits for the old name. A head that already has the check under the old name gets a second one under the new name at its next publication. |
| `KENTO_RUNNER_IMAGE` | `ghcr.io/sakuga-software/kento-runner` | The image of the runner, without a tag, in the `docker run` that the Runners screen gives. The screen adds the version of the service as the tag: publish that tag to this image ([apps/runner/DEPLOY.md](../runner/DEPLOY.md#1-publish-the-image)). |
| `KENTO_DEFAULT_TRUSTED_BOTS` | `sakuga-agent[bot]` | The bots that a new org trusts, comma-separated, 20 at most: their pull requests, pushes and commands count as those of a person with write access. `renovate` reads as `renovate[bot]`; the case does not count. Set and empty, a new org trusts no bot. An org that Kentō already knows keeps its own list, which an admin edits on `/settings` > "Trusted bots". |

`KENTO_REPOS` and `KENTO_TRUSTED_BOTS` are not read any more: the Repos screen and the settings of
the org replaced them. When one is still set, the log at startup says `startup.kento_repos_ignored`
or `startup.kento_trusted_bots_ignored`: remove it.

## 5. The application

1. Build the image from the root of the repository (the pnpm workspace and its lockfile live
   there):

   ```sh
   docker build -f apps/web/Dockerfile --build-arg APP_COMMIT=$(git rev-parse HEAD) -t kento-web:<version> .
   ```

   `APP_COMMIT` is optional: it puts the commit in `/healthz`. Without it, `/healthz` gives
   `"commit": null` and only the version.
2. Run it with the variables of section 4, on the private network of the database, with no other
   port published than 3000 to the reverse proxy.
3. Point the domain to the reverse proxy, with HTTPS, and the proxy to port 3000 of the container.
   Wait until `https://kento.example.com/healthz` answers.

The image has a `HEALTHCHECK` on `/healthz` (every 30 s, 3 failures). A platform that follows it
replaces a container that stays unhealthy, and keeps the old container while a new one is not
healthy.

## 6. Migrations

The service applies the SQL files of `apps/web/drizzle/` at startup, before it listens: in one
transaction, under an advisory lock (two instances that start together migrate one after the other).
A migration already applied is skipped, and a redeploy applies nothing twice.

- `/healthz` gives `database.migrations`, the number of applied migrations. It equals the number of
  `.sql` files in `apps/web/drizzle/` of the deployed commit.
- A migration runs while the previous container still serves, so each one only adds: a column with
  a default or nullable, a table, an index. A rollback does not undo a migration, and the previous
  release still runs on the newer schema.
- The one removal allowed is an index that another index covers: no query reads an index by its
  name, so the previous release gets the same rows. `DROP INDEX` waits for each transaction that
  uses the table, and each query on the table waits behind it: deploy when no long query runs.
- **Exception, migration 0029 (KNT-150).** It moves the GitHub App installation out of `orgs` and
  drops the old columns, so the previous release does not run on the new schema. Follow the steps
  of [the deployment of 0029](#the-deployment-of-migration-0029) instead of a rolling deploy.
- **Exception, migration 0030 (KNT-150).** It drops the table of the sessions and makes the one of
  Better Auth: the previous release cannot read a session any more, and every person signs in
  again once. Follow [the deployment of 0030](#the-deployment-of-migration-0030).
- `startup.migrations_failed` gives the error of the database. The process stops before it listens,
  and the previous container keeps serving.
- How to write one: [README.md](README.md#migrations).

## 7. Checks after a deployment

1. **Logs** of the container, in order:

   ```json
   {"level":"info","event":"startup.instance","commandNames":["kento-review","sakuga-review"],"checkName":"Sakuga Review",…}
   {"level":"info","event":"startup.migrations_applied","durationMs":…}
   {"level":"info","event":"startup.listening","host":"0.0.0.0","port":3000,"version":"…","publisher":true,"signIn":true,…}
   ```

   `startup.secrets` shows the `keyId` of the master key (never the key). No `startup.webhook_disabled`.
2. **Health**:

   ```sh
   curl -sS https://kento.example.com/healthz
   # 200 {"status":"ok","version":"…","commit":…,"database":{"status":"ok","latencyMs":…,"migrations":…}}
   ```

3. **Webhook**: the App > **Advanced > Recent Deliveries**. The `ping` has the answer 200
   `{"outcome":"pong"}`. A wrong signature is refused:

   ```sh
   curl -i -X POST https://kento.example.com/webhooks/github -H 'X-GitHub-Event: ping' \
     -H 'X-GitHub-Delivery: manual-1' -H 'X-Hub-Signature-256: sha256=00' -d '{}'
   # 401 invalid signature
   ```

4. **Sign-in**, in a private window:
   - `https://kento.example.com/` goes to "Sign in to Kentō".
   - "Continue with GitHub" opens GitHub, which asks once to authorize the App. It then comes back
     to the dashboard, with your login and "Admin" at the bottom of the sidebar. The log has
     `auth.signed_in`.
   - A member of the org who is not an owner sees "Read only" on every screen. An account
     outside the org gets "Access refused.", and `users` has no row for it.
5. **State of the App**: `/settings` > "GitHub App" says "Everything is in place". Otherwise it names
   what is missing: a permission or an event (section 3, then accept it in the org), or another
   webhook URL.
6. **A provider** (once): `/settings` > "Add a provider", its key, then "Test": "The
   provider accepted the key." An org with no provider runs on `KENTO_PROVIDER_API_KEY`.
7. **A runner**: `/runners` > "New runner", then the `docker run` that the screen gives
   ([apps/runner/README.md](../runner/README.md)). The Runners screen shows it "Online" within 30 s.
8. **A repository**: `/repos` lists the repositories of the installation. "Enable" on one of them.
9. **A review, end to end**: push a commit on an open pull request of that repository. The logs show
   `job.claimed`, `job.result`, then `review.published` with `"check":true`. On the pull request: a
   review of the bot of the App whose footer starts with `Kentō · Level`, its inline comments, the
   block of the description, the label `review: N/5` and the check `KENTO_CHECK_NAME`.
10. **A command**: `@kento-review heavy` (the first name of `KENTO_COMMAND_NAMES`) in a comment of
    the pull request gets 👀, then a review "Level `heavy`", then 🚀. `@kento-review resolve`
    answers in the open threads and posts "Kentō · thread resolution".

The state of the queue, from the database:

```sql
select state, count(*) from jobs group by 1;
select pr_number, left(head_sha, 8), score, published_at, github_review_id from reviews order by created_at desc limit 5;
```

## 8. Each later deployment

1. Read the entries of [CHANGELOG.md](CHANGELOG.md) since the deployed release: a release that adds
   a variable, a permission of the App or a step before the runners says so there.
2. Build and run the image of the new release (section 5).
3. Check steps 1 and 2 of section 7: the version, and the number of migrations.
4. **The service before the runners.** A runner of a new release can send a claim that an older
   service refuses (400). A runner of the previous release keeps working with the new service. Then
   publish the runner image of the same commit and update the runners
   ([apps/runner/DEPLOY.md](../runner/DEPLOY.md#1-publish-the-image)).

### The deployment of migration 0029

Migration 0029 (KNT-150) cannot run while the previous release serves: once it commits, every
webhook and every claim of a runner that reaches the old container fails with a 500, and GitHub
does not deliver a failed webhook again by itself. There is no down migration: the backup is the
only way back.

1. Before the deploy, check on the database that no org will collide on its new slug. Each line of
   these two queries is a collision to settle first (rename the account, or delete the dead org):

   ```sql
   select lower(login), count(*) from orgs group by 1 having count(*) > 1;
   select o.login from orgs o join orgs d on lower(o.login) = lower(d.login) || '-' || d.github_installation_id;
   ```

2. Take a backup of the database (`pg_dump`).
3. Stop the container of the previous release.
4. Start the new release: it migrates at startup (`/healthz` gives the new number of migrations).
5. If the old container served after the migration committed (a rolling deploy), open **Advanced**
   in the settings of the GitHub App and **Redeliver** the deliveries of that window that failed.
6. To roll back: stop the new release, restore the backup, start the previous release.

### The deployment of migration 0030

Migration 0030 (KNT-150) needs 0029 before it, and nothing else of the state that 0029 left: it
changes only `users`, `accounts`, `sessions` and `verifications`. Both can run in the same deploy (the service applies every
pending migration in one start), or 0030 in a later one.

1. Behind a proxy, set `KENTO_TRUSTED_PROXY_HOPS` first (`1` behind Traefik alone): the limits of
   the sign-in are by client, and with the default 0 every client has the address of the proxy.
2. Take a backup of the database (`pg_dump`). There is no down migration.
3. Stop the container of the previous release: it reads the old table of the sessions, and fails
   on every screen once 0030 commits. The webhook and the runners do not read sessions.
4. Start the new release. Each person signs in again once, with one click on GitHub, and keeps
   their rights (`memberships` do not change). The cookie of the previous release gives "Session
   ended." once, and is cleared.
5. To roll back: stop the new release, restore the backup, start the previous release. Everyone
   signs in again once more.

**Roll back**: run the image of the previous release again. It does not undo a migration, and the
previous release runs on the newer schema. Read the entry of the release in
[CHANGELOG.md](CHANGELOG.md) first: a release that removed a variable may need it back.

## 9. Operations

### Rotate a secret

- **Webhook secret**: a new value in the environment, deploy, then the same value in the App
  settings, one right after the other. The deliveries in between get 401: redeliver them from
  **Recent Deliveries**.
- **Session secret**: since KNT-150, Better Auth signs the session cookie with the first secret
  only. A new first secret signs everybody out: each person signs in again with one click on
  GitHub, and keeps their rights. That is also the way to end every session now.
- **Master key of the provider keys**: [SECURITY.md](../../SECURITY.md#the-master-key)
  (`KENTO_SECRETS_PREVIOUS_KEYS`, then `node app/providers/rotate-keys.ts --apply`).
- **Private key of the App**: generate a new key in the App settings, put it in the environment,
  deploy, then delete the old key in the App settings.
- **Provider key of the service**: replace `KENTO_PROVIDER_API_KEY` and deploy. The key of a
  provider of an org is replaced on the Settings screen ("Replace the key").

### Cost limit

The limits of an org are on `/settings` > "Cost cap", for an admin: per UTC day, per UTC
month, and an alert threshold. At a limit, a push queues nothing (202 `capped`) and its head gets the
neutral check "Kentō · cap"; a command gets 😕 and a reply. A job already queued or running
finishes. A repository can also have a monthly limit of its automatic reviews on its Config screen.
A spending limit on the key of the provider stays a second guard.

### Repositories, runners and people

- **Enable or disable a repository**: `/repos`, "Enable" or "Disable Kentō…". A disabled repository
  gets no job; its queued jobs are cancelled.
- **Trusted bots** (bots whose pull requests and commands count as a person's): `/settings` > "Trusted
  bots". A new org starts with `KENTO_DEFAULT_TRUSTED_BOTS`.
- **A new runner**: `/runners` > "New runner" gives a token that works once, for one hour. See
  [apps/runner/README.md](../runner/README.md).
- **Revoke a runner**: `/runners` > "Revoke…". Its token stops at the next call, and its running
  job goes back to the queue without spending an attempt.
- **Remove a person**: remove them from the org on GitHub. Their access ends within 10 minutes;
  `delete from users where login = '…'` ends it at once.

### A job that waits in the queue

A job `queued` for more than **10 minutes** (`QUEUE_STALL_MINUTES`, `app/publish/queued.ts`) means
that no runner takes it. A runner asks for a job every 30 s, and a job queued again after an expired
lease waits 1 min at most. The wait counts from the creation of the job, or from the end of that
wait (`not_before`). A job with no `base_ref` is never claimed and is left out. Then:

- the dashboard shows a red banner at the top: how many jobs wait and since when. It names the cause
  (no runner of the org or of the service online since …, or online runners that do not take the
  jobs) and the action (start a runner, see the Runners screen);
- the pull request gets one comment "Kentō · review waiting", with the same cause and a hidden
  `<!-- kento:queued <repo id>#<number> -->`. The publisher writes it on its 30 s timer, and
  deletes it once no job of the pull request waits for too long. A failure still gets its own
  comment.

Each pull request has one row in `queue_notices`. Each run of the publisher reads the queue and
aligns GitHub with it, and each step can run again safely. A comment that a person deletes is not
posted again while the job waits. Only a job that began to wait within the last day gets a comment.

To check it, stop the runner (`docker stop kento-runner`) and push on a pull request of an enabled
repository. After 10 min the dashboard shows the banner, and within 30 s more the pull request gets
the comment. Start the runner again: the comment goes when the runner takes the job.

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

## 10. Logs

The service writes one JSON object per line on its standard output: `time`, `level`, `event` and
the fields of the event. It never writes a secret or a token. Send these lines to the log store of
your platform, and alert on `level="error"` and on the events below.

The events that need a person:

| Event | Meaning |
| --- | --- |
| `startup.config_invalid`, `startup.migrations_failed` | The new container did not start; the previous one serves. |
| `review.check_token_refused` | The App lacks **Checks: Read and write** (section 3). |
| `resolve.write_token_refused` | The App lacks **Contents: Read and write**: resolve answers and resolves no thread. |
| `auth.sign_in_refused` | The App lacks **Members: Read-only**, or the person is not in the org. |
| `review.publication_failed` | GitHub refused the publication; tried again three times per process, for 30 minutes. |
| `job.failure_notice_failed` | The comment of a failed job could not be posted. |
| `job.queue_noticed` (warn) | A job of a pull request waits for more than 10 min: `cause` `no_runner` or `not_taken`. An alert can be a rule on it. |
| `job.queue_notice_failed`, `job.queue_notice_remove_failed` | GitHub refused the comment of the queue; the next run tries again. |
| `job.queue_notice_search_capped` | The marker of the comment was looked for in the first 1000 comments only. |
| `job.lease_expired` with `"state":"failed"` | A job lost its runner twice. |
| `job.model_id_refused` | A model id of the job has the wrong form for its provider (`anthropic/…` on Anthropic, no vendor on OpenRouter), kept before the form refused it. The job fails at the claim, before any call, and its pull request gets the comment of a failed job. Correct the id that Config or Settings shows in red. |
| `jobs.purge_failed` | The database refused the purge of the old jobs. |
| `http.request` with `status` 500 or more | A request failed on the side of the service. |
