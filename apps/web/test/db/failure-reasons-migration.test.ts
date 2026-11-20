// REV-115. Migration 0028 runs again on the reasons that the release before wrote: the label of the
// provider goes into straight quotes, and the screens read the reason.
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { migrationsFolder, runMigrations } from '../../app/db/migrate.ts'
import { jobReason } from '../../app/ui/reasons.tsx'
import { createTestDatabase } from './helpers.ts'

const HEAD = '1'.repeat(40)

describe('migration 0028', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url)
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('puts the label of the provider in straight quotes, twice with no change, and keeps the other reasons', async () => {
    let sql = database.sql
    let [org] = await sql<{ id: string }[]>`
      with org as (insert into orgs (name, slug) values ('sakuga-software', lower('sakuga-software')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 4242, 11, 'sakuga-software' from org returning org_id as id`
    let [repo] = await sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled) values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 7001, 'sakuga-software/orchard', true) returning id`
    let stored = [
      'the provider « Anthropic of Sakuga » refused its key (401): unauthorized',
      'the provider « vLLM » needs a trusted runner',
      'the key of the provider « vLLM » cannot be decrypted: bad tag',
      'lease expired 3 times',
      'clone failed: the quote « x » stays',
    ]
    for (let [n, reason] of stored.entries()) {
      await sql`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, failure_reason)
        values (${repo!.id}, 'lite', 'failed', ${n + 1}, ${HEAD}, 'main', ${reason})`
    }
    let migration = await readFile(path.join(migrationsFolder, '0028_failure_reasons_straight_quotes.sql'), 'utf8')
    for (let run = 0; run < 2; run++) {
      for (let statement of migration.split('--> statement-breakpoint')) await sql.unsafe(statement)
    }
    let rows = await sql<{ reason: string }[]>`select failure_reason as reason from jobs order by pr_number`
    assert.deepEqual(
      rows.map((r) => r.reason),
      [
        'the provider "Anthropic of Sakuga" refused its key (401): unauthorized',
        'the provider "vLLM" needs a trusted runner',
        'the key of the provider "vLLM" cannot be decrypted: bad tag',
        'lease expired 3 times',
        'clone failed: the quote « x » stays',
      ],
    )
    assert.equal(jobReason(rows[0]!.reason, null).text, 'the provider "Anthropic of Sakuga" refused its key, code 401')
    assert.match(jobReason(rows[1]!.reason, null).text, /only to a trusted runner/)
  })
})
