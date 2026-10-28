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

## 7. Each later deployment

- Automatic deployment on a push to `main` is a choice for Alex (Dokploy → `web` → **Auto Deploy**).
  Without it, deploy by hand after each merge that touches `apps/web`.
- A migration runs while the previous container still serves: it must keep that release working
  (see [README.md](README.md#migrations)).
- Roll back: Dokploy → `web` → **Deployments** → redeploy the previous one. A rollback does not undo a
  migration. The migrations only add, so the previous release still runs on the newer schema.
