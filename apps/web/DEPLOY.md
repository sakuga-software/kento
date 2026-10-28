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

## 5. Each later deployment

- Automatic deployment on a push to `main` is a choice for Alex (Dokploy → `web` → **Auto Deploy**).
  Without it, deploy by hand after each merge that touches `apps/web`.
- A migration runs while the previous container still serves: it must keep that release working
  (see [README.md](README.md#migrations)).
- Roll back: Dokploy → `web` → **Deployments** → redeploy the previous one. A rollback does not undo a
  migration. The migrations only add, so the previous release still runs on the newer schema.
