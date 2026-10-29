# apps/web — Kentō web service

The service behind `review.sakuga.dev`: `GET /healthz`, the GitHub App webhook `POST /webhooks/github`
(REV-3), the runner API `POST /api/runner/*` (REV-4), the publication on GitHub of the review that a
runner sends (REV-5, `app/publish/`), and the screens of milestone M3 (REV-8 and after).

- [Remix 3](https://github.com/remix-run/remix): `remix/router` (fetch-router), `remix/component`,
  `remix/node-fetch-server`. Node 26 or later runs the TypeScript source with `remix/node-tsx`;
  there is no build step.
- Postgres with [drizzle](https://orm.drizzle.team): schema in `app/db/schema.ts`, SQL migrations in
  `drizzle/`, applied at startup.

Deployment: [DEPLOY.md](DEPLOY.md).

## Screens

Server-rendered HTML in French, with `remix/component`, and one small script
(`public/assets/theme.js`). The design is in [design/](../../design/README.md).

- `app/ui/shell.tsx`: the frame of every screen. Sidebar (wider than 760 px) or top bar and tab
  bar, page header, « Lecture seule » banner for a member, footer `Kentō x.y.z · par Sakuga`.
- `public/assets/kento.css`: every token (colours of the two themes, type scale, radii, shadows) and
  the frame. A screen writes a token name, never a colour value.
- `public/assets/fonts/`: Archivo, Zen Kaku Gothic New, JetBrains Mono (SIL OFL 1.1). The app serves
  everything under `/assets/`; the content security policy allows no other origin except the avatars
  of GitHub, and no inline script or style.
- The theme (Papier, Sumi, Appareil) is the cookie `kento_theme` of the browser.
- `app/ui/runners.tsx` and `app/runner/admin.ts`: the Runners screen (REV-10). The runners of the
  org and of the service with their state, version, last call and jobs; registration tokens
  (`kento_reg_…`, shown once, one use, one hour, kept as a hash); trust and revocation for an admin.
  `public/assets/runners.js` adds « Copier la commande ».

### Sign-in, sessions and roles (`app/auth/`)

- `GET /login` → `GET /login/github` → GitHub → `GET /auth/github/callback`: the user authorization of
  the GitHub App, authorization code with PKCE and `state`. The user token reads `GET /user` once and
  is dropped.
- The role comes from GitHub, never from Kentō: `GET /orgs/{org}/memberships/{login}` with an
  installation token limited to `members: read`. `admin` edits, `member` reads (the « Lecture seule »
  banner), `pending` or absent gets nothing. The owner of a personal account is its admin. Someone in
  none of the orgs of the App is refused, and nothing is written. The role is read again after 10
  minutes; while GitHub fails, the last one holds 1 hour, then the access ends.
- Sessions in Postgres (`sessions`): a random id in a signed cookie (`__Host-kento_session`, HttpOnly,
  Secure, SameSite=Lax, 7 days), only its SHA-256 in the table. A new id at the sign-in, the row
  deleted at sign-out. A visit writes nothing: only a signed-in session or a sign-in on its way (10
  minutes) has a row. Expired rows leave every hour.
- Forms: `cop()` (Sec-Fetch-Site, Origin) and the CSRF token of the session (`csrf()`, the hidden
  `_csrf` field). The webhook and the runner API are outside of it.
- Logs: `auth.signed_in`, `auth.sign_in_refused`, `auth.sign_in_failed`, `auth.signed_out`,
  `auth.access_lost`, `auth.role_check_failed`, `sessions.swept`. No token or secret.
- REV-9, REV-10, REV-13, REV-14 and REV-18 fill the screens; each one is an empty « Bientôt ici »
  until then.

## Configuration

Environment variables, read once at startup. An invalid value stops the process before it listens,
and the log names the variable, never its value.

| Variable            | Required | Default   | Meaning                                                            |
| ------------------- | -------- | --------- | ------------------------------------------------------------------ |
| `DATABASE_URL`      | yes      |           | `postgres://user:password@host:5432/db`. A secret: never commit it. |
| `DATABASE_POOL_MAX` | no       | `10`      | Maximum connections in the pool (1 to 100). The migrations at startup use one more, closed before the server listens. |
| `HOST`              | no       | `0.0.0.0` | Address the HTTP server listens on.                                |
| `PORT`              | no       | `3000`    | Port the HTTP server listens on.                                   |
| `MIGRATE_ON_START`  | no       | `true`    | Apply the pending migrations before listening.                     |
| `APP_COMMIT`        | no       |           | Commit of the image, shown by `/healthz`. The Dockerfile sets it from the build argument of the same name. |
| `GITHUB_WEBHOOK_SECRET` | no   |           | Secret of the GitHub App webhook, 32 characters or more (`openssl rand -hex 32`). A secret: never commit it. Without it, `/webhooks/github` answers 503. |
| `KENTO_RUNNER_REGISTRATION_TOKEN` | no | | Secret that a runner sends to `POST /api/runner/register`, 32 characters or more. Without it, the registration answers 401. |
| `GITHUB_APP_ID` | no | | ID of the GitHub App. With `GITHUB_APP_PRIVATE_KEY`, the service makes the installation token of each job. Without them, a claim gives no job. |
| `GITHUB_APP_PRIVATE_KEY` | no | | PEM private key of the App; on one line, `\n` for each new line. A secret: it never leaves the service. |
| `GITHUB_API_URL` | no | `https://api.github.com` | GitHub API, for GitHub Enterprise Server (`https://<host>/api/v3`) or a local test. |
| `GITHUB_URL` | no | the server of `GITHUB_API_URL` | The GitHub server where the runners clone, HTTPS only. It must be on the server of `GITHUB_API_URL` (github.com for `api.github.com`), else the service refuses to start: the installation token of one server never goes to another. |
| `KENTO_PROVIDER_API_KEY` | no | | OpenRouter key of the service, for the jobs of an org that has no provider (REV-11). Sent with a job only to a trusted runner that has no OpenRouter key of its own. A secret. |
| `KENTO_SECRETS_KEY` | no | | Master key of the keys of the providers (REV-11): 32 random bytes in base64 (`openssl rand -base64 32`). The keys are stored AES-256-GCM under it. Without it, the screen stores no key. A secret. See SECURITY.md. |
| `KENTO_SECRETS_PREVIOUS_KEYS` | no | | Comma-separated earlier master keys, during a rotation only: they still decrypt; `node app/providers/rotate-keys.ts --apply` encrypts every key again under `KENTO_SECRETS_KEY`. A secret. |
| `KENTO_BOT_LOGIN` | no | `kento-review[bot]` | Login of the GitHub App. The publisher finds the threads and the reviews of the bot with it. |
| `KENTO_PUBLIC_URL` | for the sign-in | | The https origin of the service as the browser sees it, `https://review.sakuga.dev`. It makes the callback URL, the expected `Origin` of a form, and the `Secure` session cookie. `http://` only on `localhost` or `127.0.0.1`. |
| `GITHUB_APP_CLIENT_ID` | for the sign-in | | Client ID of the GitHub App, for its user authorization. |
| `GITHUB_APP_CLIENT_SECRET` | for the sign-in | | Client secret of the GitHub App. A secret. |
| `KENTO_SESSION_SECRET` | for the sign-in | | Signs the session cookie, 32 characters or more. Comma-separated for a rotation: the first signs, all verify. A secret. |

The sign-in needs its four variables together, plus `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`.
None of them: the screens say « Connexion indisponible ».

## `GET /healthz`

Reads the database (the number of applied migrations) on every call, with a 2 s timeout.

```json
{"status":"ok","version":"0.1.0","commit":"abc1234","database":{"status":"ok","latencyMs":2,"migrations":1}}
```

- 200 when the database answers.
- 503 when it does not: `database.error` is a Postgres or Node error code (`ECONNREFUSED`, `42P01`,
  `timeout`…), never a host, user or query.

## `POST /webhooks/github`

The webhook of the GitHub App. Steps, in order; nothing reads the database before step 3 passes:

1. 503 when `GITHUB_WEBHOOK_SECRET` is not set. 400 without a valid `X-GitHub-Event` or
   `X-GitHub-Delivery`.
2. 413 when the body is over 2 MiB: a `Content-Length` over the limit is refused before the first
   byte, and the reader of a chunked body stops at the limit.
3. 401 when `X-Hub-Signature-256` is missing or is not the HMAC-SHA256 of the raw body
   (`crypto.timingSafeEqual`).
4. 400 when the body is not JSON. Then the event:

| Event | Action | Effect |
| ----- | ------ | ------ |
| `ping` | | 200 `pong` |
| `pull_request` | `opened`, `synchronize`, `reopened`, `ready_for_review` | One `review` job, `queued`, at the level that the config of the repository resolves (repository, then org, then `lite`). The other queued or running jobs of the pull request become `cancelled`. Skipped (202 `skipped`): a repository that is not enabled on the Repos screen. Skipped (202 `ignored`): a draft, a push or a pull request of a bot outside the trusted bots of the org (settings, REV-13), a pull request from a fork. No job (202 `capped`): the org reached its cost limit of the day or of the month; the head gets the neutral check « Kentō · plafond ». |
| `pull_request` | `closed` | The queued or running jobs of the pull request become `cancelled`. |
| `installation` | `created`, `new_permissions_accepted`, `unsuspend` | Upserts the org and the listed repositories; clears `suspended_at`. |
| `installation` | `suspend`, `deleted` | Sets `suspended_at` and cancels the jobs of the org. The rows stay. |
| `installation_repositories` | `added` / `removed` | Upserts / deletes the repositories (a deleted repository takes its jobs and reviews with it). |
| `issue_comment` | | 202 `ignored`: the `@kento-review` commands have their own ticket. |

A `pull_request` event also upserts its org and repository, so the App needs no new `installation`
event after the webhook is added.

`repos.enabled` belongs to the Repos screen (REV-9): an admin of the org enables or disables a
repository there, and an event never changes it. A repository comes in disabled. A job needs it, and
so does a command in a comment: the command of a repository that is not enabled gets no token, no
reaction and no reply, so `review.yml` keeps it. Disabling a repository cancels its queued jobs; a
running job ends, and the published reviews stay.

The Repos screen reads the repositories of the installation on GitHub (`GET
/installation/repositories`, then the files of `.github/workflows`) with an installation token
`contents: read`: at the first visit, then when the last check is older than 10 minutes, in the
background; « Actualiser » runs it at once. A workflow that calls `review.yml@<ref>` is
`reusable`, one that runs `review/sakuga-review.ts` without `workflow_call` is a `copy`. The switch
counter is the number of reviews that Kentō published on GitHub since the last failed job of the
repository, or since its last double publication (two reviews of a push at the same head and
level); at 20, the screen offers to remove `review.yml` on GitHub.

Duplicates:

- The delivery id of a job is unique: « Redeliver » on the page of the App creates no second job and
  cancels nothing.
- A head that already had a review job gets no second one, unless that job was cancelled by a close,
  a suspension or an uninstall: a reopen on the same head is reviewed again. `jobs.failure_reason`
  says why a job was cancelled (`superseded by a newer push`, `pull request closed`, `installation
  suspended`, `installation deleted`). The delivery id is not signed, so a captured request can come
  back with a new one: a head superseded by a newer push stays blocked, so the replay of an older
  push cannot queue a paid review of a stale head nor cancel the job of the current head. The cost: a
  force-push back to a head that was already reviewed gets no new job (the `@kento-review` commands will
  cover a review on demand).
- While the last job of a pull request was cancelled by its close, only `reopened` queues a job:
  GitHub sends no push for a closed pull request, so a `synchronize` then is a replay.
- The upsert of the repository locks its row until the transaction ends, and a close takes the same
  lock: two deliveries of one repository run one after the other, and leave one queued job per pull
  request (none after a close).

The logs name the event, action, delivery id and outcome (`webhook.applied`, `webhook.ignored`,
`webhook.bad_signature`, `webhook.too_large`, `webhook.invalid`, `webhook.failed`), never the secret,
the signature or the body. The response is a JSON `outcome`, shown on the deliveries page of the App.

## Runner API: `POST /api/runner/*`

A runner ([apps/runner](../runner)) takes the jobs over HTTPS. `packages/protocol` holds every message
and its check; the service checks each body against it (400 with the list of problems, 413 over
1 MB, 415 without `Content-Type: application/json`).

| Route | Auth | Does |
| --- | --- | --- |
| `register` | registration token | Creates a runner and returns its token once (`kento_rt_…`, 256 random bits). The table `runners` keeps only its SHA-256. A new runner is never `trusted`. |
| `jobs/claim` | runner token | Long poll up to 30 s. A job runs with the default provider of its org (REV-11), or with `KENTO_PROVIDER_API_KEY` when the org has none. A runner gets it when it holds that kind of provider itself (`ownProvider`), or when it is `trusted` and the service holds the key (decrypted for that job, sent in `providers[]` to a runner with the feature `providers`); otherwise the job stays queued. A runner of an earlier release gets only the jobs of an org without a provider. Takes the oldest `queued` review job with one `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`: two runners never get the same job. The job becomes `running`, with the runner, a lease of 2 min and the next `attempt` number. A job queued again waits for its `not_before` (backoff). 200 with the job, or 204. |
| `jobs/:id/heartbeat` | runner token, holder of the attempt | Body `{ "attempt": n }`. Extends the lease by 2 min. `cancel: true` when a push, a close or a suspension cancelled the job. 409 `lease_lost` when this runner and attempt no longer hold the job, 409 `job_finished` after its result, 404 for a job that does not exist. |
| `jobs/:id/result` | runner token, holder of the attempt | `done` with the review and the attempt: one row in `reviews`, the job becomes `done`. `failed` with a reason: the job becomes `failed`. 409 `lease_lost` when another attempt holds the job (or it went back to the queue), 409 `job_not_running` when it is cancelled or finished, 422 when the review is of another head. |

### Leases and attempts

The holder of a job is its runner **and** its attempt (`jobs.attempts`, incremented by each claim).
Every heartbeat and result names its attempt, and the service compares both under the lock of the
row: a runner whose lease was taken over can never write a result, even when the same runner claimed
the job again.

Every 15 s each replica of the service sweeps the `running` jobs whose lease has ended, in one
`UPDATE … FOR UPDATE SKIP LOCKED` statement (two sweeps never take the same job, and a job whose
result is being written is left to the next sweep):

- fewer than 2 attempts: back to `queued`, `not_before` = now + 30 s × 2^(attempts − 1);
- 2 attempts: `failed`, `failure_reason` = `lease expired 2 times`.

A failure to make the installation token at a claim counts as an attempt in the same way. A job that
fails keeps the reviews of the earlier heads: nothing is removed.

Each job carries a GitHub installation token that the service asks for the one repository of the
job, with `contents: read`; GitHub makes it valid one hour. The private key of the App never leaves
the service. The OpenRouter key of the service goes with a job only to a `trusted` runner that says
it has no key of its own.

A wrong, missing or revoked runner token gets 401 with no reason. Revoke a runner with
`update runners set revoked_at = now() where id = …`: its next call gets 401.

Events: `runner.registered`, `runner.registration_refused`, `runner.auth_refused`, `job.claimed`,
`job.installation_token_failed`, `job.result`, `job.lease_lost`, `job.lease_expired` (with `state`
`queued` or `failed`), `job.lease_sweep_failed`. No token or key is logged.

## Logs

One JSON object per line: `time`, `level`, `event`, and fields. `info` goes to stdout, `warn` and
`error` to stderr; Loki reads both. Events: `startup.*`, `shutdown.*`, `http.request` (every request
except a successful `/healthz`), `http.unhandled_error`, `webhook.*`, `runner.*`, `job.*`.

## Develop

From the root of the repository:

```sh
pnpm install
docker run -d --name kento-pg --rm -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 postgres:18.3
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm -F @sakuga-review/web dev
```

| Command                                    | Does                                                         |
| ------------------------------------------ | ------------------------------------------------------------ |
| `pnpm -F @sakuga-review/web lint`          | oxlint                                                       |
| `pnpm -F @sakuga-review/web typecheck`     | `tsc --noEmit`                                               |
| `pnpm -F @sakuga-review/web test`          | Unit tests, no database.                                     |
| `pnpm -F @sakuga-review/web test:db`       | Tests against Postgres. Needs `TEST_DATABASE_URL`, see below. |
| `pnpm -F @sakuga-review/web db:generate`   | Writes the next migration after a change of `app/db/schema.ts`. |
| `pnpm -F @sakuga-review/web e2e`           | The screens in Chromium, with axe, at 1440 and 390 px, signed in through a fake GitHub (`e2e/fake-github.ts`, port 3499). Needs `E2E_DATABASE_URL` (a throwaway database: the server migrates it) and `pnpm -F @sakuga-review/web exec playwright install chromium` once. |
| `pnpm -F @sakuga-review/web design:board`  | Writes the frames of `design/socle/` from the components. |

`test:db` creates one throwaway database per test file on the server of `TEST_DATABASE_URL`, and
drops it at the end:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm -F @sakuga-review/web test:db
```

## Migrations

1. Change `app/db/schema.ts`.
2. `pnpm -F @sakuga-review/web db:generate --name <what>`: writes `drizzle/NNNN_<what>.sql` and its
   snapshot. Read the SQL, and commit it with the schema.
3. The next start applies it, in one transaction, under an advisory lock (two instances that start
   together migrate one after the other). A migration already applied is skipped.

A migration must keep the rows: add a column with a default or as nullable, and never drop or rename
a column that the running release still reads. A deploy runs the new migrations while the previous
container still serves.
