# apps/web — Kentō web service

The service behind `review.sakuga.dev`. In milestone M2 it has no screen: it serves `GET /healthz`
the GitHub App webhook `POST /webhooks/github` (REV-3) and the runner API `POST /api/runner/*`
(REV-4).

- [Remix 3](https://github.com/remix-run/remix): `remix/router` (fetch-router), `remix/component`,
  `remix/node-fetch-server`. Node 24.3 or later runs the TypeScript source with `remix/node-tsx`;
  there is no build step.
- Postgres with [drizzle](https://orm.drizzle.team): schema in `app/db/schema.ts`, SQL migrations in
  `drizzle/`, applied at startup.

Deployment: [DEPLOY.md](DEPLOY.md).

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
| `KENTO_REPOS`       | no       | (none)    | Comma-separated `owner/name` of the repositories that get a review job. Empty: no job. M3 replaces it with the Repos screen. |
| `KENTO_TRUSTED_BOTS` | no      | `sakuga-agent[bot]` | Comma-separated bot logins whose pull requests and pushes get a review, as in `review.yml`. |
| `KENTO_RUNNER_REGISTRATION_TOKEN` | no | | Secret that a runner sends to `POST /api/runner/register`, 32 characters or more. Without it, the registration answers 401. |
| `GITHUB_APP_ID` | no | | ID of the GitHub App. With `GITHUB_APP_PRIVATE_KEY`, the service makes the installation token of each job. Without them, a claim gives no job. |
| `GITHUB_APP_PRIVATE_KEY` | no | | PEM private key of the App; on one line, `\n` for each new line. A secret: it never leaves the service. |
| `GITHUB_API_URL` | no | `https://api.github.com` | GitHub API, for GitHub Enterprise Server (`https://<host>/api/v3`) or a local test. |
| `GITHUB_URL` | no | the server of `GITHUB_API_URL` | The GitHub server where the runners clone, HTTPS only. It must be on the server of `GITHUB_API_URL` (github.com for `api.github.com`), else the service refuses to start: the installation token of one server never goes to another. |
| `KENTO_PROVIDER_API_KEY` | no | | OpenRouter key of the service. Sent with a job only to a trusted runner that has no key of its own. A secret. |

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
| `pull_request` | `opened`, `synchronize`, `reopened`, `ready_for_review` | One `review` job, `queued`, at the default level of the repository. The other queued or running jobs of the pull request become `cancelled`. Skipped (202 `ignored`): a repository outside `KENTO_REPOS`, a draft, a push or a pull request of a bot outside `KENTO_TRUSTED_BOTS`, a pull request from a fork. |
| `pull_request` | `closed` | The queued or running jobs of the pull request become `cancelled`. |
| `installation` | `created`, `new_permissions_accepted`, `unsuspend` | Upserts the org and the listed repositories; clears `suspended_at`. |
| `installation` | `suspend`, `deleted` | Sets `suspended_at` and cancels the jobs of the org. The rows stay. |
| `installation_repositories` | `added` / `removed` | Upserts / deletes the repositories (a deleted repository takes its jobs and reviews with it). |
| `issue_comment` | | 202 `ignored`: the `@kento` commands have their own ticket. |

A `pull_request` event also upserts its org and repository, so the App needs no new `installation`
event after the webhook is added.

In M2, `repos.enabled` mirrors `KENTO_REPOS`: each upsert of a repository writes it, and a job needs
it. M3 replaces the variable with the Repos screen, which then owns the column.

Duplicates:

- The delivery id of a job is unique: « Redeliver » on the page of the App creates no second job and
  cancels nothing.
- A head that already had a review job gets no second one, unless that job was cancelled by a close,
  a suspension or an uninstall: a reopen on the same head is reviewed again. `jobs.failure_reason`
  says why a job was cancelled (`superseded by a newer push`, `pull request closed`, `installation
  suspended`, `installation deleted`). The delivery id is not signed, so a captured request can come
  back with a new one: a head superseded by a newer push stays blocked, so the replay of an older
  push cannot queue a paid review of a stale head nor cancel the job of the current head. The cost: a
  force-push back to a head that was already reviewed gets no new job (the `@kento` commands will
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
| `jobs/claim` | runner token | Long poll up to 30 s. Takes the oldest `queued` review job with one `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`: two runners never get the same job. The job becomes `running`, with the runner and a lease of 2 min. 200 with the job, or 204. |
| `jobs/:id/heartbeat` | runner token, holder of the job | Extends the lease by 2 min. `cancel: true` when a newer push cancelled the job. 404 for another runner's job. |
| `jobs/:id/result` | runner token, holder of the job | `done` with the review: one row in `reviews`, the job becomes `done`. `failed` with a reason: the job becomes `failed`. 409 when the job is no longer `running`, 422 when the review is of another head. |

Each job carries a GitHub installation token that the service asks for the one repository of the
job, with `contents: read`; GitHub makes it valid one hour. The private key of the App never leaves
the service. The OpenRouter key of the service goes with a job only to a `trusted` runner that says
it has no key of its own.

A wrong, missing or revoked runner token gets 401 with no reason. Revoke a runner with
`update runners set revoked_at = now() where id = …`: its next call gets 401.

Events: `runner.registered`, `runner.registration_refused`, `runner.auth_refused`, `job.claimed`,
`job.installation_token_failed`, `job.result`. No token or key is logged.

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
