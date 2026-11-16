// REV-38. The purge of the jobs that ended more than RETENTION_DAYS ago: what goes, what stays, and
// no foreign key broken (the findings of REV-16 and their events name the reviews).
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { PURGE_BATCH, purgeOldJobs, RETENTION_DAYS, startJobsPurge } from '../../app/db/retention.ts'
import { createReposStore, SWITCH_TARGET } from '../../app/repos/store.ts'
import { createTestDatabase } from './helpers.ts'

const OLD = RETENTION_DAYS + 20

describe('purge of the old jobs (REV-38)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let orgId: string
  let busy: string
  let idle: string
  let githubReviewIds = 0

  /** A job created `days` days ago, in `state`, with a review (published or not) or a resolution. */
  async function job(
    repoId: string,
    name: string,
    days: number,
    state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled',
    output: 'published' | 'unpublished' | 'resolution' | null = null,
  ) {
    let [row] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, kind, level, state, pr_number, head_sha, base_ref, created_at, finished_at, updated_at)
      values (${repoId}, ${output === 'resolution' ? 'resolve' : 'review'}, 'lite', ${state}, 1, ${name}, 'main',
        now() - make_interval(days => ${days}), now() - make_interval(days => ${days}), now() - make_interval(days => ${days}))
      returning id`
    let id = row!.id
    if (output === 'published' || output === 'unpublished') {
      let published = output === 'published'
      await database.sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, published_at, github_review_id, created_at)
        values (${id}, ${repoId}, 1, ${name}, 4, 'm', 0.01, '{"findings":[]}',
          ${published ? database.sql`now() - make_interval(days => ${days})` : null}, ${published ? (githubReviewIds += 1) : null},
          now() - make_interval(days => ${days}))`
    }
    if (output === 'resolution') {
      await database.sql`
        insert into resolutions (job_id, repo_id, pr_number, head_sha, result, created_at)
        values (${id}, ${repoId}, 1, ${name}, '{"resolved":[]}', now() - make_interval(days => ${days}))`
    }
    return id
  }

  async function names() {
    let rows = await database.sql<{ name: string }[]>`select head_sha as name from jobs order by head_sha`
    return rows.map((r) => r.name)
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url)
    let [org] = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (1, 11, 'sakuga-software') returning id`
    orgId = org!.id
    let repos = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled)
      values (${orgId}, 1, 'sakuga-software/busy', true), (${orgId}, 2, 'sakuga-software/idle', true)
      returning id`
    busy = repos[0]!.id
    idle = repos[1]!.id
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('deletes the old ended jobs with their reviews and resolutions, and keeps what the screens and the findings read', async () => {
    // busy: SWITCH_TARGET recent published reviews, so its old ones are not among its last ones.
    for (let n = 0; n < SWITCH_TARGET; n++) await job(busy, `busy-recent-${String(n).padStart(2, '0')}`, 1 + n, 'done', 'published')
    let oldReviewJob = await job(busy, 'busy-old-published', OLD, 'done', 'published')
    await job(busy, 'busy-old-unpublished', OLD, 'done', 'unpublished')
    await job(busy, 'busy-old-resolution', OLD, 'done', 'resolution')
    await job(busy, 'busy-old-cancelled', OLD, 'cancelled')
    await job(busy, 'busy-old-failed-last', OLD, 'failed')
    await job(busy, 'busy-old-failed-earlier', OLD + 10, 'failed')
    await job(busy, 'busy-old-queued', OLD, 'queued')
    await job(busy, 'busy-old-running', OLD, 'running')
    await job(busy, 'busy-young-done', RETENTION_DAYS - 1, 'done')
    // idle: no push for a year. Its last published reviews stay, its unpublished one goes.
    await job(idle, 'idle-old-published-1', OLD + 100, 'done', 'published')
    await job(idle, 'idle-old-published-2', OLD + 90, 'done', 'published')
    await job(idle, 'idle-old-unpublished', OLD + 80, 'done', 'unpublished')

    // A finding of REV-16 first and last found by the old review, with its event; a rule of REV-19.
    let [review] = await database.sql<{ id: string }[]>`select id from reviews where job_id = ${oldReviewJob}`
    let [rule] = await database.sql<{ id: string }[]>`insert into rules (org_id, title, body) values (${orgId}, 'Rule', 'Body.') returning id`
    let [finding] = await database.sql<{ id: string }[]>`
      insert into findings (repo_id, pr_number, fingerprint, key, rule_id, path, line, title, severity, category, confidence,
        first_review_id, last_review_id, first_seen_sha, last_seen_sha)
      values (${busy}, 1, '0123456789abcdef', 'k', ${rule!.id}, 'src/a.ts', 3, 'A finding', 'major', 'bug', 90,
        ${review!.id}, ${review!.id}, 'busy-old-published', 'busy-old-published')
      returning id`
    await database.sql`
      insert into finding_events (finding_id, review_id, type, actor) values (${finding!.id}, ${review!.id}, 'opened', 'kento')`

    let screenBefore = (await createReposStore(database.sql).list(orgId)).rows

    let deleted = await purgeOldJobs(database.sql, { batch: 2 })

    assert.equal(deleted, 6)
    assert.deepEqual(
      (await names()).filter((n) => !n.startsWith('busy-recent-')),
      ['busy-old-failed-last', 'busy-old-queued', 'busy-old-running', 'busy-young-done', 'idle-old-published-1', 'idle-old-published-2'],
    )
    assert.equal((await names()).filter((n) => n.startsWith('busy-recent-')).length, SWITCH_TARGET)
    let [counts] = await database.sql<{ reviews: number; resolutions: number; findings: number; events: number }[]>`
      select (select count(*)::int from reviews) as reviews, (select count(*)::int from resolutions) as resolutions,
        (select count(*)::int from findings) as findings, (select count(*)::int from finding_events) as events`
    assert.deepEqual({ ...counts }, { reviews: SWITCH_TARGET + 2, resolutions: 0, findings: 1, events: 1 })

    // The finding and its event stay, with no review; the rule stays cited.
    let [kept] = await database.sql<{ first: string | null; last: string | null; rule: string | null; event: string | null }[]>`
      select findings.first_review_id as first, findings.last_review_id as last, findings.rule_id as rule,
        finding_events.review_id as event
      from findings join finding_events on finding_events.finding_id = findings.id`
    assert.deepEqual({ ...kept }, { first: null, last: null, rule: rule!.id, event: null })

    // No row names a job or a review that is gone.
    let [orphans] = await database.sql<{ n: number }[]>`
      select (
        (select count(*) from reviews where not exists (select 1 from jobs where jobs.id = reviews.job_id))
        + (select count(*) from resolutions where not exists (select 1 from jobs where jobs.id = resolutions.job_id))
        + (select count(*) from findings where (first_review_id is not null and not exists (select 1 from reviews where reviews.id = first_review_id))
            or (last_review_id is not null and not exists (select 1 from reviews where reviews.id = last_review_id)))
        + (select count(*) from finding_events where review_id is not null and not exists (select 1 from reviews where reviews.id = review_id))
      )::int as n`
    assert.equal(orphans!.n, 0)

    // The Repos screen reads the same streak, reset and last review as before.
    assert.deepEqual((await createReposStore(database.sql).list(orgId)).rows, screenBefore)

    // A second run finds nothing more.
    assert.equal(await purgeOldJobs(database.sql), 0)
  })

  it('stops after its current batch when the server shuts down, and the next run deletes the rest', async () => {
    await database.sql`
      insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, created_at)
      select ${idle}, 'lite', 'done', 1, 'backlog-' || g, 'main', now() - make_interval(days => ${OLD})
      from generate_series(1, ${PURGE_BATCH * 2 + 10}) g`
    let backlog = async () => {
      let [row] = await database.sql<{ n: number }[]>`select count(*)::int as n from jobs where head_sha like 'backlog-%'`
      return row!.n
    }

    // The first run starts at once; the shutdown comes while its first batch runs.
    let stop = startJobsPurge(database.sql, 60 * 60 * 1000)
    await stop()

    assert.equal(await backlog(), PURGE_BATCH + 10)
    assert.equal(await purgeOldJobs(database.sql), PURGE_BATCH + 10)
    assert.equal(await backlog(), 0)
  })
})
