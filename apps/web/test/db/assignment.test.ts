import postgres from 'postgres'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createAssignmentStore } from '../../app/assignment/store.ts'
import { createDashboardStore } from '../../app/dashboard/store.ts'
import { readJobAssignment, readUnreadPathRules } from '../../app/assignment/model.ts'
import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createWebhookStore, enqueueCommandJob, type ListChangedFiles } from '../../app/db/webhook-store.ts'
import { headSha, pullRequestPayload, REPO, signedRequest, TEST_SECRET } from '../../app/github/test-helpers.ts'
import { createPullsStore } from '../../app/pulls/store.ts'
import { createAppRouter } from '../../app/router.ts'
import { createTestDatabase, seedEnabledRepo } from './helpers.ts'

// REV-21 against Postgres: the assignment rules of a repository, from the screen to the level of the
// job of a push. The end-to-end test of the ticket, on the repository of the seed.

const AGENT = { authors: ['sakuga-agent[bot]'], paths: [], labels: [], action: 'review' as const, level: 'balanced' as const, mention: null }
const MIGRATIONS = { authors: [], paths: ['**/migrations/**'], labels: [], action: 'review' as const, level: 'heavy' as const, mention: 'octocat' }
/** The author of the pull requests of a person; REV-22 needs the GitHub id. */
const CAMILLE = { login: 'camille', type: 'User', id: 2 }
const WIP = { authors: [], paths: [], labels: ['wip'], action: 'command_only' as const, level: null, mention: null }

