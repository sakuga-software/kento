import { PgDialect } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema.ts'

export type Db = PostgresJsDatabase<typeof schema>
/** A transaction of `Db`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** A database or a transaction: what a raw query of drizzle runs on. */
export type Executor = Pick<Db, 'execute'>

const dialect = new PgDialect()

/**
 * An `Executor` on a connection or a transaction of postgres.js, for a caller that holds one: a raw
 * query of drizzle then runs in that transaction, under its locks.
 */
export function executorOf(sql: postgres.Sql | postgres.TransactionSql): Executor {
  return {
    execute: (query) => {
      if (typeof query === 'string') return sql.unsafe(query) as never
      let { sql: text, params } = dialect.sqlToQuery(query.getSQL())
      return sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]) as never
    },
  } as Executor
}

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
