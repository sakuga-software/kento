// REV-16. The reads of the findings: a page at most, a cursor for the next one, and nothing of
// another org.
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { getFinding, InvalidCursorError, listFindingEvents, listFindings, PAGE_MAX, setFindingStatus } from '../../app/findings/store.ts'
import { createTestDatabase } from './helpers.ts'

const HEAD = '1'.repeat(40)

describe('findings store', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let orgId: string
  let otherOrgId: string
  let repoId: string
  let otherRepoId: string

  async function insertFinding(values: { repoId: string; prNumber: number; title: string; status?: string; createdAt?: string }) {
    let [row] = await database.sql<{ id: string }[]>`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence,
        status, first_seen_sha, last_seen_sha, created_at)
      values (${values.repoId}, ${values.prNumber}, '0123456789abcdef', 'abcdef012345', 'src/a.ts', 3, ${values.title},
        'major', 'bug', 90, ${values.status ?? 'open'}, ${HEAD}, ${HEAD}, ${values.createdAt ?? new Date().toISOString()})
      returning id`
    return row!.id
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url)
    let orgs = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login)
      values (1, 11, 'sakuga-software'), (2, 22, 'someone-else') returning id`
    orgId = orgs[0]!.id
    otherOrgId = orgs[1]!.id
    let repos = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled)
      values (${orgId}, 3001, 'sakuga-software/sakuga-review', true), (${otherOrgId}, 3002, 'someone-else/app', true)
      returning id`
    repoId = repos[0]!.id
    otherRepoId = repos[1]!.id
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('pages the findings of a pull request newest first, with a cursor that loses no row of the same instant', async () => {
    // Five findings created in the same microsecond: the cursor goes by the id after the time.
    let at = '2026-10-30T10:00:00.123456Z'
    let ids = []
    for (let n = 0; n < 5; n++) ids.push(await insertFinding({ repoId, prNumber: 7, title: `t${n}`, createdAt: at }))
    await insertFinding({ repoId, prNumber: 8, title: 'other pull request' })

    let seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      let page = await listFindings(database.sql, { orgId, repoId, prNumber: 7, limit: 2, cursor })
      assert.ok(page.items.length <= 2)
      seen.push(...page.items.map((f) => f.id))
      cursor = page.nextCursor
      pages++
    } while (cursor)
    assert.equal(pages, 3)
    assert.deepEqual(seen.sort(), ids.sort())
  })

  it('filters by status, and never reads the findings of another org', async () => {
    await insertFinding({ repoId, prNumber: 9, title: 'gone', status: 'fixed' })
    let theirs = await insertFinding({ repoId: otherRepoId, prNumber: 9, title: 'theirs' })

    let fixed = await listFindings(database.sql, { orgId, statuses: ['fixed'] })
    assert.deepEqual(
      fixed.items.map((f) => [f.title, f.status, f.repo]),
      [['gone', 'fixed', 'sakuga-software/sakuga-review']],
    )
    let all = await listFindings(database.sql, { orgId, limit: PAGE_MAX })
    assert.ok(!all.items.some((f) => f.id === theirs))
    // A repository of another org reads as empty, not as an error.
    assert.deepEqual((await listFindings(database.sql, { orgId, repoId: otherRepoId })).items, [])
    assert.equal(await getFinding(database.sql, { orgId, id: theirs }), null)
    assert.equal((await getFinding(database.sql, { orgId: otherOrgId, id: theirs }))?.title, 'theirs')
    assert.equal(await getFinding(database.sql, { orgId, id: 'not-a-uuid' }), null)
  })

  it('caps the limit, and refuses a cursor that it did not write', async () => {
    let page = await listFindings(database.sql, { orgId, limit: 10_000 })
    assert.ok(page.items.length <= PAGE_MAX)
    await assert.rejects(() => listFindings(database.sql, { orgId, cursor: 'bm90IGEgY3Vyc29y' }), InvalidCursorError)
  })

  it('pages the events of a finding oldest first', async () => {
    let id = await insertFinding({ repoId, prNumber: 10, title: 'with events' })
    for (let [type, actor] of [
      ['opened', 'kento'],
      ['dismissed', 'alex'],
      ['reopened', 'alex'],
    ]) {
      await database.sql`insert into finding_events (finding_id, type, actor) values (${id}, ${type!}, ${actor!})`
    }
    let first = await listFindingEvents(database.sql, { orgId, findingId: id, limit: 2 })
    let second = await listFindingEvents(database.sql, { orgId, findingId: id, limit: 2, cursor: first.nextCursor })
    assert.deepEqual([...first.items, ...second.items].map((e) => [e.type, e.actor]), [
      ['opened', 'kento'],
      ['dismissed', 'alex'],
      ['reopened', 'alex'],
    ])
    assert.equal(second.nextCursor, null)
    assert.deepEqual((await listFindingEvents(database.sql, { orgId: otherOrgId, findingId: id })).items, [])
  })

  it('REV-94: with keepDismissed, a finding fixed or stale, read under the lock, is not dismissed', async () => {
    for (let status of ['fixed', 'stale']) {
      let id = await insertFinding({ repoId, prNumber: 77, title: `race ${status}`, status })
      let change = await setFindingStatus(database.sql, { orgId, findingId: id, status: 'dismissed', reason: 'faux positif', actor: 'alex', source: 'command', keepDismissed: true })
      assert.equal(change.outcome, 'unchanged')
      assert.equal(change.outcome === 'unchanged' && change.finding.status, status)
      assert.equal((await listFindingEvents(database.sql, { orgId, findingId: id })).items.length, 0)
    }
  })

  it('refuses a reason on a finding that no person dismissed', async () => {
    await assert.rejects(
      () => database.sql`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence,
          status, status_reason, first_seen_sha, last_seen_sha)
        values (${repoId}, 1, '0123456789abcdef', 'abcdef012345', 'a', 1, 't', 'major', 'bug', 90, 'open', 'why', ${HEAD}, ${HEAD})`,
      /findings_reason_with_status/,
    )
  })
})