describe('the assignment rules against Postgres (REV-21)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let sql: postgres.Sql
  let orgId: string
  let repoId: string
  let userId: string
  let delivery = 0
  let changedFiles: string[] | Error | null = null
  let listed = 0

  /** Runs while GitHub lists the files: between the read of GitHub and the transaction. */
  let whileListing: (() => Promise<unknown>) | null = null

  let listChangedFiles: ListChangedFiles = async () => {
    listed++
    if (whileListing) await whileListing()
    if (changedFiles instanceof Error) throw changedFiles
    return changedFiles
  }

  async function push(options: Parameters<typeof pullRequestPayload>[0] = {}) {
    delivery++
    let deliveryId = `00000000-0000-0000-0000-${delivery.toString().padStart(12, '0')}`
    let router = createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
      version: '0.1.0',
      commit: null,
      webhook: {
        secret: TEST_SECRET,
        trustedBotsFor: async () => new Set(['sakuga-agent[bot]']),
        apply: createWebhookStore(database.db, { listChangedFiles }),
      },
    })
    let response = await router.fetch(signedRequest(pullRequestPayload({ number: 140 + delivery, ...options }), { deliveryId }))
    return response.json() as Promise<{ outcome: string; reason?: string; jobId?: string }>
  }

  async function jobOf(jobId: string) {
    let [job] = await sql<{ level: string; config: unknown }[]>`select level, config from jobs where id = ${jobId}`
    return { level: job!.level, assignment: readJobAssignment(job!.config) }
  }

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    sql = database.sql
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  beforeEach(async () => {
    await sql`truncate orgs, repos, jobs, reviews, users cascade`
    ;({ orgId, repoId } = await seedEnabledRepo(sql))
    let [user] = await sql<{ id: string }[]>`insert into users (github_id, login) values (1, 'octocat') returning id`
    userId = user!.id
    changedFiles = null
    listed = 0
    whileListing = null
  })

  describe('the store of the screen', () => {
    it('adds the rules at the end, moves one, and removes one with no hole in the order', async () => {
      let store = createAssignmentStore(sql)
      let a = await store.create(orgId, repoId, userId, AGENT)
      let b = await store.create(orgId, repoId, userId, MIGRATIONS)
      let c = await store.create(orgId, repoId, userId, WIP)
      assert.deepEqual([a, b, c].map((o) => o.kind === 'saved' && o.position), [1, 2, 3])
      let ids = [a, b, c].map((o) => (o.kind === 'saved' ? o.id : ''))

      assert.equal((await store.move(orgId, repoId, ids[2]!, 'up')).kind, 'saved')
      assert.deepEqual((await store.list(orgId, repoId)).map((r) => r.id), [ids[0], ids[2], ids[1]])
      // At the top, "Move up" moves nothing.
      assert.deepEqual(await store.move(orgId, repoId, ids[0]!, 'up'), { kind: 'saved', id: ids[0], position: 1 })

      assert.deepEqual(await store.remove(orgId, repoId, ids[0]!), { kind: 'removed', position: 1 })
      let left = await store.list(orgId, repoId)
      assert.deepEqual(left.map((r) => [r.id, r.position]), [[ids[2], 1], [ids[1], 2]])
      assert.deepEqual({ ...left[1]!, id: '' }, { ...MIGRATIONS, id: '', position: 2, createdBy: 'octocat' })
    })

    it('keeps the places dense and unique: a removal then an addition, a move down, two additions at once', async () => {
      let store = createAssignmentStore(sql)
      let places = async () => (await store.list(orgId, repoId)).map((r) => [r.authors[0], r.position])
      let ids: string[] = []
      for (let login of ['a', 'b', 'c']) {
        let o = await store.create(orgId, repoId, userId, { ...AGENT, authors: [login] })
        ids.push(o.kind === 'saved' ? o.id : '')
      }
      // 3 rules, the second removed, one added: 1, 2, 3 and no two rules on 3.
      await store.remove(orgId, repoId, ids[1]!)
      assert.deepEqual(await store.create(orgId, repoId, userId, { ...AGENT, authors: ['d'] }).then((o) => o.kind === 'saved' && o.position), 3)
      assert.deepEqual(await places(), [['a', 1], ['c', 2], ['d', 3]])

      // Down, then up: each move swaps two places.
      await store.move(orgId, repoId, ids[0]!, 'down')
      assert.deepEqual(await places(), [['c', 1], ['a', 2], ['d', 3]])
      await store.move(orgId, repoId, ids[0]!, 'up')
      assert.deepEqual(await places(), [['a', 1], ['c', 2], ['d', 3]])
      // At the end, "Move down" moves nothing.
      let last = (await store.list(orgId, repoId)).at(-1)!
      assert.deepEqual(await store.move(orgId, repoId, last.id, 'down'), { kind: 'saved', id: last.id, position: 3 })

      // Five forms sent at the same time: five places, 4 to 8, none twice.
      let outcomes = await Promise.all(['e', 'f', 'g', 'h', 'i'].map((login) => store.create(orgId, repoId, userId, { ...AGENT, authors: [login] })))
      assert.deepEqual(outcomes.map((o) => (o.kind === 'saved' ? o.position : 0)).sort((x, y) => x - y), [4, 5, 6, 7, 8])
      assert.deepEqual((await places()).map(([, p]) => p), [1, 2, 3, 4, 5, 6, 7, 8])

      // A removal in the middle of eight: the seven others keep 1 to 7.
      await store.remove(orgId, repoId, ids[0]!)
      assert.deepEqual((await places()).map(([, p]) => p), [1, 2, 3, 4, 5, 6, 7])

      // The database refuses a place outside 0 to 20, whatever writes it.
      await assert.rejects(sql`insert into assignment_rules (org_id, repo_id, position, authors, action, level) values (${orgId}, ${repoId}, 21, '{y}', 'review', 'lite')`)

      // The database refuses two rules on one place, whatever writes them.
      await assert.rejects(sql`insert into assignment_rules (org_id, repo_id, position, authors, action, level) values (${orgId}, ${repoId}, 1, '{z}', 'review', 'lite')`)
    })

    it('finds nothing in the repository of another org, and refuses a rule over the limit', async () => {
      let store = createAssignmentStore(sql)
      let [other] = await sql<{ id: string }[]>`
        insert into orgs (github_installation_id, github_account_id, login) values (9, 9, 'other') returning id`
      assert.equal((await store.create(other!.id, repoId, userId, AGENT)).kind, 'not_found')
      assert.deepEqual(await store.list(other!.id, repoId), [])
      for (let i = 0; i < 20; i++) await store.create(orgId, repoId, userId, AGENT)
      assert.equal((await store.create(orgId, repoId, userId, AGENT)).kind, 'full')
    })

    it('refuses a rule with no condition, or a level that does not match its action, in the database too', async () => {
      await assert.rejects(sql`insert into assignment_rules (org_id, repo_id, position, action, level) values (${orgId}, ${repoId}, 1, 'review', 'lite')`)
      await assert.rejects(
        sql`insert into assignment_rules (org_id, repo_id, position, labels, action, level) values (${orgId}, ${repoId}, 1, '{wip}', 'command_only', 'lite')`,
      )
    })
  })

  describe('the level of the job of a push: the test of the ticket', () => {
    beforeEach(async () => {
      let store = createAssignmentStore(sql)
      await store.create(orgId, repoId, userId, AGENT)
      await store.create(orgId, repoId, userId, MIGRATIONS)
    })

    it('1. a pull request of the agent gets balanced, by rule 1', async () => {
      changedFiles = ['db/migrations/0002.sql']
      let result = await push({ author: { login: 'sakuga-agent[bot]', type: 'Bot', id: 900 }, sender: { login: 'sakuga-agent[bot]', type: 'Bot' } })
      assert.equal(result.outcome, 'queued')
      let job = await jobOf(result.jobId!)
      assert.equal(job.level, 'balanced')
      assert.deepEqual(job.assignment, { ruleId: job.assignment!.ruleId, position: 1, level: 'balanced', mention: null, reasons: { author: 'sakuga-agent[bot]' }, trigger: 'push' })
      // The job records the rule that chose its level.
      let [rule1] = await sql<{ id: string }[]>`select id from assignment_rules where position = 1`
      let [row] = await sql<{ source: string; rule: string }[]>`select level_source as source, assignment_rule_id as rule from jobs where id = ${result.jobId!}`
      assert.deepEqual({ ...row }, { source: 'rule', rule: rule1!.id })
      assert.equal(job.assignment!.ruleId, rule1!.id)
    })

    it('2. a pull request of a person that touches a migration gets heavy and the mention', async () => {
      changedFiles = ['src/a.ts', 'apps/web/drizzle/migrations/0016.sql']
      let result = await push({ author: CAMILLE })
      let job = await jobOf(result.jobId!)
      assert.equal(job.level, 'heavy')
      assert.deepEqual({ position: job.assignment!.position, mention: job.assignment!.mention, reasons: job.assignment!.reasons }, {
        position: 2,
        mention: 'octocat',
        reasons: { path: 'apps/web/drizzle/migrations/0016.sql' },
      })
      // The screen of the pull request says it.
      let summary = await createPullsStore(sql).summary(orgId, repoId, 140 + delivery)
      assert.equal(summary!.assignment?.position, 2)
    })

    it('3. a pull request that matches no rule gets the default level, with no assignment', async () => {
      changedFiles = ['README.md']
      let result = await push({ author: CAMILLE })
      assert.deepEqual(await jobOf(result.jobId!), { level: 'lite', assignment: null })
    })

    it('leaves a pull request to the commands when a rule says so', async () => {
      await createAssignmentStore(sql).create(orgId, repoId, userId, WIP)
      changedFiles = ['README.md']
      let result = await push({ author: CAMILLE, labels: ['WIP'] })
      assert.deepEqual(result, { outcome: 'skipped', reason: 'assignment rule 3 leaves the pull request to the commands' })
      assert.equal((await sql`select id from jobs`).length, 0)
    })

    it('skips a rule with paths when GitHub does not list the files, and queues at the default level', async () => {
      changedFiles = new Error('502')
      let result = await push({ author: CAMILLE })
      assert.equal(result.outcome, 'queued')
      assert.deepEqual(await jobOf(result.jobId!), { level: 'lite', assignment: null })
      // GitHub was asked twice, and the job keeps the rule that it could not test, for its review.
      assert.equal(listed, 2)
      let [job] = await sql<{ config: unknown }[]>`select config from jobs where id = ${result.jobId!}`
      assert.deepEqual(readUnreadPathRules(job!.config), [2])
    })

    it('puts a matching rule before the preferences of the author, and the preferences before the level of the repository (REV-22)', async () => {
      let [camille] = await sql<{ id: string }[]>`insert into users (github_id, login) values (2, 'camille') returning id`
      // Camille turned the automatic review off, and set lite for this repository.
      await sql`insert into user_prefs (user_id, repo_id, auto_review, level) values (${camille!.id}, ${repoId}, false, 'lite')`
      changedFiles = ['db/migrations/0003.sql']
      let ruled = await push({ author: CAMILLE })
      assert.equal(ruled.outcome, 'queued')
      assert.equal((await jobOf(ruled.jobId!)).level, 'heavy')

      // No rule matches: her preferences apply again.
      changedFiles = ['README.md']
      assert.deepEqual(await push({ author: CAMILLE }), { outcome: 'skipped', reason: 'automatic review is off for the author of the pull request' })
      await sql`update user_prefs set auto_review = true, level = 'balanced'`
      let preferred = await push({ author: CAMILLE })
      assert.deepEqual(await jobOf(preferred.jobId!), { level: 'balanced', assignment: null })
    })

    it('tests the paths on the second read of GitHub, when the first one fails', async () => {
      let calls = 0
      whileListing = async () => {
        if (++calls === 1) throw new Error('502')
      }
      changedFiles = ['db/migrations/0005.sql']
      let result = await push({ author: CAMILLE })
      let [job] = await sql<{ level: string; config: unknown }[]>`select level, config from jobs where id = ${result.jobId!}`
      assert.deepEqual({ level: job!.level, unread: readUnreadPathRules(job!.config) }, { level: 'heavy', unread: [] })
    })

    it('reads the rules again in the transaction: a rule removed while GitHub answers does not apply', async () => {
      changedFiles = ['README.md']
      whileListing = () => sql`delete from assignment_rules where position = 1`
      let result = await push({ author: { login: 'sakuga-agent[bot]', type: 'Bot', id: 900 }, sender: { login: 'sakuga-agent[bot]', type: 'Bot' } })
      assert.equal(result.outcome, 'queued')
      assert.deepEqual(await jobOf(result.jobId!), { level: 'lite', assignment: null })
    })

    it('shows on the screen the assignment of the last review job only: a later command shows none', async () => {
      changedFiles = ['db/migrations/0004.sql']
      await push({ author: CAMILLE, number: 160 })
      let pulls = createPullsStore(sql)
      assert.equal((await pulls.summary(orgId, repoId, 160))?.assignment?.position, 2)
      // `@kento-review lite` on the same head, through the path of the commands: its job holds no rule.
      let command = await enqueueCommandJob(database.db, {
        installation: { githubInstallationId: 1001, githubAccountId: 2001, login: 'sakuga-software' },
        repository: { githubRepoId: REPO.id, fullName: REPO.full_name },
        prNumber: 160,
        headSha: headSha(1),
        baseRef: 'main',
        kind: 'review',
        level: 'lite',
        force: true,
        commentId: 77,
        deliveryId: 'command-160',
      })
      assert.equal(command.outcome, 'queued')
      assert.deepEqual(await jobOf((command as { jobId: string }).jobId), { level: 'lite', assignment: null })
      assert.equal((await pulls.summary(orgId, repoId, 160))?.assignment, null)
    })

    it('records on each job what chose its level, and the screen of the pull request says it', async () => {
      let pulls = createPullsStore(sql)
      let origin = async (jobId: string) => {
        let [job] = await sql<{ levelSource: string | null; ruleId: string | null; prNumber: number }[]>`
          select level_source as "levelSource", assignment_rule_id as "ruleId", pr_number as "prNumber" from jobs where id = ${jobId}`
        let summary = await pulls.summary(orgId, repoId, job!.prNumber)
        return { source: job!.levelSource, rule: job!.ruleId, screen: summary!.levelOrigin }
      }
      let [rule1] = await sql<{ id: string }[]>`select id from assignment_rules where position = 1`

      // A push that a rule matched.
      changedFiles = ['README.md']
      let ruled = await push({ author: { login: 'sakuga-agent[bot]', type: 'Bot', id: 900 }, sender: { login: 'sakuga-agent[bot]', type: 'Bot' }, number: 170 })
      assert.deepEqual(await origin(ruled.jobId!), { source: 'rule', rule: rule1!.id, screen: { source: 'rule', level: 'balanced' } })

      // A push that no rule matched: the level of the repository.
      let plain = await push({ author: CAMILLE, number: 171 })
      assert.deepEqual(await origin(plain.jobId!), { source: 'repo', rule: null, screen: { source: 'repo', level: 'lite' } })

      // A push that no rule matched, by an author with a level of their own.
      let [camille] = await sql<{ id: string }[]>`insert into users (github_id, login) values (2, 'camille') returning id`
      await sql`insert into user_prefs (user_id, repo_id, auto_review, level) values (${camille!.id}, null, true, 'balanced')`
      let preferred = await push({ author: CAMILLE, number: 172 })
      assert.deepEqual(await origin(preferred.jobId!), { source: 'preference', rule: null, screen: { source: 'preference', level: 'balanced' } })

      // A command on the pull request of the rule: its job is the last one, and names no rule.
      let command = await enqueueCommandJob(database.db, {
        installation: { githubInstallationId: 1001, githubAccountId: 2001, login: 'sakuga-software' },
        repository: { githubRepoId: REPO.id, fullName: REPO.full_name },
        prNumber: 170,
        headSha: headSha(1),
        baseRef: 'main',
        kind: 'review',
        level: 'heavy',
        force: true,
        commentId: 78,
        deliveryId: 'command-170',
      })
      let commandJob = (command as { jobId: string }).jobId
      assert.deepEqual(await origin(commandJob), { source: 'command', rule: null, screen: { source: 'command', level: 'heavy' } })

      // A retry of that job from the dashboard.
      await sql`update jobs set state = 'failed', finished_at = now(), failure_reason = 'test' where id = ${commandJob}`
      let retried = await createDashboardStore(database).retry(orgId, commandJob, 'lite', null)
      assert.equal(retried.kind, 'queued')
      assert.deepEqual(await origin((retried as { jobId: string }).jobId), { source: 'retry', rule: null, screen: { source: 'retry', level: 'lite' } })

      // A cancelled job reviewed nothing: the screen goes back to the job before it.
      await sql`update jobs set state = 'cancelled', failure_reason = 'test' where id = ${(retried as { jobId: string }).jobId}`
      assert.deepEqual((await pulls.summary(orgId, repoId, 170))!.levelOrigin, { source: 'command', level: 'heavy' })

      // The removal of the rule keeps the job, without its rule.
      await createAssignmentStore(sql).remove(orgId, repoId, rule1!.id)
      assert.deepEqual((await origin(ruled.jobId!)).rule, null)
    })

    it('reads GitHub only when a rule has paths', async () => {
      await sql`delete from assignment_rules where cardinality(paths) > 0`
      await push({ author: CAMILLE })
      assert.equal(listed, 0)
    })
  })
})
