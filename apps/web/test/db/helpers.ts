import { randomBytes } from 'node:crypto'

import postgres from 'postgres'

/**
 * Creates an empty database for one test file on the server of `TEST_DATABASE_URL`, and drops it at
 * the end. The tests never touch the database of the URL itself.
 */
export async function createTestDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  let adminUrl = process.env.TEST_DATABASE_URL
  if (!adminUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start a Postgres container and set it, see apps/web/README.md.',
    )
  }
  let name = `kento_test_${randomBytes(6).toString('hex')}`
  let admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  await admin.unsafe(`create database ${name}`)
  let url = new URL(adminUrl)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    async drop() {
      await admin.unsafe(`drop database if exists ${name} with (force)`)
      await admin.end({ timeout: 5 })
    },
  }
}
