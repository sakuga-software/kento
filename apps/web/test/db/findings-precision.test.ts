// REV-18. The precision of the reviews against Postgres: fixed / (fixed + dismissed) over the findings
// closed in the last 30 days, for the org, by repository and by rule, and the reasons of the
// dismissed findings.
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { precisionLabel, precisionReport, repoPrecisions } from '../../app/findings/precision.ts'
import { createTestDatabase } from './helpers.ts'

const HEAD = '1'.repeat(40)

describe('the precision of the reviews', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let orgId: string
  let orchard: string
  let fruitback: string
  let quiet: string
  let ruleId: string
  let n = 0

  /** A finding whose history is `events`, each `[type, days ago, reason?]`; its status is the last one. */
  async function finding(repoId: string, events: [string, number, string?][], ruleOf: string | null = null) {
    let last = events.at(-1)!
    let status = last[0] === 'reopened' || last[0] === 'opened' ? 'open' : last[0]
    let [row] = await database.sql<{ id: string }[]>`
      insert into findings (repo_id, pr_number, fingerprint, key, rule_id, path, line, title, severity, category, confidence,
        status, status_reason, first_seen_sha, last_seen_sha, created_at)
      values (${repoId}, 1, ${`f${n}`}, ${`k${n}`}, ${ruleOf}, 'a.ts', ${++n}, 't', 'major', 'bug', 80, ${status},
        ${status === 'dismissed' || status === 'wontfix' ? (last[2] ?? 'Hors sujet') : null}, ${HEAD}, ${HEAD}, now() - interval '60 days')
      returning id`
    for (let [type, days, reason] of [['opened', 60] as [string, number, string?], ...events]) {
      await database.sql`
        insert into finding_events (finding_id, type, actor, reason, created_at)
        values (${row!.id}, ${type}, 'kento', ${reason ?? null}, now() - ${`${days} days`}::interval)`
    }
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url)
    let sql = database.sql
    let orgs = await sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (1, 11, 'sakuga-software'), (2, 22, 'other') returning id`
    orgId = orgs[0]!.id
    let repos = await sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled)
      values (${orgId}, 3001, 'sakuga-software/orchard', true), (${orgId}, 3002, 'sakuga-software/fruitback', true),
        (${orgId}, 3003, 'sakuga-software/quiet', true), (${orgs[1]!.id}, 3004, 'other/app', true)
      returning id`
    ;[orchard, fruitback, quiet] = [repos[0]!.id, repos[1]!.id, repos[2]!.id]
    let [rule] = await sql<{ id: string }[]>`
      insert into rules (org_id, title, body) values (${orgId}, 'Pas de secret dans les logs', 'Aucun jeton.') returning id`
    ruleId = rule!.id

    // orchard: 12 fixed and 3 dismissed in the window, 4 of the fixed and 1 dismissed from the rule.
    for (let i = 0; i < 12; i++) await finding(orchard, [['fixed', 1 + i]], i < 4 ? ruleId : null)
    await finding(orchard, [['dismissed', 2, 'Hors sujet']], ruleId)
    await finding(orchard, [['dismissed', 3, 'Hors sujet']])
    await finding(orchard, [['dismissed', 4, 'Faux positif']])
    // Out of the count: closed before the window, fixed then opened again, wontfix, stale, open.
    await finding(orchard, [['fixed', 45]])
    await finding(orchard, [['dismissed', 31, 'Hors sujet']])
    await finding(orchard, [['fixed', 5], ['reopened', 2]])
    await finding(orchard, [['wontfix', 1, 'Accepté']])
    await finding(orchard, [['stale', 1]])
    await finding(orchard, [['opened', 1]])
    // In the count: dismissed before the window, opened again, then fixed in the window.
    await finding(orchard, [['dismissed', 40, 'Hors sujet'], ['reopened', 20], ['fixed', 3]])
    // Out of the count (REV-18 review): fixed in the window, then opened again, and fixed again by an
    // event older than the window (events written out of order). Its last event is not in the window.
    await finding(orchard, [['fixed', 5], ['reopened', 2], ['fixed', 45]])
    // fruitback: 5 fixed and 4 dismissed: 9 closed, under the 10 of a share.
    for (let i = 0; i < 5; i++) await finding(fruitback, [['fixed', 2]])
    for (let i = 0; i < 4; i++) await finding(fruitback, [['dismissed', 2, 'Déjà connu']])
    // quiet: one dismissal with an empty reason (REV-18 review): counted, under « Sans motif ».
    await finding(quiet, [['dismissed', 1, '']])
    // The same reason in another case (« Autre », typed by hand): one group with « Hors sujet ».
    await finding(quiet, [['dismissed', 1, '  hors sujet ']])
    // Another org: never counted.
    for (let i = 0; i < 10; i++) await finding(repos[3]!.id, [['dismissed', 1, 'Hors sujet']])
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('counts the findings closed in 30 days, for the org and by repository, as a query written by hand does', async () => {
    let report = await precisionReport(database.sql, orgId)
    assert.deepEqual(report.org, { fixed: 18, dismissed: 9, closed: 27, rate: 18 / 27 })
    assert.equal(precisionLabel(report.org), '67 %')
    assert.deepEqual(
      report.repos.map((r) => [r.fullName, r.fixed, r.dismissed, r.rate === null ? null : precisionLabel(r)]),
      [
        ['sakuga-software/orchard', 13, 3, '81 %'],
        ['sakuga-software/fruitback', 5, 4, null],
        ['sakuga-software/quiet', 0, 2, null],
      ],
    )
    assert.equal(precisionLabel(report.repos[1]!), 'n = 9 sur 10')
    assert.equal(report.repoCount, 3)

    // By hand: the last event of each finding of the org, when it closed the finding in the window.
    let [byHand] = await database.sql<{ fixed: string; dismissed: string }[]>`
      select count(*) filter (where last.type = 'fixed') as fixed, count(*) filter (where last.type = 'dismissed') as dismissed
      from (
        select distinct on (finding_events.finding_id) finding_events.type, finding_events.created_at
        from finding_events
        join findings on findings.id = finding_events.finding_id
        join repos on repos.id = findings.repo_id
        where repos.org_id = ${orgId}
        order by finding_events.finding_id, finding_events.created_at desc
      ) last
      where last.type in ('fixed', 'dismissed') and last.created_at >= now() - interval '30 days'`
    assert.deepEqual([Number(byHand!.fixed), Number(byHand!.dismissed)], [report.org.fixed, report.org.dismissed])
  })

  it('gives the precision by rule, and the reasons of the dismissed findings, the most frequent first', async () => {
    let report = await precisionReport(database.sql, orgId)
    assert.deepEqual(
      report.rules.map((r) => [r.title, r.fixed, r.dismissed, r.repo]),
      [['Pas de secret dans les logs', 4, 1, null]],
    )
    assert.deepEqual(
      report.reasons.map((r) => ({ reason: r.reason.toLowerCase(), count: r.count })),
      [
        { reason: 'déjà connu', count: 4 },
        { reason: 'hors sujet', count: 3 },
        { reason: 'faux positif', count: 1 },
      ],
    )
    // The empty reason is no group of its own name: a link could not filter on it.
    assert.equal(report.unreasoned, 1)
    assert.equal(report.reasonCount, 3)
  })

  it('reads the precision of the repositories of a page only', async () => {
    let precisions = await repoPrecisions(database.sql, orgId, [fruitback, orchard])
    assert.deepEqual([...precisions.keys()].sort(), [fruitback, orchard].sort())
    assert.equal((await repoPrecisions(database.sql, orgId, [quiet])).get(quiet)?.dismissed, 2)
    assert.deepEqual(precisions.get(fruitback), { fixed: 5, dismissed: 4, closed: 9, rate: null })
  })
})
