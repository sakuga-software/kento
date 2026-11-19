// REV-18. "Mark dismissed" on several findings against Postgres: one event each with the login of
// the person, one reply in each thread, and the count of the reasons that grows by as many.
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import * as assert from 'remix/assert'
import { after, before, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { migrationsFolder, runMigrations } from '../../app/db/migrate.ts'
import { applyStatus, type ThreadTarget } from '../../app/findings/dismiss.ts'
import { precisionReport } from '../../app/findings/precision.ts'
import { createTestDatabase } from './helpers.ts'

const HEAD = '1'.repeat(40)

describe('a change of status of several findings', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let orgId: string
  let otherOrgId: string
  let ids: string[] = []
  let theirs: string

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url)
    let sql = database.sql
    let orgs = await sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (4242, 11, 'sakuga-software'), (5252, 22, 'other') returning id`
    orgId = orgs[0]!.id
    otherOrgId = orgs[1]!.id
    let repos = await sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled)
      values (${orgId}, 7001, 'sakuga-software/orchard', true), (${otherOrgId}, 7009, 'other/app', true) returning id`
    // Three open findings of orchard#12: two with a thread on GitHub, one without (its comment failed).
    for (let n = 0; n < 3; n++) {
      let [row] = await sql<{ id: string }[]>`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
          first_seen_sha, last_seen_sha, github_comment_id)
        values (${repos[0]!.id}, 12, ${`f${n}`}, ${`k${n}`}, 'a.ts', ${n + 1}, ${`t${n}`}, 'major', 'bug', 80, 'open', ${HEAD}, ${HEAD},
          ${n < 2 ? 900_001 + n : null})
        returning id`
      ids.push(row!.id)
    }
    let [row] = await sql<{ id: string }[]>`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
        first_seen_sha, last_seen_sha, github_comment_id)
      values (${repos[1]!.id}, 3, 'x', 'x', 'b.ts', 1, 'theirs', 'major', 'bug', 80, 'open', ${HEAD}, ${HEAD}, 900_100)
      returning id`
    theirs = row!.id
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('dismisses two findings with "Off topic": two events, two replies, and the reason counts two more', async () => {
    let before = (await precisionReport(database.sql, orgId)).reasons.find((r) => r.reason === 'Off topic')?.count ?? 0
    let posted: { target: ThreadTarget; body: string }[] = []
    let outcome = await applyStatus(
      database.sql,
      async (target, body) => {
        posted.push({ target, body })
      },
      { orgId, ids: [ids[0]!, ids[1]!], status: 'dismissed', reason: 'Off topic', actor: 'octocat' },
    )
    assert.deepEqual(outcome, { changed: 2, unchanged: 0, fixed: 0, missing: 0, failed: 0, replied: 2, unreplied: 0 })
    assert.deepEqual(
      posted.map((p) => p.target).sort((a, b) => a.commentId - b.commentId),
      [
        { installationId: 4242, githubRepoId: 7001, fullName: 'sakuga-software/orchard', prNumber: 12, commentId: 900_001 },
        { installationId: 4242, githubRepoId: 7001, fullName: 'sakuga-software/orchard', prNumber: 12, commentId: 900_002 },
      ],
    )
    assert.match(posted[0]!.body, /by @octocat on Kentō\. Reason: "Off topic"/)

    let events = await database.sql<{ type: string; actor: string; reason: string }[]>`
      select type, actor, reason from finding_events where finding_id = any(${[ids[0]!, ids[1]!]}::uuid[])`
    assert.deepEqual([...events].map((e) => ({ ...e })), [
      { type: 'dismissed', actor: 'octocat', reason: 'Off topic' },
      { type: 'dismissed', actor: 'octocat', reason: 'Off topic' },
    ])
    let after = (await precisionReport(database.sql, orgId)).reasons.find((r) => r.reason === 'Off topic')?.count ?? 0
    assert.equal(after - before, 2)
  })

  it('does not reply again for a finding that already has this status and reason, nor for one without a thread', async () => {
    let posted = 0
    let outcome = await applyStatus(
      database.sql,
      async () => {
        posted++
      },
      { orgId, ids: [ids[0]!, ids[2]!], status: 'dismissed', reason: 'Off topic', actor: 'camille' },
    )
    assert.deepEqual(outcome, { changed: 1, unchanged: 1, fixed: 0, missing: 0, failed: 0, replied: 0, unreplied: 0 })
    assert.equal(posted, 0)
  })

  it('keeps the status when GitHub refuses the reply, and never touches a finding of another org', async () => {
    let warned: string[] = []
    let outcome = await applyStatus(
      database.sql,
      async () => {
        throw new Error('POST … answered 403')
      },
      { orgId, ids: [ids[1]!, theirs], status: 'wontfix', reason: null, actor: 'octocat' },
      (event) => warned.push(event),
    )
    assert.deepEqual(outcome, { changed: 1, unchanged: 0, fixed: 0, missing: 1, failed: 0, replied: 0, unreplied: 1 })
    assert.deepEqual(warned, ['findings.reply_failed'])
    let [mine] = await database.sql<{ status: string }[]>`select status from findings where id = ${ids[1]!}`
    let [other] = await database.sql<{ status: string }[]>`select status from findings where id = ${theirs}`
    assert.equal(mine!.status, 'wontfix')
    assert.equal(other!.status, 'open')
  })

  it('leaves a finding fixed by a push as it is: no event, no reply, and the precision keeps it', async () => {
    let [row] = await database.sql<{ id: string }[]>`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
        first_seen_sha, last_seen_sha, github_comment_id)
      select repo_id, 12, 'fx', 'fx', 'a.ts', 9, 'fixed one', 'major', 'bug', 80, 'fixed', ${HEAD}, ${HEAD}, 900_050
      from findings where id = ${ids[0]!}
      returning id`
    let posted = 0
    let outcome = await applyStatus(database.sql, async () => void posted++, {
      orgId, ids: [row!.id], status: 'dismissed', reason: 'Off topic', actor: 'octocat',
    })
    assert.deepEqual(outcome, { changed: 0, unchanged: 0, fixed: 1, missing: 0, failed: 0, replied: 0, unreplied: 0 })
    assert.equal(posted, 0)
    let [after] = await database.sql<{ status: string }[]>`select status from findings where id = ${row!.id}`
    assert.equal(after!.status, 'fixed')
  })

  it('goes on after a finding the database cannot change, and each change gets its reply at once', async () => {
    // Two open findings; the first is locked by another transaction past the lock timeout of the batch.
    let fresh: string[] = []
    for (let n = 0; n < 2; n++) {
      let [row] = await database.sql<{ id: string }[]>`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
          first_seen_sha, last_seen_sha, github_comment_id)
        select repo_id, 12, ${`lk${n}`}, ${`lk${n}`}, 'a.ts', ${20 + n}, ${`locked ${n}`}, 'major', 'bug', 80, 'open', ${HEAD}, ${HEAD}, ${900_060 + n}
        from findings where id = ${ids[0]!}
        returning id`
      fresh.push(row!.id)
    }
    // A new connection of the test database waits 300 ms at most for a lock.
    let name = new URL(test.url).pathname.slice(1)
    await database.sql.unsafe(`alter database ${name} set lock_timeout = '300ms'`)
    let impatient = createDatabase(test.url, { max: 1 })
    // postgres.js reads the array types at the first query of a client: an array cannot be that query.
    await impatient.sql`select 1`
    let release!: () => void
    let held = new Promise<void>((resolve) => (release = resolve))
    let locked = new Promise<void>((resolve) => {
      void database.sql.begin(async (tx) => {
        await tx`select id from findings where id = ${fresh[0]!} for update`
        resolve()
        await held
      })
    })
    await locked
    let posted: number[] = []
    let warned: string[] = []
    try {
      let outcome = await applyStatus(
        impatient.sql,
        async (target) => void posted.push(target.commentId),
        { orgId, ids: fresh, status: 'wontfix', reason: null, actor: 'octocat' },
        (event) => warned.push(event),
      )
      assert.deepEqual(outcome, { changed: 1, unchanged: 0, fixed: 0, missing: 0, failed: 1, replied: 1, unreplied: 0 })
      assert.deepEqual(posted, [900_061])
      assert.deepEqual(warned, ['findings.status_failed'])
    } finally {
      release()
      await impatient.close()
      await database.sql.unsafe(`alter database ${name} reset lock_timeout`)
    }
  })

  // REV-114. Migration 0027 gives the French reasons of the dialog and of a 👎 their English value.
  // The test runs its SQL again on rows written as the release before wrote them.
  it('migration 0027 changes the French reasons of the dialog to English, and keeps a reason of a person', async () => {
    let sql = database.sql
    let fresh: string[] = []
    for (let [n, reason] of ['Faux positif', 'sans motif, réaction GitHub', 'Corrigé ailleurs'].entries()) {
      let [row] = await sql<{ id: string }[]>`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, status_reason,
          first_seen_sha, last_seen_sha)
        select repo_id, 13, ${`fr${n}`}, ${`fr${n}`}, 'a.ts', ${40 + n}, ${`french ${n}`}, 'major', 'bug', 80, 'dismissed', ${reason}, ${HEAD}, ${HEAD}
        from findings where id = ${ids[0]!}
        returning id`
      await sql`insert into finding_events (finding_id, type, actor, reason) values (${row!.id}, 'dismissed', 'octocat', ${reason})`
      fresh.push(row!.id)
    }
    let migration = await readFile(path.join(migrationsFolder, '0027_dismiss_reasons_in_english.sql'), 'utf8')
    for (let statement of migration.split('--> statement-breakpoint')) await sql.unsafe(statement)
    let rows = await sql<{ statusReason: string; reason: string }[]>`
      select f.status_reason as "statusReason", e.reason from findings f join finding_events e on e.finding_id = f.id
      where f.id = any(${fresh}::uuid[]) order by f.line`
    assert.deepEqual(
      rows.map((r) => [r.statusReason, r.reason]),
      [['False positive', 'False positive'], ['no reason, GitHub reaction', 'no reason, GitHub reaction'], ['Corrigé ailleurs', 'Corrigé ailleurs']],
    )
  })
})
