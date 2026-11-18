// REV-112. The weekly measures and the cases of the bench, read from Postgres.
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { caseFindings } from '../../app/findings/bench-cases.ts'
import { closedFindings, measuresReport, reviewVolume } from '../../app/findings/measures.ts'
import { readOnlyDatabase } from '../../scripts/read-only.ts'
import { createTestDatabase } from './helpers.ts'

const HEAD = '1'.repeat(40)
const LATER = '2'.repeat(40)
const SINCE = new Date('2026-10-26T00:00:00Z')

describe('the measures of the reviews', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let pantry: string
  let orchard: string
  let n = 0

  async function review(repoId: string, pr: number, publishedAt: string | null, findings: object[] = []): Promise<string> {
    let sql = database.sql
    let [job] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, github_delivery_id)
      values (${repoId}, 'lite', ${pr}, ${HEAD}, ${`delivery-${++n}`}) returning id`
    let [row] = await sql<{ id: string }[]>`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result, published_at)
      values (${job!.id}, ${repoId}, ${pr}, ${HEAD}, 4, 'm', ${JSON.stringify({ findings })}::text::jsonb, ${publishedAt})
      returning id`
    return row!.id
  }

  /** A finding whose history is `events`, each `[type, time, reason?]`; its status is the last one. */
  async function finding(
    repoId: string,
    events: [string, string, string?][],
    fields: { confidence?: number; severity?: string; category?: string; pr?: number; reviewId?: string; fingerprint?: string } = {},
  ) {
    let last = events.at(-1)!
    let status = last[0] === 'reopened' || last[0] === 'opened' ? 'open' : last[0]
    let fingerprint = fields.fingerprint ?? `f${++n}`
    let [row] = await database.sql<{ id: string }[]>`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence,
        status, status_reason, first_review_id, last_review_id, first_seen_sha, last_seen_sha, created_at, updated_at)
      values (${repoId}, ${fields.pr ?? 1}, ${fingerprint}, ${`k${n}`}, 'src/a.ts', ${n}, ${`Title ${n}`}, ${fields.severity ?? 'major'},
        ${fields.category ?? 'bug'}, ${fields.confidence ?? 80}, ${status}, ${status === 'dismissed' || status === 'wontfix' ? (last[2] ?? null) : null},
        ${fields.reviewId ?? null}, ${fields.reviewId ?? null}, ${HEAD}, ${LATER}, '2026-10-01T00:00:00Z', ${last[1]})
      returning id`
    for (let [type, at, reason] of [['opened', '2026-10-01T00:00:00Z'] as [string, string, string?], ...events]) {
      await database.sql`
        insert into finding_events (finding_id, type, actor, reason, created_at)
        values (${row!.id}, ${type}, 'kento', ${reason ?? null}, ${at})`
    }
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url)
    let sql = database.sql
    let [org] = await sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (1, 11, 'sakuga-software') returning id`
    let [other] = await sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (2, 22, 'other') returning id`
    let repos = await sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled)
      values (${org!.id}, 3001, 'sakuga-software/pantry', true), (${other!.id}, 3002, 'other/orchard', true)
      returning id`
    ;[pantry, orchard] = [repos[0]!.id, repos[1]!.id]

    // Week of 2026-11-02 (a Tuesday, and a Sunday at 23:30 UTC that stays in that week).
    let published = await review(pantry, 1, '2026-11-03T10:00:00Z', [{ fingerprint: 'scenario-fp', scenario: 'A cart with a code.' }])
    await review(pantry, 2, '2026-11-08T23:30:00Z')
    await review(pantry, 2, '2026-11-04T10:00:00Z')
    await finding(pantry, [['fixed', '2026-11-03T12:00:00Z']], { reviewId: published, fingerprint: 'scenario-fp' })
    await finding(pantry, [['dismissed', '2026-11-04T12:00:00Z', 'False positive']], { confidence: 100, reviewId: published })
    await finding(pantry, [['wontfix', '2026-11-08T23:30:00Z', 'Accepted']], { severity: 'minor', category: 'contract' })
    // Week of 2026-10-26, in another org: every org counts.
    await review(orchard, 9, '2026-10-27T10:00:00Z')
    await finding(orchard, [['dismissed', '2026-10-28T10:00:00Z', 'Off topic']], { confidence: 55, pr: 9 })
    // Out of the measures: open, stale, reopened after a fix, closed before the window, a review not published.
    await finding(pantry, [['opened', '2026-11-03T10:00:00Z']])
    await finding(pantry, [['stale', '2026-11-03T10:00:00Z']])
    await finding(pantry, [['fixed', '2026-11-03T10:00:00Z'], ['reopened', '2026-11-04T10:00:00Z']])
    await finding(pantry, [['fixed', '2026-10-20T10:00:00Z']])
    await review(pantry, 3, null)
    // Dismissed by a 👎, with no reason: a closed finding, but no case of the bench.
    await finding(pantry, [['dismissed', '2026-11-05T10:00:00Z']], { pr: 4 })
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('reads the findings closed since a date, in the week of the event that closed them, in UTC', async () => {
    let rows = await closedFindings(database.sql, SINCE)
    let sorted = rows.map((r) => [r.week, r.repo, r.status, r.confidence]).sort((a, b) => String(a).localeCompare(String(b)))
    assert.deepEqual(sorted, [
      ['2026-10-26', 'other/orchard', 'dismissed', 55],
      ['2026-11-02', 'sakuga-software/pantry', 'dismissed', 100],
      ['2026-11-02', 'sakuga-software/pantry', 'dismissed', 80],
      ['2026-11-02', 'sakuga-software/pantry', 'fixed', 80],
      ['2026-11-02', 'sakuga-software/pantry', 'wontfix', 80],
    ])
  })

  it('counts the pull requests of the published reviews, and the findings that they found first', async () => {
    let rows = await reviewVolume(database.sql, SINCE)
    assert.deepEqual(
      rows.sort((a, b) => a.week.localeCompare(b.week)),
      [
        { week: '2026-10-26', repo: 'other/orchard', prs: 1, findings: 0 },
        { week: '2026-11-02', repo: 'sakuga-software/pantry', prs: 2, findings: 2 },
      ],
    )
    let report = await measuresReport(database.sql, SINCE)
    let week = report.weeks.at(-1)!
    assert.deepEqual([week.all.fixed, week.all.dismissed, week.all.wontfix], [1, 2, 1])
    assert.equal(week.volume.perPr, 1)
  })

  it('reads the findings that make cases of the bench, with the scenario of their last review', async () => {
    let rows = await caseFindings(database.sql, SINCE)
    assert.deepEqual(
      rows.map((r) => [r.repo, r.pr, r.status, r.reason, r.sha, r.scenario]),
      [
        ['other/orchard', 9, 'dismissed', 'Off topic', LATER, null],
        ['sakuga-software/pantry', 1, 'fixed', null, LATER, 'A cart with a code.'],
        ['sakuga-software/pantry', 1, 'dismissed', 'False positive', LATER, null],
        ['sakuga-software/pantry', 1, 'wontfix', 'Accepted', LATER, null],
      ],
    )
  })

  it('reads through a connection of the scripts that refuses every write', async () => {
    let saved = process.env.DATABASE_URL
    process.env.DATABASE_URL = test.url
    let sql = readOnlyDatabase()
    try {
      assert.equal((await measuresReport(sql, SINCE)).weeks.length, 2)
      await assert.rejects(sql`insert into orgs (github_installation_id, github_account_id, login) values (3, 33, 'x')`, /read-only transaction/)
    } finally {
      await sql.end({ timeout: 5 })
      if (saved === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved
    }
  })
})
