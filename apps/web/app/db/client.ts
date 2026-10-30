import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema.ts'

export type Db = PostgresJsDatabase<typeof schema>
/** A transaction of `Db`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** A database or a transaction: what a raw query of drizzle runs on. */
export type Executor = Pick<Db, 'execute'>

export interface Database {
  db: Db
  sql: postgres.Sql
  close(): Promise<void>
}

export function createDatabase(url: string, options: { max?: number } = {}): Database {
  let sql = postgres(url, {
    max: options.max ?? 10,
    connect_timeout: 5,
    idle_timeout: 60,
    // Postgres sends NOTICE messages, for example on `create schema if not exists`. They are not
    // errors, and the default handler prints them with console.log, outside the JSON logs.
    onnotice: () => {},
  })
  let db = drizzle(sql, { schema })
  return {
    db,
    sql,
    close: () => sql.end({ timeout: 5 }),
  }
}
