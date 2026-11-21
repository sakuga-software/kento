# apps/web: the Kentō web service

The service behind `review.sakuga.dev`: `GET /healthz`, the GitHub App webhook `POST /webhooks/github`
(REV-3), the runner API `POST /api/runner/*` (REV-4), the publication on GitHub of the review that a
runner sends (REV-5, `app/publish/`), and the screens of milestone M3 (REV-8 and after).

- [Remix 3](https://github.com/remix-run/remix): `remix/router` (fetch-router), `remix/component`,
  `remix/node-fetch-server`. Node 26 or later runs the TypeScript source with `remix/node-tsx`;
  there is no build step.
- Postgres with [drizzle](https://orm.drizzle.team): schema in `app/db/schema.ts`, SQL migrations in
  `drizzle/`, applied at startup.

Deployment: [DEPLOY.md](DEPLOY.md). What each release changed: [CHANGELOG.md](CHANGELOG.md).

## Screens

Server-rendered HTML in English (REV-114), with `remix/component`, small scripts in
`public/assets/`, and a few components that hydrate in the browser (KNT-163).

- `app/ui/shell.tsx`: the frame of every screen. Sidebar (wider than 760 px) or top bar and tab
  bar, page header, "Read only" banner for a member, footer `Kentō x.y.z · by Sakuga`.
- `public/assets/kento.css`: every token (colours of the two themes, type scale, radii, shadows) and
  the frame. A screen writes a token name, never a colour value.
- `app/ui/controls.tsx` (KNT-143): the form controls, native elements (`Button`, `buttonClass`,
  `Input`, `Textarea`, `Select`, `Choice`, `Check`, `Field`) drawn by `kento.css`. The rules for the
  controls of every screen are in [CLAUDE.md](CLAUDE.md#ui-components).
- `public/assets/fonts/`: Archivo, Zen Kaku Gothic New, JetBrains Mono (SIL OFL 1.1). The app serves
  everything under `/assets/`; the content security policy allows no other origin except the avatars
  of GitHub, no inline style, and one inline script: the import map, with the nonce of the response.
- `app/assets.ts` (KNT-163): the asset server of Remix. It compiles the browser modules of
  `app/**/public/` and the packages `remix` and `@remix-run/ui` when the browser asks for them, under
  `/assets/app/…` and short names (`/assets/c/…`, `/assets/ui/…`); with `NODE_ENV=production`,
  minified, with the hash of the content in each URL, cached a year. `public/boot.ts` is the module of
  every page; it loads `public/runtime.ts` (the runtime of `remix/component`, `run()`) only on a page
  with a component to hydrate: the menu "…" of the Repos screen (`public/row-menu.tsx`) and the
  confirmations (`public/confirm.tsx`), on the menu and the popover of `@remix-run/ui`. Without
  JavaScript, each one stays the `<details>` of the server. Every select of the screens (KNT-165,
  `public/select.tsx`) is the select of `@remix-run/ui` in the browser, and the native `<select>`
  without JavaScript.
- The theme (Paper, Sumi, Device) is the cookie `kento_theme` of the browser. The user sets it on
  their own screen, `/users/:login` (KNT-142); every page, the sign-in page too, renders in it.
- `app/ui/runners.tsx` and `app/runner/admin.ts`: the Runners screen (REV-10). The runners of the
  org and of the service with their state, version, last call and jobs; registration tokens
  (`kento_reg_…`, shown once, one use, one hour, kept as a hash); trust and revocation for an admin.
  `public/assets/runners.js` adds "Copy the command".
- `app/ui/user.tsx`, `app/users/`: the screen of a user, `/users/:login` (REV-22). Every member of
  the org reads it; only the user changes it. Their preferences for the reviews of their own pull
  requests (`user_prefs`: automatic review on or off, a default level, for every repository and per
  repository), the theme, the findings that their pull requests received over 30 days (the counts of
  the Findings screen with `?author=<login>&days=30`), and the pull requests that Kentō reviewed.
  The author of each pull request is in `pull_authors`, written by each push and each command. The
  login in the sidebar leads to it.

### Sign-in, sessions and roles (`app/auth/`)

- KNT-150: [Better Auth](https://www.better-auth.com) (`app/auth/better-auth.ts`) runs the
  sign-in and the sessions. Its HTTP API is not mounted: only the callback of GitHub reaches its
  handler, and the forms of Kentō call it on the server.
- `GET /login`, then `GET /login/github`, then GitHub, then `GET /auth/github/callback` (the callback
  URL of the App, as before): the user authorization of the GitHub App, authorization code with
  PKCE and `state` (in `verifications`, 10 minutes). The user token reads `GET /user` once and is
  dropped: `accounts` holds no token, and a check of the table refuses one.
- The role comes from GitHub, never from Kentō: `GET /orgs/{org}/memberships/{login}` with an
  installation token limited to `members: read`. `admin` edits, `member` reads (the "Read only"
  banner), `pending` or absent gets nothing. The owner of a personal account is its admin. In an org
  of several installations, the role is the highest that their accounts give. Someone in none of
  the orgs of the App is refused, and nothing is written. The role is read again after 10
  minutes; while GitHub fails, the last one holds 1 hour, then the access ends.
- Sessions in Postgres (`sessions`): a random token in a signed cookie (`__Host-kento_session`,
  HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, 7 days from the sign-in, never longer), only
  its SHA-256 in the table (`token_hash`). A session row that Better Auth reads other than by its
  token comes back without a token, so the hash is never handed out as one. A new session at each
  sign-in, and the row of the one before goes; the row is deleted at sign-out. A visit writes
  nothing. Expired sessions and sign-ins leave every hour. A user's e-mail is
  `<github id>@users.github.invalid`: Better Auth needs one, the App reads none, and Kentō never
  sends mail.
- The state of a sign-in (`__Host-kento_state`, 10 minutes, and its row in `verifications`) is
  single use: the read of the row deletes it, so two callbacks with one state cannot both pass,
  and a callback that fails a check still uses it up. Only the API call of Better Auth that starts
  the sign-in and its callback are used: no path under `/api/auth` is served.
- Limits (`app/auth/rate-limit.ts`): 10 starts of a sign-in and 20 callbacks a minute per client
  (`KENTO_SIGN_IN_LIMIT`), keyed by the address of the client: the socket, or the entry of
  `X-Forwarded-For` that a trusted proxy added (`KENTO_TRUSTED_PROXY_HOPS`); an IPv6 client by its
  /64. Over it: 429, and nothing is written. The limiter of Better Auth is off.
- Personal data in `sessions`: the address of the client (as resolved above, never a header that
  the client wrote alone) and its user agent, kept with the session and deleted with it. Nothing
  shows or sends them; they are for an admin who reads the table.
- Forms: `cop()` (Sec-Fetch-Site, Origin) and the CSRF token of the session (`csrf()`, the hidden
  `_csrf` field): an HMAC of the session id with the session secret, never stored. The webhook and
  the runner API are outside of it.
- Logs: `auth.signed_in`, `auth.sign_in_refused`, `auth.sign_in_failed`, `auth.sign_in_limited`,
  `auth.signed_out`, `auth.access_lost`, `auth.role_check_failed`, `sessions.swept`. No token or
  secret: the message of a failed query stops before its parameters.
- REV-9, REV-10, REV-13, REV-14 and REV-18 fill the screens; each one is an empty "Soon here"
  until then.

## Configuration

Environment variables, read once at startup. An invalid value stops the process before it listens,
and the log names the variable, never its value. The table of every variable, with an example and
its effect, is in [DEPLOY.md](DEPLOY.md#4-environment-variables). To run the service on your machine,
`DATABASE_URL` is enough (see "Develop" below).

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
| `pull_request` | `opened`, `synchronize`, `reopened`, `ready_for_review` | One `review` job, `queued`, at the level that the config of the repository resolves (repository, then org, then `lite`). The other queued or running jobs of the pull request become `cancelled`. Skipped (202 `skipped`): a repository that is not enabled on the Repos screen. Skipped (202 `ignored`): a draft, a push or a pull request of a bot outside the trusted bots of the org (settings, REV-13), a pull request from a fork. No job (202 `capped`): the org reached its cost limit of the day or of the month; the head gets the neutral check "Kentō · cap". |
| `pull_request` | `closed` | The queued or running jobs of the pull request become `cancelled`. REV-107: then the 👍 and 👎 on the request for feedback of the pull request are read and kept. |
| `pull_request` | `edited` with a new base | 202 `retargeted`: the queued and failed jobs of the pull request take the new base branch (a stacked pull request moves to the base of its parent when the branch of the parent is deleted). Other edits: 202 `ignored`. |
| `installation` | `created`, `new_permissions_accepted`, `unsuspend` | Upserts the installation and the listed repositories; clears `suspended_at`. A new installation joins the org of an earlier installation of the same GitHub account, or else gets a new org named after the account (KNT-150). |
| `installation` | `suspend`, `deleted` | Sets `suspended_at` of the installation and cancels the jobs of its repositories. The rows stay. |
| `installation_repositories` | `added` / `removed` | Upserts / deletes the repositories (a deleted repository takes its jobs and reviews with it). |
| `issue_comment` | `created` | A `@kento-review` command (REV-7): a review or a resolve job, with a reaction and, when refused, a reply. REV-93: `reject #<id> <cause>` names a finding of the pull request by its short id. REV-107: `feedback <text>`, or a comment that quotes the request for feedback, is an answer about the reviews: kept with ❤️, no job, also on a closed pull request. |
| `pull_request_review_comment` | `created`, a reply in a thread | REV-93: `@kento-review reject <cause>` in the thread of a finding of Kentō names that finding. Another command in a thread gets 😕 and a reply: the commands go in the conversation. The first comment of a thread, an edit, a closed pull request: 202 `ignored`. |

The org of an event always comes from its installation (`installations.org_id`), never from a
session. An org can hold several installations (KNT-150): each repository keeps the installation
that sees it (`repos.installation_id`), and its token comes from that one.

A `pull_request` event also upserts its installation and repository, so the App needs no new `installation`
event after the webhook is added.

`repos.enabled` belongs to the Repos screen (REV-9): an admin of the org enables or disables a
repository there, and an event never changes it. A repository comes in disabled. A job needs it, and
so does a command in a comment: the command of a repository that is not enabled gets no token, no
reaction and no reply. Disabling a repository cancels its queued jobs; a running job ends, and the
published reviews stay.

The Repos screen reads the repositories of the installation on GitHub (`GET
/installation/repositories`, then the files of `.github/workflows`) with an installation token
`contents: read`: at the first visit, then when the last check is older than 10 minutes, in the
background; "Read GitHub again" runs it at once. The screen still finds a workflow of the old GitHub
Action, removed from this repository on 2026-11-15: one that calls `review.yml@<ref>` is
`reusable`, one that runs `review/sakuga-review.ts` without `workflow_call` is a `copy`. The switch
counter is the number of reviews that Kentō published on GitHub since the last failed job of the
repository, or since its last double publication (two reviews of a push at the same head and
level); at 20, the screen offers to remove `review.yml` on GitHub.

Duplicates:

- The delivery id of a job is unique: "Redeliver" on the page of the App creates no second job and
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
the service. The OpenRouter key of the service goes with a job only to a `trusted` runner of the
service that says it has no key of its own, never to a runner of an org (REV-130).

A wrong, missing or revoked runner token gets 401 with no reason. Revoke a runner with
`update runners set revoked_at = now() where id = …`: its next call gets 401.

Events: `runner.registered`, `runner.registration_refused`, `runner.auth_refused`, `job.claimed`,
`job.installation_token_failed`, `job.model_id_refused`, `job.result`, `job.lease_lost`, `job.lease_expired` (with `state`
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
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm -F @kento-review/web dev
```

| Command                                    | Does                                                         |
| ------------------------------------------ | ------------------------------------------------------------ |
| `pnpm -F @kento-review/web lint`          | oxlint                                                       |
| `pnpm -F @kento-review/web typecheck`     | `tsc --noEmit`                                               |
| `pnpm -F @kento-review/web test`          | Unit tests, no database.                                     |
| `pnpm -F @kento-review/web test:db`       | Tests against Postgres. Needs `TEST_DATABASE_URL`, see below. |
| `pnpm -F @kento-review/web db:generate`   | Writes the next migration after a change of `app/db/schema.ts`. |
| `pnpm -F @kento-review/web e2e`           | The screens in Chromium, with axe, at 1440 and 390 px, signed in through a fake GitHub (`e2e/fake-github.ts`, port 3499). Needs `E2E_DATABASE_URL` (a throwaway database: the server migrates it) and `pnpm -F @kento-review/web exec playwright install chromium` once. |
| `pnpm -F @kento-review/web design:board`  | Writes the frames of the design boards from the components, into `design/` at the root. That folder stays out of git. |
| `pnpm -F @kento-review/web measures`      | REV-112. The weekly measures of the findings of every org (handled rate, reject rate, calibration, findings for each pull request), from `DATABASE_URL`, read-only. `--weeks 12`, `--json`. |
| `pnpm -F @kento-review/web bench:cases <out.json>` | REV-112. The cases of the bench from the findings, from `DATABASE_URL`, read-only. See [eval/README.md](../../eval/README.md). |

`test:db` creates one throwaway database per test file on the server of `TEST_DATABASE_URL`, and
drops it at the end:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm -F @kento-review/web test:db
```

## Migrations

1. Change `app/db/schema.ts`.
2. `pnpm -F @kento-review/web db:generate --name <what>`: writes `drizzle/NNNN_<what>.sql` and its
   snapshot. Read the SQL, and commit it with the schema.
3. The next start applies it, in one transaction, under an advisory lock (two instances that start
   together migrate one after the other). A migration already applied is skipped.

A migration must keep the rows: add a column with a default or as nullable, and never drop or rename
a column that the running release still reads. A deploy runs the new migrations while the previous
container still serves.
