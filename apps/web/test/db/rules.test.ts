import { FEATURES, type Job, type ReviewPayload } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import type { MintInstallationToken } from '../../app/github/installation-token.ts'
import { disabledWebhook } from '../../app/github/test-helpers.ts'
import { createAppRouter } from '../../app/router.ts'
import { createGitHub } from '../../app/publish/github.ts'
import { publishReview } from '../../app/publish/publish.ts'
import type { RunnerApiDependencies } from '../../app/runner/controller.ts'
import { createRunnerStore } from '../../app/runner/store.ts'
import { BOT, createFakeGitHub } from '../fake-github.ts'
import { createTestDatabase } from './helpers.ts'

const REGISTRATION_TOKEN = 'registration-token-for-the-tests-0123456789'
const HEAD = 'b'.repeat(40)
const BASE = 'a'.repeat(40)

// The keys of a review job that a runner of the release before REV-19 knows: its `obj()` check refuses
// any other key, so a job with `rules` would fail on it.
const EARLIER_JOB_KEYS = ['id', 'attempt', 'level', 'repo', 'pullRequest', 'installationToken', 'leaseExpiresAt', 'provider', 'providers', 'models', 'kind']
const EARLIER_FEATURES = ['providers', 'models']

describe('rules of a repository and of its org (REV-19)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let orgId: string
  let repoId: string
  let otherRepoId: string
  let otherOrgRuleId: string

  let mint: MintInstallationToken = async () => ({ token: 'ghs_installation_token', expiresAt: '2027-01-15T09:00:00Z' })

  let app = (overrides: Partial<RunnerApiDependencies> = {}) =>
    createAppRouter({
      checkDatabase: async () => ({ status: 'ok', latencyMs: 0, migrations: 2 }),
      version: 'test',
      commit: null,
      webhook: disabledWebhook,
      runner: {
        store: createRunnerStore(database.sql),
        registrationToken: REGISTRATION_TOKEN,
        mintInstallationToken: mint,
        providerApiKey: 'sk-or-service-key',
        claimWaitMs: 0,
        claimPollMs: 50,
        ...overrides,
      },
    })

  function call(path: string, token: string, body: unknown, router = app()) {
    return router.fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    )
  }

  async function register(): Promise<string> {
    let response = await call('/api/runner/register', REGISTRATION_TOKEN, { name: 'runner-1', labels: [], version: '0.1.0' })
    return ((await response.json()) as { token: string }).token
  }

  async function queueJob(): Promise<string> {
    let [job] = await database.sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref)
      values (${repoId}, 'lite', 28, ${HEAD}, 'main') returning id`
    return job!.id
  }

  async function addRule(values: { repoId?: string | null; orgId?: string; title: string; paths?: string[]; floor?: string | null; active?: boolean }) {
    let active = values.active ?? true
    let [row] = await database.sql<{ id: string }[]>`
      insert into rules (org_id, repo_id, title, body, paths, severity_floor, active, disabled_at)
      values (${values.orgId ?? orgId}, ${values.repoId === undefined ? repoId : values.repoId}, ${values.title}, ${`Texte de ${values.title}`},
        ${values.paths ?? []}, ${values.floor ?? null}, ${active}, ${active ? null : new Date().toISOString()})
      returning id`
    return row!.id
  }

  function review(findings: ReviewPayload['findings']): ReviewPayload {
    return {
      level: 'lite',
      base: BASE,
      head: HEAD,
      score: 4,
      verdict: 'COMMENT',
      model: 'anthropic/claude-haiku-5.5',
      provider: 'Anthropic',
      costUsd: 0.01,
      promptTokens: 1,
      completionTokens: 1,
      summary: 'Résumé',
      risk: 'Faible',
      diagram: null,
      deeperReview: null,
      findings,
      notReviewed: [],
      skipped: [],
    }
  }

  const finding = (title: string, ruleId?: string): ReviewPayload['findings'][number] => ({
    path: 'db/migrations/0002.sql',
    start_line: 1,
    line: 1,
    severity: 'major',
    category: 'data',
    confidence: 90,
    title,
    scenario: 's',
    fix: 'f',
    suggestion: '',
    anchor: 1,
    blocking: true,
    suggestion_range: null,
    ...(ruleId ? { rule_id: ruleId } : {}),
  })

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    let [org] = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (77, 2001, 'sakuga-software') returning id`
    orgId = org!.id
    let [repo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled) values (${orgId}, 3001, 'sakuga-software/orchard', true) returning id`
    repoId = repo!.id
    let [other] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name, enabled) values (${orgId}, 3002, 'sakuga-software/other', true) returning id`
    otherRepoId = other!.id
    let [otherOrg] = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (78, 2002, 'someone-else') returning id`
    otherOrgRuleId = await addRule({ orgId: otherOrg!.id, repoId: null, title: "Règle d'une autre org" })
  })

  beforeEach(async () => {
    await database.sql`delete from jobs`
    await database.sql`delete from rules where org_id = ${orgId}`
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('sends the active rules of the repository, then those of the org, to a runner that reads them', async () => {
    let orgRule = await addRule({ repoId: null, title: 'Pas de console.log' })
    let repoRule = await addRule({ title: 'Index des FK', paths: ['**/migrations/**'], floor: 'major' })
    await addRule({ title: 'Désactivée', active: false })
    await addRule({ repoId: otherRepoId, title: "Règle d'un autre repo" })
    let token = await register()
    await queueJob()
    let response = await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: [...FEATURES], ownProvider: 'openrouter' })
    let job = (await response.json()) as Job
    assert.deepEqual(job.rules, [
      { id: repoRule, scope: 'repo', title: 'Index des FK', text: 'Texte de Index des FK', paths: ['**/migrations/**'], severityFloor: 'major' },
      { id: orgRule, scope: 'org', title: 'Pas de console.log', text: 'Texte de Pas de console.log', paths: [], severityFloor: null },
    ])
  })

  it('a runner already deployed gets a job with no key that it does not know, and its result without rule_id is stored', async () => {
    await addRule({ title: 'Index des FK', paths: ['**/migrations/**'] })
    let token = await register()
    let jobId = await queueJob()
    let response = await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: EARLIER_FEATURES, ownProvider: 'openrouter' })
    let job = (await response.json()) as Record<string, unknown>
    assert.ok(!('rules' in job), 'no rules for a runner that does not read them')
    assert.deepEqual(Object.keys(job).filter((k) => !EARLIER_JOB_KEYS.includes(k)), [])

    // Its findings have no rule_id: the service takes them as before.
    let result = await call(`/api/runner/jobs/${jobId}/result`, token, { outcome: 'done', attempt: 1, review: review([finding('Sans règle')]) })
    assert.equal(result.status, 204)
    let [stored] = await database.sql<{ result: ReviewPayload }[]>`select result from reviews where job_id = ${jobId}`
    assert.ok(!('rule_id' in stored!.result.findings[0]!))
  })

  it('keeps a rule_id of a rule of the repository or of its org with its title, and drops any other', async () => {
    let repoRule = await addRule({ title: 'Index des FK' })
    let orgRule = await addRule({ repoId: null, title: 'Pas de console.log' })
    let otherRepoRule = await addRule({ repoId: otherRepoId, title: "Règle d'un autre repo" })
    let token = await register()
    let jobId = await queueJob()
    await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: [...FEATURES], ownProvider: 'openrouter' })
    let findings = [
      finding('Du repo', repoRule),
      finding("De l'org", orgRule),
      finding("D'un autre repo", otherRepoRule),
      finding("D'une autre org", otherOrgRuleId),
      finding('Inconnue', '7f2a8e3c-0d9b-4a4f-9e5d-3b4c5d6e7f80'),
    ]
    let result = await call(`/api/runner/jobs/${jobId}/result`, token, { outcome: 'done', attempt: 1, review: review(findings) })
    assert.equal(result.status, 204)
    let [stored] = await database.sql<{ result: { findings: { title: string; rule_id?: string; rule_title?: string }[] } }[]>`
      select result from reviews where job_id = ${jobId}`
    assert.deepEqual(
      stored!.result.findings.map((f) => [f.title, f.rule_id ?? null, f.rule_title ?? null]),
      [
        ['Du repo', repoRule, 'Index des FK'],
        ["De l'org", orgRule, 'Pas de console.log'],
        ["D'un autre repo", null, null],
        ["D'une autre org", null, null],
        ['Inconnue', null, null],
      ],
    )
  })

  it('keeps the citation of a rule that the job carried, with its title then, even when the rule is renamed, disabled or removed since', async () => {
    let renamed = await addRule({ title: 'Index des FK', floor: 'major' })
    let removed = await addRule({ repoId: null, title: 'Pas de console.log' })
    let token = await register()
    let jobId = await queueJob()
    await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: [...FEATURES], ownProvider: 'openrouter' })
    // While the runner works: an admin renames and disables one rule, and removes the other.
    await database.sql`update rules set title = 'Autre titre', active = false, disabled_at = now() where id = ${renamed}`
    await database.sql`delete from rules where id = ${removed}`
    // A rule added after the claim was never sent: a finding cannot cite it.
    let later = await addRule({ title: 'Ajoutée après' })
    let result = await call(`/api/runner/jobs/${jobId}/result`, token, {
      outcome: 'done',
      attempt: 1,
      review: review([finding('A', renamed), finding('B', removed), finding('C', later)]),
    })
    assert.equal(result.status, 204)
    let [stored] = await database.sql<{ result: { findings: { title: string; rule_id?: string; rule_title?: string }[] } }[]>`
      select result from reviews where job_id = ${jobId}`
    assert.deepEqual(
      stored!.result.findings.map((f) => [f.title, f.rule_id ?? null, f.rule_title ?? null]),
      [
        ['A', renamed, 'Index des FK'],
        ['B', removed, 'Pas de console.log'],
        ['C', null, null],
      ],
    )
  })

  it('forgets the rules of an attempt when an older runner claims the job again', async () => {
    let rule = await addRule({ title: 'Index des FK' })
    let token = await register()
    let jobId = await queueJob()
    await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: [...FEATURES], ownProvider: 'openrouter' })
    // The first attempt is given back (a failed mint, a lost lease): the job is queued again.
    await database.sql`update jobs set state = 'queued', not_before = null, lease_expires_at = null where id = ${jobId}`
    await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: EARLIER_FEATURES, ownProvider: 'openrouter' })
    let [job] = await database.sql<{ sent: unknown; attempts: number }[]>`select sent_rules as sent, attempts from jobs where id = ${jobId}`
    assert.deepEqual({ sent: job!.sent, attempts: job!.attempts }, { sent: null, attempts: 2 })
    await call(`/api/runner/jobs/${jobId}/result`, token, { outcome: 'done', attempt: 2, review: review([finding('A', rule)]) })
    let [stored] = await database.sql<{ result: ReviewPayload }[]>`select result from reviews where job_id = ${jobId}`
    assert.ok(!('rule_id' in stored!.result.findings[0]!), 'the second attempt was sent no rule: it cites none')
  })

  it('cites no rule for a runner that was sent none', async () => {
    let rule = await addRule({ title: 'Index des FK' })
    let token = await register()
    let jobId = await queueJob()
    await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: EARLIER_FEATURES, ownProvider: 'openrouter' })
    let [job] = await database.sql<{ sent: unknown }[]>`select sent_rules as sent from jobs where id = ${jobId}`
    assert.equal(job!.sent, null)
    // A forged result of that runner with a rule_id: the strict check refuses unknown keys only for
    // the earlier protocol; this one takes the key, and the service drops it.
    await call(`/api/runner/jobs/${jobId}/result`, token, { outcome: 'done', attempt: 1, review: review([finding('A', rule)]) })
    let [stored] = await database.sql<{ result: ReviewPayload }[]>`select result from reviews where job_id = ${jobId}`
    assert.ok(!('rule_id' in stored!.result.findings[0]!))
  })

  it('gives the job back to the queue when its rules cannot be read', async () => {
    await addRule({ title: 'Index des FK' })
    let token = await register()
    let jobId = await queueJob()
    let store = createRunnerStore(database.sql)
    let failing = app({ store: { ...store, jobRules: async () => Promise.reject(new Error('connection lost')) } })
    let lines: string[] = []
    let write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stderr.write
    let response
    try {
      response = await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: [...FEATURES], ownProvider: 'openrouter' }, failing)
    } finally {
      process.stderr.write = write
    }
    let event = lines.map((l) => JSON.parse(l)).find((l) => l.jobId === jobId)
    assert.deepEqual({ event: event?.event, stage: event?.stage, error: event?.error }, { event: 'job.rules_failed', stage: 'rules', error: 'rules: connection lost' })
    assert.equal(response.status, 204, 'no job without its rules')
    let [row] = await database.sql<{ state: string; attempts: number; notBefore: Date | null }[]>`
      select state, attempts, not_before as "notBefore" from jobs where id = ${jobId}`
    assert.deepEqual({ state: row!.state, attempts: row!.attempts, backoff: row!.notBefore !== null }, { state: 'queued', attempts: 1, backoff: true })
  })

  it('publishes a stored finding of a rule with the title of the rule', async () => {
    let repoRule = await addRule({ title: 'Index des FK' })
    let token = await register()
    let jobId = await queueJob()
    await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: [...FEATURES], ownProvider: 'openrouter' })
    await call(`/api/runner/jobs/${jobId}/result`, token, { outcome: 'done', attempt: 1, review: review([finding('FK sans index', repoRule)]) })
    // The publisher reads `reviews.result` as stored, with `rule_title`, and no check refuses the key.
    let [stored] = await database.sql<{ result: ReviewPayload }[]>`select result from reviews where job_id = ${jobId}`
    let fake = createFakeGitHub({ head: HEAD, commits: { [HEAD]: 'feat: orders' } })
    let github = createGitHub({ apiUrl: fake.apiUrl, token: 'ghs_fake', fetch: fake.fetch })
    await publishReview(github, { owner: 'sakuga-software', name: 'sakuga-review', pr: 28, botLogin: BOT, webUrl: 'https://github.com' }, stored!.result)
    let [comment] = fake.botThreads()
    assert.match(comment!.body, /\*\*FK sans index\*\*\n\nRègle : « Index des FK »/)
  })

  it('never sends a pattern out of the limits of the protocol, whatever the row holds', async () => {
    await database.sql`
      insert into rules (org_id, repo_id, title, body, paths)
      values (${orgId}, ${repoId}, 'Motifs', 'Texte', ${['', 'x'.repeat(301), 'ok/**']})`
    let token = await register()
    await queueJob()
    let response = await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: [...FEATURES], ownProvider: 'openrouter' })
    let job = (await response.json()) as Job
    assert.deepEqual(job.rules?.[0]?.paths, ['ok/**'])
  })

  it('leaves out a rule that the check of the runner would refuse, or that would cover every path', async () => {
    // 150 emoji: 150 characters for Postgres, 300 UTF-16 units for the protocol (at most 200).
    await addRule({ title: '🙂'.repeat(150) })
    await database.sql`
      insert into rules (org_id, repo_id, title, body, paths)
      values (${orgId}, ${repoId}, 'Motifs trop longs', 'Texte', ${['x'.repeat(301)]})`
    let kept = await addRule({ title: 'Valide', paths: ['src/**'] })
    let token = await register()
    await queueJob()
    let response = await call('/api/runner/jobs/claim', token, { hasProviderKey: true, features: [...FEATURES], ownProvider: 'openrouter' })
    let job = (await response.json()) as Job
    assert.deepEqual(job.rules?.map((r) => r.id), [kept])
  })

  it('refuses a rule out of its limits', async () => {
    await assert.rejects(addRule({ title: '' }), /rules_title_length/)
    await assert.rejects(addRule({ title: 'x', floor: 'info' }), /rules_severity_floor/)
    await assert.rejects(addRule({ title: 'x', paths: Array(21).fill('a/**') }), /rules_paths_count/)
    await assert.rejects(
      database.sql`insert into rules (org_id, title, body, active) values (${orgId}, 'x', 'y', false)`,
      /rules_disabled_when_inactive/,
    )
  })
})
