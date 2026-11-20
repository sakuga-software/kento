// REV-55. `findings.rule_id` references `rules`: the removal of a rule keeps its findings and sets
// their rule to null, and a review that cites a rule removed while its job ran stores its finding
// without the rule.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { migrationsFolder, runMigrations } from '../../app/db/migrate.ts'
import { createFindingsLedger, type LedgerEntry } from '../../app/findings/ledger.ts'
import { createTestDatabase, seedEnabledRepoBefore0029 } from './helpers.ts'

const HEAD = '1'.repeat(40)

async function seedRepo(sql: Database['sql']) {
  let [org] = await sql<{ id: string }[]>`
    with org as (insert into orgs (name, slug) values ('sakuga-software', lower('sakuga-software')) returning id) insert into installations (org_id, github_installation_id, github_account_id, account_login) select id, 1, 11, 'sakuga-software' from org returning org_id as id`
  let [repo] = await sql<{ id: string }[]>`
    insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
    values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 3001, 'sakuga-software/sakuga-review', true) returning id`
  return { orgId: org!.id, repoId: repo!.id }
}

async function insertRule(sql: Database['sql'], orgId: string, title: string) {
  let [rule] = await sql<{ id: string }[]>`insert into rules (org_id, title, body) values (${orgId}, ${title}, 'Body.') returning id`
  return rule!.id
}

async function insertFinding(sql: Database['sql'], repoId: string, title: string, ruleId: string | null) {
  let [row] = await sql<{ id: string }[]>`
    insert into findings (repo_id, pr_number, fingerprint, key, rule_id, path, line, title, severity, category, confidence,
      first_seen_sha, last_seen_sha)
    values (${repoId}, 7, '0123456789abcdef', ${title}, ${ruleId}, 'src/a.ts', 3, ${title}, 'major', 'bug', 90, ${HEAD}, ${HEAD})
    returning id`
  return row!.id
}

function entry(title: string, ruleId: string | null): LedgerEntry {
  return {
    id: null,
    values: {
      fingerprint: 'fedcba9876543210',
      key: title,
      ruleId,
      path: 'src/b.ts',
      line: 4,
      title,
      severity: 'major',
      category: 'bug',
      confidence: 90,
      status: 'open',
      statusReason: null,
      loadedStatus: null,
      lastSeenSha: HEAD,
      githubCommentId: null,
      githubThreadId: null,
    },
    events: [{ type: 'opened', actor: 'kento' }],
  }
}

describe('the rule of a finding (REV-55)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let orgId: string
  let repoId: string

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url)
    ;({ orgId, repoId } = await seedRepo(database.sql))
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('keeps the findings of a removed rule, with no rule', async () => {
    let cited = await insertRule(database.sql, orgId, 'No console.log')
    let other = await insertRule(database.sql, orgId, 'No any')
    let a = await insertFinding(database.sql, repoId, 'cites the removed rule', cited)
    let b = await insertFinding(database.sql, repoId, 'cites the other rule', other)

    await database.sql`delete from rules where id = ${cited}`

    let rows = await database.sql<{ id: string; ruleId: string | null }[]>`
      select id, rule_id as "ruleId" from findings where id in (${a}, ${b}) order by title desc`
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        { id: a, ruleId: null },
        { id: b, ruleId: other },
      ],
    )
  })

  it('refuses a finding that cites a rule that does not exist', async () => {
    await assert.rejects(
      insertFinding(database.sql, repoId, 'cites nothing', '00000000-0000-0000-0000-000000000000'),
      /findings_rule_id_rules_id_fk/,
    )
  })

  it('stores the finding of a review without the rule that an admin removed while its job ran', async () => {
    let kept = await insertRule(database.sql, orgId, 'Still there')
    let removed = await insertRule(database.sql, orgId, 'Removed during the job')
    await database.sql`delete from rules where id = ${removed}`
    let [job] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref) values (${repoId}, 'lite', 7, ${HEAD}, 'main') returning id`
    let [review] = await database.sql<{ id: string }[]>`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result)
      values (${job!.id}, ${repoId}, 7, ${HEAD}, 3, 'm', '{"findings":[]}') returning id`
    let ledger = createFindingsLedger(database.sql, { repoId, prNumber: 7, reviewId: review!.id, head: HEAD })

    await ledger.save([entry('cites the removed rule while the job ran', removed), entry('cites a rule still there', kept)])

    let rows = await database.sql<{ title: string; ruleId: string | null }[]>`
      select title, rule_id as "ruleId" from findings where last_review_id = ${review!.id} order by title`
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        { title: 'cites a rule still there', ruleId: kept },
        { title: 'cites the removed rule while the job ran', ruleId: null },
      ],
    )
  })

  it('0015 sets to null the rule of a finding whose rule was removed before the constraint', async () => {
    let other = await createTestDatabase()
    let earlier = await mkdtemp(path.join(tmpdir(), 'kento-migrations-'))
    let check = createDatabase(other.url, { max: 1 })
    try {
      // The release before REV-55: every migration up to 0014.
      await cp(migrationsFolder, earlier, { recursive: true })
      let journalPath = path.join(earlier, 'meta', '_journal.json')
      let journal = JSON.parse(await readFile(journalPath, 'utf8'))
      journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < '0015')
      await writeFile(journalPath, JSON.stringify(journal))
      await runMigrations(other.url, earlier)
      let seeded = await seedEnabledRepoBefore0029(check.sql)
      let rule = await insertRule(check.sql, seeded.orgId, 'Still there')
      let orphan = await insertFinding(check.sql, seeded.repoId, 'orphan', '00000000-0000-0000-0000-000000000000')
      let cited = await insertFinding(check.sql, seeded.repoId, 'cited', rule)

      await runMigrations(other.url)

      let rows = await check.sql<{ id: string; ruleId: string | null }[]>`
        select id, rule_id as "ruleId" from findings order by title`
      assert.deepEqual(
        rows.map((r) => ({ ...r })),
        [
          { id: cited, ruleId: rule },
          { id: orphan, ruleId: null },
        ],
      )
    } finally {
      await check.close()
      await rm(earlier, { recursive: true, force: true })
      await other.drop()
    }
  })
})
