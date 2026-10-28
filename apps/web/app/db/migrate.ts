import { fileURLToPath } from 'node:url'

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

/** The SQL migrations that `drizzle-kit generate` writes. */
export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

/** Drizzle records the applied migrations in this table. */
export const migrationsTable = { schema: 'drizzle', table: '__drizzle_migrations' } as const

// Any constant works, as long as no other code of this database takes the same advisory lock.
const MIGRATION_LOCK_ID = 4_117_202_610

/**
 * Applies the migrations that the database does not have yet, in one transaction. A migration that
 * the database already has is skipped, so a restart or a second call changes nothing.
 *
 * Two instances that start together (a rolling deploy) migrate one after the other. The function
 * opens its own client with a single connection: that connection takes a session advisory lock, then
 * runs every migration query. Closing the client at the end ends the session, and Postgres releases
 * the lock with it, also when a migration or the connection fails.
 */
export async function runMigrations(
  databaseUrl: string,
  folder: string = migrationsFolder,
): Promise<void> {
  let sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, onnotice: () => {} })
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_ID})`
    await migrate(drizzle(sql), {
      migrationsFolder: folder,
      migrationsSchema: migrationsTable.schema,
      migrationsTable: migrationsTable.table,
    })
  } finally {
    await sql.end({ timeout: 5 })
  }
}
