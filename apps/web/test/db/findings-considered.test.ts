// REV-102. The findings that their last review lists under "To consider (code already reviewed)" (REV-100):
// the Findings screen tags and filters them in SQL, and the detail of a finding says it. The rule is
// the one of `toConsider` (packages/engine): `seen`, no `follows`, not critical, in `reviews.result`.
import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { listFindingScreen } from '../../app/findings/screen.ts'
import { readFindingDetail } from '../../app/pulls/finding.ts'
import { createTestDatabase } from './helpers.ts'

const HEAD = '1'.repeat(40)

describe('the findings to consider (REV-102)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let orgId: string
  /** The findings by their title. */
  let ids = new Map<string, string>()

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url)
    let sql = database.sql
    let [org] = await sql<{ id: string }[]>`insert into orgs (github_installation_id, github_account_id, login) values (1, 11, 'sakuga-software') returning id`
    orgId = org!.id
    let [repo] = await sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled) values (${orgId}, 3001, 'sakuga-software/dojo', true) returning id`
    let [job] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, github_delivery_id) values (${repo!.id}, 'lite', 91, ${HEAD}, 'delivery-1') returning id`
    // The second review of dojo#91 (REV-100): a new P1 on the settings page that did not change.
    let finding = (title: string, extra: Record<string, unknown>) => ({
      path: 'app/routes/settings.tsx',
      start_line: 12,
      line: 12,
      severity: 'major',
      category: 'bug',
      confidence: 80,
      title,
      scenario: 's',
      fix: 'f',
      suggestion: '',
      anchor: 12,
      blocking: false,
      suggestion_range: null,
      fingerprint: `fp-${title}`,
      ...extra,
    })
    let result = {
      findings: [
        finding('STUDIO_HOST not documented', { seen: true }),
        // The same rule, matched by its path and title: a runner of an earlier release gave no fingerprint.
        finding('Title with no fingerprint', { seen: true, fingerprint: undefined }),
        finding('Follow-up of a finding', { seen: true, follows: 'abcdef012345', blocking: true }),
        finding('SQL injection', { seen: true, severity: 'critical', blocking: true }),
        finding('Defect of the diff', { blocking: true }),
        // Two findings of one path and title: their fingerprints tell them apart, never their title.
        finding('Duplicate', { seen: true, fingerprint: 'fp-dup-seen' }),
        finding('Duplicate', { severity: 'critical', blocking: true, fingerprint: 'fp-dup-blocking' }),
      ],
    }
    let [review] = await sql<{ id: string }[]>`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result)
      values (${job!.id}, ${repo!.id}, 91, ${HEAD}, 4, 'claude-haiku-5-5', 0.01, ${JSON.stringify(result)}::jsonb) returning id`
    for (let f of result.findings) {
      let [row] = await sql<{ id: string }[]>`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
          first_seen_sha, last_seen_sha, last_review_id)
        values (${repo!.id}, 91, ${f.fingerprint === undefined ? 'fp-other' : f.fingerprint}, ${`k-${f.title}`}, ${f.path}, 12, ${f.title},
          ${f.severity}, 'bug', 80, 'open', ${HEAD}, ${HEAD}, ${review!.id})
        returning id`
      ids.set(f.fingerprint === 'fp-dup-blocking' ? 'Blocking duplicate' : f.title, row!.id)
    }
    // A finding with no review left (the review was removed): never to consider.
    let [orphan] = await sql<{ id: string }[]>`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, first_seen_sha, last_seen_sha)
      values (${repo!.id}, 91, 'fp-STUDIO_HOST not documented', 'k-orphan', 'app/routes/settings.tsx', 12, 'No review', 'major', 'bug', 80, 'open', ${HEAD}, ${HEAD})
      returning id`
    ids.set('No review', orphan!.id)
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('tags each row by the rule of the engine: seen, no follows, not critical; two findings of one title by their fingerprint', async () => {
    let page = await listFindingScreen(database.sql, orgId, { view: 'all' })
    let titleOf = new Map([...ids].map(([title, id]) => [id, title]))
    let considered = Object.fromEntries(page.rows.map((r) => [titleOf.get(r.id), r.considered]))
    assert.deepEqual(considered, {
      'STUDIO_HOST not documented': true,
      'Title with no fingerprint': true,
      'Follow-up of a finding': false,
      'SQL injection': false,
      'Defect of the diff': false,
      Duplicate: true,
      'Blocking duplicate': false,
      'No review': false,
    })
  })

  it('filters them in SQL, and the counts of the tabs follow the filter', async () => {
    let page = await listFindingScreen(database.sql, orgId, { considered: true })
    assert.deepEqual(page.rows.map((r) => r.id).sort(), [ids.get('STUDIO_HOST not documented'), ids.get('Title with no fingerprint'), ids.get('Duplicate')].sort())
    assert.equal(page.counts.open, 3)
    assert.equal(page.counts.all, 3)
    let none = await listFindingScreen(database.sql, orgId, { considered: true, view: 'fixed' })
    assert.deepEqual(none.rows, [])
  })

  it('says it in the detail of a finding, and not for the others: the detail and the screen read one rule', async () => {
    for (let title of ['STUDIO_HOST not documented', 'Title with no fingerprint', 'Duplicate']) {
      let seen = await readFindingDetail(database.sql, orgId, ids.get(title)!)
      assert.equal(seen?.review?.considered, true, title)
    }
    for (let title of ['Follow-up of a finding', 'SQL injection', 'Defect of the diff', 'Blocking duplicate']) {
      let other = await readFindingDetail(database.sql, orgId, ids.get(title)!)
      assert.equal(other?.review?.considered, false, title)
    }
    let orphan = await readFindingDetail(database.sql, orgId, ids.get('No review')!)
    assert.equal(orphan?.review, null)
  })
})
