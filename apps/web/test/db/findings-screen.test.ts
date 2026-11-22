// REV-18. The list of the Findings screen against Postgres: the filters in SQL, the counts of the
// tabs, and a keyset page that goes forward and back without losing a row.
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { findingFacets, listFindingScreen } from '../../app/findings/screen.ts'
import { createTestDatabase, insertOrg } from './helpers.ts'

const HEAD = '1'.repeat(40)
const NEXT = '2'.repeat(40)


describe('the Findings screen list', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let orgId: string
  let repoId: string
  let otherRepoId: string
  let ruleId: string
  let ids: string[] = []

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url)
    let sql = database.sql
    let orgs = [{ id: await insertOrg(sql, 'sakuga-software', 1, 11) }, { id: await insertOrg(sql, 'someone-else', 2, 22) }]
    orgId = orgs[0]!.id
    let repos = await sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
      values (${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), 3001, 'sakuga-software/sakuga-review', true), (${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), 3002, 'sakuga-software/orchard', true),
        (${orgs[1]!.id}, (select id from installations where org_id = ${orgs[1]!.id} order by created_at limit 1), 3003, 'someone-else/app', true), (${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), 3004, 'sakuga-software/quiet', true)
      returning id`
    repoId = repos[0]!.id
    otherRepoId = repos[1]!.id
    let [rule] = await sql<{ id: string }[]>`
      insert into rules (org_id, repo_id, title, body) values (${orgId}, ${repoId}, 'No any', 'Type it.') returning id`
    ruleId = rule!.id
    // 12 findings of sakuga-review, one a minute, the newest last; 3 of orchard; 1 of another org.
    for (let n = 0; n < 12; n++) {
      let [row] = await sql<{ id: string }[]>`
        insert into findings (repo_id, pr_number, fingerprint, key, rule_id, path, line, title, severity, category, confidence,
          status, status_reason, first_seen_sha, last_seen_sha, created_at)
        values (${repoId}, ${10 + (n % 3)}, ${`f${n}`}, ${`k${n}`}, ${n % 4 === 0 ? ruleId : null}, ${`src/file_${n}.ts`}, ${n + 1},
          ${`Finding ${n}`}, ${['critical', 'major', 'minor'][n % 3]!}, 'bug', 80, ${n % 5 === 4 ? 'dismissed' : 'open'},
          ${n % 5 === 4 ? 'Off topic' : null}, ${HEAD}, ${n === 0 ? NEXT : HEAD}, now() - ${`${60 - n} minutes`}::interval)
        returning id`
      ids.push(row!.id)
    }
    await sql`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
        first_seen_sha, last_seen_sha)
      values (${otherRepoId}, 5, 'a', 'a', 'lib/100%_sure.ts', 1, 'Orchard open', 'major', 'security', 70, 'open', ${HEAD}, ${HEAD}),
        (${otherRepoId}, 5, 'b', 'b', 'lib/b.ts', 1, 'Orchard fixed', 'minor', 'data', 70, 'fixed', ${HEAD}, ${HEAD}),
        (${otherRepoId}, 5, 'c', 'c', 'lib/c.ts', 1, 'Orchard stale', 'minor', 'data', 70, 'stale', ${HEAD}, ${HEAD}),
        (${repos[2]!.id}, 5, 'd', 'd', 'x.ts', 1, 'Theirs', 'major', 'bug', 70, 'open', ${HEAD}, ${HEAD})`
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('lists the open findings of the org, newest first, with the counts of each tab', async () => {
    let page = await listFindingScreen(database.sql, orgId)
    assert.deepEqual(page.counts, { open: 11, fixed: 1, dismissed: 2, wontfix: 0, stale: 1, closed: 4, all: 15 })
    assert.equal(page.matching, 11)
    assert.equal(page.rows[0]!.title, 'Orchard open')
    assert.equal(page.rows[1]!.title, 'Finding 11')
    assert.ok(page.rows.every((row) => row.status === 'open' && row.repo.startsWith('sakuga-software/')))
    assert.equal(page.offset, 0)
    assert.equal(page.page, 1)
    assert.equal(page.pages, 1)
  })

  it('filters by repository, priority, rule, search and tab, in SQL', async () => {
    let byRepo = await listFindingScreen(database.sql, orgId, { view: 'all', repoId: otherRepoId })
    assert.deepEqual(byRepo.rows.map((r) => r.title).sort(), ['Orchard fixed', 'Orchard open', 'Orchard stale'])
    assert.deepEqual(byRepo.counts, { open: 1, fixed: 1, dismissed: 0, wontfix: 0, stale: 1, closed: 2, all: 3 })

    let critical = await listFindingScreen(database.sql, orgId, { severity: 'critical' })
    assert.deepEqual(critical.rows.map((r) => r.title), ['Finding 6', 'Finding 3', 'Finding 0'])

    let ruled = await listFindingScreen(database.sql, orgId, { view: 'all', ruleId })
    assert.deepEqual(ruled.rows.map((r) => [r.title, r.ruleTitle]), [
      ['Finding 8', 'No any'],
      ['Finding 4', 'No any'],
      ['Finding 0', 'No any'],
    ])

    let dismissed = await listFindingScreen(database.sql, orgId, { view: 'dismissed' })
    assert.deepEqual(dismissed.rows.map((r) => [r.title, r.statusReason]), [
      ['Finding 9', 'Off topic'],
      ['Finding 4', 'Off topic'],
    ])
    let byReason = await listFindingScreen(database.sql, orgId, { view: 'dismissed', reason: 'Off topic' })
    assert.equal(byReason.rows.length, 2)
    assert.equal((await listFindingScreen(database.sql, orgId, { view: 'dismissed', reason: 'False positive' })).rows.length, 0)
    // A reason of an earlier release, longer than REASON_MAX: the link carries its first 500 characters, and finds it.
    let long = `Too long ${'x'.repeat(600)}`
    await database.sql`update findings set status_reason = ${`  ${long}`} where title = 'Finding 9'`
    let byLong = await listFindingScreen(database.sql, orgId, { view: 'dismissed', reason: long.slice(0, 500) })
    // Any case, and a cut that ends on a space: the same rule on both sides.
    assert.equal((await listFindingScreen(database.sql, orgId, { view: 'dismissed', reason: 'OFF TOPIC' })).rows.length, 1)
    assert.deepEqual(byLong.rows.map((r) => r.title), ['Finding 9'])
    // The 500th character is a space: both sides drop it.
    let spaced = `${'a'.repeat(499)} ${'b'.repeat(10)}`
    await database.sql`update findings set status_reason = ${spaced} where title = 'Finding 9'`
    assert.deepEqual((await listFindingScreen(database.sql, orgId, { view: 'dismissed', reason: spaced })).rows.map((r) => r.title), ['Finding 9'])
    assert.deepEqual((await listFindingScreen(database.sql, orgId, { view: 'dismissed', reason: 'a'.repeat(499) })).rows.map((r) => r.title), ['Finding 9'])
    await database.sql`update findings set status_reason = 'Off topic' where title = 'Finding 9'`
    let closed = await listFindingScreen(database.sql, orgId, { view: 'closed', repoId })
    assert.deepEqual(closed.rows.map((r) => r.status), ['dismissed', 'dismissed'])

    // The search reads the title and the path, any case; % and _ stand for themselves.
    assert.deepEqual((await listFindingScreen(database.sql, orgId, { search: 'FILE_1' })).rows.map((r) => r.title), [
      'Finding 11',
      'Finding 10',
      'Finding 1',
    ])
    assert.deepEqual((await listFindingScreen(database.sql, orgId, { search: '0%_s' })).rows.map((r) => r.title), ['Orchard open'])
    assert.equal((await listFindingScreen(database.sql, orgId, { search: 'file%1' })).rows.length, 0)
  })

  it('pages by number, with the position and the count of pages (KNT-148)', async () => {
    let pages = []
    for (let number = 1; number <= 3; number++) pages.push(await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5, page: number }))
    assert.deepEqual(pages.flatMap((p) => p.rows.map((r) => r.id)), [...ids].reverse())
    assert.deepEqual(pages.map((p) => [p.page, p.pages, p.offset, p.rows.length]), [[1, 3, 0, 5], [2, 3, 5, 5], [3, 3, 10, 2]])
    // The same page twice: the same rows.
    let again = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5, page: 2 })
    assert.deepEqual(again.rows.map((r) => r.id), pages[1]!.rows.map((r) => r.id))
  })

  it('gives the last page for a page past it, and the first page for a page that is not one', async () => {
    let last = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5, page: 3 })
    let past = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5, page: 99 })
    assert.deepEqual([past.page, past.offset], [3, 10])
    assert.deepEqual(past.rows.map((r) => r.id), last.rows.map((r) => r.id))
    for (let page of [0, -1, 1.5, Number.NaN]) {
      let first = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5, page })
      assert.deepEqual([first.page, first.offset, first.rows.length], [1, 0, 5], String(page))
    }
    // An empty tab: one page, no row.
    let none = await listFindingScreen(database.sql, orgId, { view: 'wontfix', page: 4 })
    assert.deepEqual([none.page, none.pages, none.offset, none.rows.length], [1, 1, 0, 0])
  })

  it('keeps a limit of a caller between 1 and 100 rows', async () => {
    assert.equal((await listFindingScreen(database.sql, orgId, { view: 'all', limit: 0 })).rows.length, 1)
    assert.equal((await listFindingScreen(database.sql, orgId, { view: 'all', limit: -5 })).rows.length, 1)
    assert.equal((await listFindingScreen(database.sql, orgId, { view: 'all', limit: Number.NaN })).rows.length, 15)
    assert.equal((await listFindingScreen(database.sql, orgId, { view: 'all', limit: 10_000 })).rows.length, 15)
  })

  it('never reads the findings of another org, nor its repository as a filter', async () => {
    let [theirs] = await database.sql<{ id: string }[]>`select id from repos where full_name = 'someone-else/app'`
    let page = await listFindingScreen(database.sql, orgId, { view: 'all', repoId: theirs!.id })
    assert.equal(page.rows.length, 0)
    assert.equal(page.counts.all, 0)
  })

  it('offers the repositories that have findings, and the rules of the org', async () => {
    let facets = await findingFacets(database.sql, orgId)
    assert.deepEqual(facets.repos.map((r) => r.fullName), ['sakuga-software/orchard', 'sakuga-software/sakuga-review'])
    assert.deepEqual([...facets.rules].map((r) => ({ ...r })), [{ id: ruleId, title: 'No any', repo: 'sakuga-software/sakuga-review' }])
  })
})

describe('KNT-192: a stale finding that the last reviews no longer see', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let orgId: string

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url)
    let sql = database.sql
    orgId = await insertOrg(sql, 'sakuga-software', 1, 11)
    let [repo] = await sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
      values (${orgId}, (select id from installations where org_id = ${orgId} order by created_at limit 1), 3001, 'sakuga-software/sakuga-review', true)
      returning id`
    let repoId = repo!.id
    let [job] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', 7, ${HEAD}, 'main') returning id`
    let [review] = await sql<{ id: string }[]>`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result)
      values (${job!.id}, ${repoId}, 7, ${HEAD}, 4, 'm', '{}'::jsonb) returning id`
    // pull request 7: unseen (a review made it stale), stale by a close (no review), open.
    // pull request 8: unseen, then the pull request closed.
    let insert = async (pr: number, key: string, title: string, status: string, staleBy: string | null | undefined) => {
      let [row] = await sql<{ id: string }[]>`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
          first_seen_sha, last_seen_sha)
        values (${repoId}, ${pr}, ${key}, ${key}, 'src/a.ts', 1, ${title}, 'major', 'bug', 80, ${status}::finding_status, ${HEAD}, ${HEAD})
        returning id`
      if (staleBy !== undefined) {
        await sql`insert into finding_events (finding_id, review_id, type, actor) values (${row!.id}, ${staleBy}, 'stale', 'kento')`
      }
    }
    await insert(7, 'u1', 'Unseen', 'stale', review!.id)
    await insert(7, 'c1', 'Closed pull request', 'stale', null)
    await insert(7, 'o1', 'Open', 'open', undefined)
    await insert(8, 'u2', 'Unseen then closed', 'stale', review!.id)
    await sql`insert into pull_closures (repo_id, pr_number, closed_at) values (${repoId}, 8, now())`
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('lists it under "open", flagged unseen, and not under "stale" or "closed"', async () => {
    let open = await listFindingScreen(database.sql, orgId)
    assert.deepEqual(open.counts, { open: 2, fixed: 0, dismissed: 0, wontfix: 0, stale: 2, closed: 2, all: 4 })
    assert.deepEqual(open.rows.map((r) => [r.title, r.status, r.unseen]).sort(), [
      ['Open', 'open', false],
      ['Unseen', 'stale', true],
    ])
    let stale = await listFindingScreen(database.sql, orgId, { view: 'stale' })
    assert.deepEqual(stale.rows.map((r) => [r.title, r.unseen]).sort(), [
      ['Closed pull request', false],
      ['Unseen then closed', false],
    ])
    let closed = await listFindingScreen(database.sql, orgId, { view: 'closed' })
    assert.deepEqual(closed.rows.map((r) => r.title).sort(), ['Closed pull request', 'Unseen then closed'])
  })

  it('lists it under "open" again when the pull request opens again', async () => {
    await database.sql`delete from pull_closures where pr_number = 8`
    let open = await listFindingScreen(database.sql, orgId)
    assert.deepEqual(open.rows.map((r) => r.title).sort(), ['Open', 'Unseen', 'Unseen then closed'])
  })
})
