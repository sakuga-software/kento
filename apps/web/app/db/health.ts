import type postgres from 'postgres'

import { migrationsTable } from './migrate.ts'

export type DatabaseHealth =
  | { status: 'ok'; latencyMs: number; migrations: number }
  | { status: 'error'; latencyMs: number; error: string }

export type CheckDatabase = () => Promise<DatabaseHealth>

/**
 * Reads the database: the number of applied migrations. The check fails after `timeoutMs`, so a
 * database that does not answer makes `/healthz` fail fast instead of hanging.
 *
 * At most one health query is in flight. A query that times out stays open until the database
 * answers or the connection drops; the next checks wait on that same query instead of opening a
 * new one. Without this, a slow database would fill the pool with health queries.
 */
export function createDatabaseCheck(sql: postgres.Sql, timeoutMs = 2000): CheckDatabase {
  let inFlight: Promise<number> | undefined

  function readMigrationCount(): Promise<number> {
    inFlight ??= sql<{ count: number }[]>`
      select count(*)::int as count from ${sql(migrationsTable.schema)}.${sql(migrationsTable.table)}
    `
      .then((rows) => rows[0]?.count ?? 0)
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  return async () => {
    let start = performance.now()
    let timer: NodeJS.Timeout | undefined
    try {
      let timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer after ${timeoutMs} ms`)), timeoutMs)
      })
      let migrations = await Promise.race([readMigrationCount(), timeout])
      return { status: 'ok', latencyMs: elapsed(start), migrations }
    } catch (error) {
      return { status: 'error', latencyMs: elapsed(start), error: publicError(error) }
    } finally {
      clearTimeout(timer)
    }
  }
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start)
}

// The health response is public. It names the kind of failure (a Postgres or Node error code),
// never the host, user or query.
function publicError(error: unknown): string {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    let code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code
    if (current instanceof Error && current.message.startsWith('no answer after')) return 'timeout'
    current = (current as { cause?: unknown }).cause
  }
  return 'unavailable'
}
