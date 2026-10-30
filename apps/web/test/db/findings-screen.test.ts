// REV-18. The list of the Findings screen against Postgres: the filters in SQL, the counts of the
// tabs, and a keyset page that goes forward and back without losing a row.
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { findingFacets, listFindingScreen, type FindingRow } from '../../app/findings/screen.ts'
import { encodeCursor } from '../../app/findings/store.ts'
import { createTestDatabase } from './helpers.ts'

const HEAD = '1'.repeat(40)
const NEXT = '2'.repeat(40)

/** The cursor of a row, as the screen writes it: `created_at` to the microsecond, then the id. */
function encodeCursorOf(row: FindingRow) {
  return encodeCursor({ at: cursorAts.get(row.id)!, id: row.id })
}
const cursorAts = new Map<string, string>()

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
    let orgs = await sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login)
      values (1, 11, 'sakuga-software'), (2, 22, 'someone-else') returning id`
    orgId = orgs[0]!.id
    let repos = await sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled)
      values (${orgId}, 3001, 'sakuga-software/sakuga-review', true), (${orgId}, 3002, 'sakuga-software/orchard', true),
        (${orgs[1]!.id}, 3003, 'someone-else/app', true), (${orgId}, 3004, 'sakuga-software/quiet', true)
      returning id`
    repoId = repos[0]!.id
    otherRepoId = repos[1]!.id
    let [rule] = await sql<{ id: string }[]>`
      insert into rules (org_id, repo_id, title, body) values (${orgId}, ${repoId}, 'Pas de any', 'Typer.') returning id`
    ruleId = rule!.id
    // 12 findings of sakuga-review, one a minute, the newest last; 3 of orchard; 1 of another org.
    for (let n = 0; n < 12; n++) {
      let [row] = await sql<{ id: string }[]>`
        insert into findings (repo_id, pr_number, fingerprint, key, rule_id, path, line, title, severity, category, confidence,
          status, status_reason, first_seen_sha, last_seen_sha, created_at)
        values (${repoId}, ${10 + (n % 3)}, ${`f${n}`}, ${`k${n}`}, ${n % 4 === 0 ? ruleId : null}, ${`src/file_${n}.ts`}, ${n + 1},
          ${`Finding ${n}`}, ${['critical', 'major', 'minor'][n % 3]!}, 'bug', 80, ${n % 5 === 4 ? 'dismissed' : 'open'},
          ${n % 5 === 4 ? 'Hors sujet' : null}, ${HEAD}, ${n === 0 ? NEXT : HEAD}, now() - ${`${60 - n} minutes`}::interval)
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
    for (let row of await sql<{ id: string; at: string }[]>`
      select id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from findings`) cursorAts.set(row.id, row.at)
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
    assert.equal(page.next, null)
    assert.equal(page.previous, null)
  })

  it('filters by repository, priority, rule, search and tab, in SQL', async () => {
    let byRepo = await listFindingScreen(database.sql, orgId, { view: 'all', repoId: otherRepoId })
    assert.deepEqual(byRepo.rows.map((r) => r.title).sort(), ['Orchard fixed', 'Orchard open', 'Orchard stale'])
    assert.deepEqual(byRepo.counts, { open: 1, fixed: 1, dismissed: 0, wontfix: 0, stale: 1, closed: 2, all: 3 })

    let critical = await listFindingScreen(database.sql, orgId, { severity: 'critical' })
    assert.deepEqual(critical.rows.map((r) => r.title), ['Finding 6', 'Finding 3', 'Finding 0'])

    let ruled = await listFindingScreen(database.sql, orgId, { view: 'all', ruleId })
    assert.deepEqual(ruled.rows.map((r) => [r.title, r.ruleTitle]), [
      ['Finding 8', 'Pas de any'],
      ['Finding 4', 'Pas de any'],
      ['Finding 0', 'Pas de any'],
    ])

    let dismissed = await listFindingScreen(database.sql, orgId, { view: 'dismissed' })
    assert.deepEqual(dismissed.rows.map((r) => [r.title, r.statusReason]), [
      ['Finding 9', 'Hors sujet'],
      ['Finding 4', 'Hors sujet'],
    ])
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

  it('pages forward and back by keyset, with the position of each page', async () => {
    let seen: string[] = []
    let page = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5 })
    let pages = [page]
    seen.push(...page.rows.map((r) => r.id))
    while (page.next) {
      page = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5, after: page.next })
      pages.push(page)
      seen.push(...page.rows.map((r) => r.id))
    }
    assert.deepEqual(seen, [...ids].reverse())
    assert.deepEqual(pages.map((p) => [p.offset, p.rows.length]), [[0, 5], [5, 5], [10, 2]])
    assert.equal(pages[0]!.previous, null)

    // « Précédents » from the last page gives the middle page back, with its links both ways.
    let back = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5, before: pages[2]!.previous })
    assert.deepEqual(back.rows.map((r) => r.id), pages[1]!.rows.map((r) => r.id))
    assert.equal(back.offset, 5)
    assert.ok(back.next && back.previous)
    // Exactly a page before the cursor: the same first page as without a cursor, with the same « Suivants ».
    let first = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5, before: back.previous })
    assert.deepEqual(first.rows.map((r) => r.id), pages[0]!.rows.map((r) => r.id))
    assert.equal(first.previous, null)
    assert.equal(first.offset, 0)
    assert.equal(first.next, pages[0]!.next)
    let again = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5, after: first.next })
    assert.deepEqual(again.rows.map((r) => r.id), pages[1]!.rows.map((r) => r.id))
  })

  it('gives the whole first page when fewer than a page are left before the cursor', async () => {
    // A cursor on the 3rd newest finding: two rows before it, where « Précédents » expects five.
    let page = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5 })
    let short = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5, before: encodeCursorOf(page.rows[2]!) })
    assert.deepEqual(short.rows.map((r) => r.id), page.rows.map((r) => r.id))
    assert.equal(short.offset, 0)
    assert.equal(short.previous, null)
    assert.equal(short.next, page.next)
  })

  it('gives the first page for « Suivants » past the last row, rather than an empty page', async () => {
    let page = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5 })
    let past = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5, after: encodeCursorOf(page.rows.at(-1)!) })
    assert.equal(past.rows.length, 5)
    // The oldest finding of the repository as the cursor: no row after it.
    let oldest = (await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 100 })).rows.at(-1)!
    let end = await listFindingScreen(database.sql, orgId, { view: 'all', repoId, limit: 5, after: encodeCursorOf(oldest) })
    assert.deepEqual(end.rows.map((r) => r.id), page.rows.map((r) => r.id))
    assert.equal(end.offset, 0)
  })

  it('keeps a limit of a caller between 1 and 100 rows', async () => {
    assert.equal((await listFindingScreen(database.sql, orgId, { view: 'all', limit: 0 })).rows.length, 1)
    assert.equal((await listFindingScreen(database.sql, orgId, { view: 'all', limit: -5 })).rows.length, 1)
    assert.equal((await listFindingScreen(database.sql, orgId, { view: 'all', limit: Number.NaN })).rows.length, 15)
    assert.equal((await listFindingScreen(database.sql, orgId, { view: 'all', limit: 10_000 })).rows.length, 15)
  })

  it('starts again at the first page on a cursor it cannot read', async () => {
    let page = await listFindingScreen(database.sql, orgId, { after: 'not-a-cursor' })
    assert.equal(page.offset, 0)
    assert.equal(page.rows.length, 11)
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
    assert.deepEqual([...facets.rules].map((r) => ({ ...r })), [{ id: ruleId, title: 'Pas de any', repo: 'sakuga-software/sakuga-review' }])
  })
})
