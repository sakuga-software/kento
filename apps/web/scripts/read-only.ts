// A connection to the database of DATABASE_URL that refuses every write: Postgres opens each
// transaction read-only. The scripts of the measures read the production database with it.
import postgres from 'postgres'

export function readOnlyDatabase(): postgres.Sql {
  let url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set.')
    process.exit(2)
  }
  return postgres(url, { max: 2, connect_timeout: 10, onnotice: () => {}, connection: { default_transaction_read_only: true } })
}

/** The Monday at 00:00 UTC of the week `weeks - 1` weeks before the week of `now`: the first week is whole. */
export function weeksAgo(weeks: number, now = new Date()): Date {
  let start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  let sinceMonday = (start.getUTCDay() + 6) % 7
  start.setUTCDate(start.getUTCDate() - sinceMonday - 7 * (weeks - 1))
  return start
}

/** Runs `main`, and prints the message of an error without the URL: a connection error can hold it. */
export async function run(main: () => Promise<void>): Promise<void> {
  try {
    await main()
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)
    let url = process.env.DATABASE_URL
    console.error(url ? message.replaceAll(url, '<DATABASE_URL>') : message)
    process.exitCode = 1
  }
}
