// REV-17. The reads of the screen of a pull request, on orchard #142 of e2e/pull-seed.ts: four
// reviews, a finding moved with no new comment, a fix, a dismissal and a wontfix.
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { PULL_NUMBER, seedPull } from '../../e2e/pull-seed.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { COLUMNS_PAGE, createPullsStore, type PullSheet } from '../../app/pulls/store.ts'
import { createTestDatabase } from './helpers.ts'

function grid(sheet: PullSheet) {
  return Object.fromEntries(sheet.rows.map((r) => [r.finding.title.slice(0, 12), r.cells.map((c) => `${c.state}${c.carried ? '*' : ''}`)]))
}

describe('pulls store', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let seeded: Awaited<ReturnType<typeof seedPull>>

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url)
    seeded = await seedPull(database.sql)
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('reads the numbers of the pull request: reviews, scores, cost, findings by status', async () => {
    let store = createPullsStore(database.sql)
    let summary = (await store.summary(seeded.orgId, seeded.repoId, PULL_NUMBER))!
    assert.equal(summary.reviews, 4)
    assert.deepEqual(summary.lastScores, [4, 4])
    assert.equal(summary.headSha, 'd'.repeat(40))
    assert.equal(summary.costUsd!.toFixed(4), '0.5361')
    assert.deepEqual(summary.byStatus, { open: 1, fixed: 1, stale: 0, dismissed: 1, wontfix: 1 })
    assert.equal(summary.active, null)
  })

  it('never finds the pull request from another org, nor one with no job', async () => {
    let store = createPullsStore(database.sql)
    let [other] = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (99, 99, 'someone-else') returning id`
    assert.equal(await store.summary(other!.id, seeded.repoId, PULL_NUMBER), null)
    assert.equal(await store.summary(seeded.orgId, seeded.repoId, 999), null)
    assert.equal(await store.summary(seeded.orgId, 'not-a-uuid', PULL_NUMBER), null)
  })

  it('shows a finding moved with no new comment, a fix, a dismissal and a wontfix, review by review', async () => {
    let store = createPullsStore(database.sql)
    let summary = (await store.summary(seeded.orgId, seeded.repoId, PULL_NUMBER))!
    let sheet = await store.sheet(summary.target, {})
    assert.deepEqual(
      sheet.columns.map((c) => `R${c.number} ${c.level} ${c.score} ${c.findings}`),
      ['R1 lite 2 3', 'R2 balanced 3 3', 'R3 heavy 4 2', 'R4 lite 4 1'],
    )
    assert.deepEqual(grid(sheet), {
      'Le jeton de ': ['posted', 'moved', 'found', 'found'],
      'Clé API écri': ['posted', 'fixed', 'fixed*', 'fixed*'],
      'Liste sans c': ['posted', 'found', 'dismissed', 'dismissed*'],
      'Requête SQL ': ['none', 'posted', 'absent', 'wontfix'],
    })
    assert.equal(sheet.olderCursor, null)
    assert.equal(sheet.nextRowsCursor, null)
  })

  it('filters the rows by status', async () => {
    let store = createPullsStore(database.sql)
    let summary = (await store.summary(seeded.orgId, seeded.repoId, PULL_NUMBER))!
    let sheet = await store.sheet(summary.target, { statuses: ['dismissed', 'wontfix'] })
    assert.deepEqual(
      sheet.rows.map((r) => r.finding.status),
      ['dismissed', 'wontfix'],
    )
  })

  it('reads a result whose findings are not what a runner sends, with no error', async () => {
    let store = createPullsStore(database.sql)
    let [job] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref)
      values (${seeded.repoId}, 'review', 'lite', 'done', 77, ${'e'.repeat(40)}, 'main') returning id`
    let result = { findings: [{ path: 'src/a.ts', title: 't', anchor: 'x', line: 1.5 }, 3, null, { path: 'src/a.ts', title: 't', line: 99999999999 }] }
    await database.sql`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result, published_at)
      values (${job!.id}, ${seeded.repoId}, 77, ${'e'.repeat(40)}, 3, 'm', ${JSON.stringify(result)}::text::jsonb, now())`
    await database.sql`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, first_seen_sha, last_seen_sha)
      values (${seeded.repoId}, 77, '', 'k', 'src/a.ts', 3, 't', 'minor', 'bug', 80, ${'e'.repeat(40)}, ${'e'.repeat(40)})`
    let summary = (await store.summary(seeded.orgId, seeded.repoId, 77))!
    let sheet = await store.sheet(summary.target, {})
    assert.equal(sheet.columns[0]!.findings, 4)
    assert.equal(sheet.rows.length, 1)
  })

  it('reads the events of a review that was not marked as published, written after its result', async () => {
    let store = createPullsStore(database.sql)
    let [job] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref)
      values (${seeded.repoId}, 'review', 'lite', 'done', 78, ${'f'.repeat(40)}, 'main') returning id`
    let result = { findings: [{ path: 'src/b.ts', title: 'Unmarked', anchor: 5, line: 5, fingerprint: 'ffffffffffffffff' }] }
    let [review] = await database.sql<{ id: string }[]>`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result, created_at)
      values (${job!.id}, ${seeded.repoId}, 78, ${'f'.repeat(40)}, 3, 'm', ${JSON.stringify(result)}::text::jsonb, now() - interval '1 minute')
      returning id`
    let [finding] = await database.sql<{ id: string }[]>`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, first_seen_sha, last_seen_sha)
      values (${seeded.repoId}, 78, 'ffffffffffffffff', 'k', 'src/b.ts', 5, 'Unmarked', 'minor', 'bug', 80, ${'f'.repeat(40)}, ${'f'.repeat(40)})
      returning id`
    await database.sql`insert into finding_events (finding_id, review_id, type, actor) values (${finding!.id}, ${review!.id}, 'opened', 'kento')`
    let summary = (await store.summary(seeded.orgId, seeded.repoId, 78))!
    let sheet = await store.sheet(summary.target, {})
    assert.deepEqual(sheet.rows[0]!.cells.map((c) => c.state), ['posted'])
  })

  it('pages the reviews from the newest back, and reads the review before the page for a move', async () => {
    let store = createPullsStore(database.sql)
    // Four more reviews of the same head, each finding A again at line 47: ten reviews in all.
    let [job] = await database.sql<{ id: string }[]>`select job_id as id from reviews where id = ${seeded.reviews[3]!}`
    for (let n = 0; n < 6; n++) {
      let [copy] = await database.sql<{ id: string }[]>`
        insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref)
        select repo_id, kind, level, 'done', pr_number, head_sha, base_ref from jobs where id = ${job!.id} returning id`
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, published_at, created_at)
        select ${copy!.id}, repo_id, pr_number, head_sha, score, model, cost_usd, result, now() + ${`${n} seconds`}::interval, now() + ${`${n} seconds`}::interval
        from reviews where id = ${seeded.reviews[3]!}`
    }
    let summary = (await store.summary(seeded.orgId, seeded.repoId, PULL_NUMBER))!
    assert.equal(summary.reviews, 10)
    let newest = await store.sheet(summary.target, {})
    assert.equal(newest.columns.length, COLUMNS_PAGE)
    assert.deepEqual(newest.columns.map((c) => c.number), [5, 6, 7, 8, 9, 10])
    assert.ok(newest.olderCursor)
    let older = await store.sheet(summary.target, { reviewsCursor: newest.olderCursor })
    assert.deepEqual(older.columns.map((c) => c.number), [1, 2, 3, 4])
    assert.equal(older.olderCursor, null)

    // R4 is the review before the newest page: A found at 47 by R4 and by R5 is not moved.
    assert.equal(grid(newest)['Le jeton de ']![0], 'found')
  })
})
