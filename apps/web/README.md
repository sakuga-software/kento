# apps/web — Kentō web service

The service behind `review.sakuga.dev`. In milestone M2 it has no screen: it serves `GET /healthz`,
and the next tickets add the GitHub webhook (REV-3) and the runner API (REV-4).

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

## `GET /healthz`

Reads the database (the number of applied migrations) on every call, with a 2 s timeout.

```json
{"status":"ok","version":"0.1.0","commit":"abc1234","database":{"status":"ok","latencyMs":2,"migrations":1}}
```

- 200 when the database answers.
- 503 when it does not: `database.error` is a Postgres or Node error code (`ECONNREFUSED`, `42P01`,
  `timeout`…), never a host, user or query.

## Logs

One JSON object per line: `time`, `level`, `event`, and fields. `info` goes to stdout, `warn` and
`error` to stderr; Loki reads both. Events: `startup.*`, `shutdown.*`, `http.request` (every request
except a successful `/healthz`), `http.unhandled_error`.

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
