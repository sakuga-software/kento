import type { Level } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG } from '../auth/test-helpers.ts'
import type { PullRequestNow, ReadPullRequest } from '../dashboard/github.ts'
import type { DashboardScreen, DashboardStore, FailureBanner, RetryOutcome } from '../dashboard/store.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import { capState, duration, failureText, money, setupSteps } from './dashboard.tsx'

const COOKIE = '__Host-kento_session'
const NOW = new Date('2026-10-29T10:00:00Z')
const JOB_ID = '11111111-1111-4111-8111-111111111111'
const REPO_ID = '22222222-2222-4222-8222-222222222222'

function week(): DashboardScreen['week'] {
  return Array.from({ length: 7 }, (_, i) => ({
    day: `2026-10-${23 + i}`,
    published: { lite: i, balanced: i === 6 ? 2 : 0, heavy: 0 },
    failed: i === 6 ? 1 : 0,
    meanDurationMs: i === 0 ? null : 95_000,
  }))
}

function banner(overrides: Partial<FailureBanner> = {}): FailureBanner {
  return {
    id: JOB_ID,
    repoId: REPO_ID,
    repo: 'sakuga-software/orchard',
    prNumber: 128,
    kind: 'review',
    level: 'lite',
    attempts: 3,
    reason: 'lease expired 2 times',
    runnerName: 'runners-host',
    finishedAt: NOW,
    previous: { score: 3, publishedAt: new Date('2026-10-29T08:00:00Z') },
    retry: null,
    estimates: { lite: 0.004, balanced: 0.12, heavy: null },
    ...overrides,
  }
}

function screen(overrides: Partial<DashboardScreen> = {}): DashboardScreen {
  return {
    now: NOW,
    banner: banner(),
    failures: [banner()],
    week: week(),
    recent: [
      {
        id: 'r1',
        repoId: REPO_ID,
        repo: 'sakuga-software/orchard',
        prNumber: 127,
        level: 'balanced',
        verdict: 'REQUEST_CHANGES',
        score: 2,
        findings: 4,
        costUsd: 0.1234,
        durationMs: 125_000,
        createdAt: new Date(NOW.getTime() - 60_000),
        publishedAt: NOW,
      },
    ],
    costs: {
      dayUsd: 4.5,
      monthUsd: 31.2,
      dayByProvider: [{ providerId: null, label: 'Clé du service', usd: 4.5 }],
      monthByProvider: [{ providerId: null, label: 'Clé du service', usd: 31.2 }],
      monthUnknown: 2,
    },
    caps: { dailyCapUsd: 5, monthlyCapUsd: null, alertPct: 80 },
    queue: {
      running: [
        {
          id: 'j1',
          repo: 'sakuga-software/orchard',
          prNumber: 130,
          kind: 'review',
          level: 'heavy',
          attempts: 2,
          createdAt: NOW,
          startedAt: new Date(NOW.getTime() - 90_000),
          leaseExpiresAt: new Date(NOW.getTime() + 60_000),
          notBefore: null,
          runnerName: 'mac-mini',
          runnerSeenAt: new Date(NOW.getTime() - 5_000),
        },
      ],
      queued: [],
      runningCount: 1,
      queuedCount: 0,
    },
    runners: [{ id: 'run1', name: 'mac-mini', orgId: ORG.id, lastSeenAt: new Date(NOW.getTime() - 5_000), running: 1 }],
    workflowRepos: ['sakuga-software/dojo'],
    setup: { published: true, suspended: false, enabledRepos: 2, providers: 1, pendingRegistrations: 0 },
    ...overrides,
  }
}

const HEAD = 'a'.repeat(40)

function setup(
  view: DashboardScreen = screen(),
  outcome: RetryOutcome = { kind: 'queued', jobId: 'new' },
  github: PullRequestNow | Error | null = { open: true, headSha: HEAD },
  serviceKey = false,
) {
  let auth = fakeAuth({ orgs: [ORG] })
  auth.setRole(ORG, ALEX, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let retries: string[] = []
  let reads: string[] = []
  let store: DashboardStore = {
    async screen(orgId) {
      reads.push(orgId)
      return view
    },
    async retryTarget(_orgId, jobId) {
      return jobId === JOB_ID ? { installationId: 42, githubRepoId: 7, fullName: 'sakuga-software/orchard', prNumber: 128, headSha: HEAD } : null
    },
    async retry(orgId, jobId, level: Level, githubHead) {
      retries.push(`${orgId} ${jobId} ${level} ${githubHead}`)
      if (githubHead !== null && githubHead !== HEAD) return { kind: 'stale' }
      return outcome
    },
  }
  let asked: string[] = []
  let readPullRequest: ReadPullRequest | null =
    github === null
      ? null
      : async (target) => {
          asked.push(`${target.installationId} ${target.githubRepoId} ${target.fullName}#${target.prNumber}`)
          if (github instanceof Error) throw github
          return github
        }
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: auth.deps,
    dashboard: { store, githubUrl: 'https://github.com', readPullRequest, serviceKey },
  })

  function request(path: string, init: { cookie?: string | null; form?: Record<string, string> } = {}) {
    let headers = new Headers()
    if (init.cookie) headers.set('Cookie', init.cookie)
    return router.fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: init.form ? 'POST' : 'GET',
        headers,
        body: init.form ? new URLSearchParams(init.form) : undefined,
      }),
    )
  }

  async function signIn(profile = ALEX) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: cookieOf(start, COOKIE) })
    let cookie = cookieOf(callback, COOKIE)!
    let html = await (await request('/', { cookie })).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
    return { cookie, csrf, html }
  }

  return { request, signIn, retries, reads, asked }
}

describe('the words of the dashboard', () => {
  it('says why a job failed, in French for the reasons of the service', () => {
    assert.equal(failureText({ reason: 'lease expired 2 times', runnerName: 'runners-host' }), 'le bail a expiré deux fois sur runners-host')
    assert.equal(failureText({ reason: 'lease expired 1 times', runnerName: null }), 'le bail a expiré une fois')
    assert.equal(
      failureText({ reason: 'the provider « Anthropic » refused its key (401): unauthorized', runnerName: null }),
      'le provider « Anthropic » a refusé sa clé (401)',
    )
    assert.equal(failureText({ reason: 'clone failed', runnerName: 'x' }), '« clone failed »')
    assert.equal(failureText({ reason: null, runnerName: null }), 'aucune raison enregistrée')
    assert.ok(failureText({ reason: 'x'.repeat(400), runnerName: null }).endsWith('… »'))
  })

  it('writes dollars and durations', () => {
    assert.equal(money(0.004).replace(/\s/g, ' '), '0,004 $')
    assert.equal(money(12.5).replace(/\s/g, ' '), '12,50 $')
    assert.equal(money(0).replace(/\s/g, ' '), '0,00 $')
    assert.equal(duration(42_000), '42 s')
    assert.equal(duration(185_000), '3 min 05 s')
  })

  it('places a spend against its limit and the alert threshold', () => {
    assert.equal(capState(10, null, 80), 'none')
    assert.equal(capState(3.99, 5, 80), 'ok')
    assert.equal(capState(4, 5, 80), 'alert')
    assert.equal(capState(5, 5, 80), 'reached')
  })
})

/** A new org: the App is installed, and nothing else is there. */
function fresh(overrides: Partial<DashboardScreen> = {}): DashboardScreen {
  return screen({
    banner: null,
    failures: [],
    recent: [],
    workflowRepos: [],
    runners: [],
    queue: { running: [], queued: [], runningCount: 0, queuedCount: 0 },
    setup: { published: false, suspended: false, enabledRepos: 0, providers: 0, pendingRegistrations: 0 },
    ...overrides,
  })
}

describe('the list « Mise en route » (REV-26)', () => {
  const OPTIONS = { serviceKey: false, installationUrl: 'https://github.com/organizations/sakuga-software/settings/installations/42' }
  const states = (view: DashboardScreen, options = OPTIONS) => setupSteps(view, options)?.map((step) => `${step.key}:${step.state}`)

  it('has five steps from the state of a new org: only the App is done', () => {
    assert.deepEqual(states(fresh()), ['app:done', 'provider:todo', 'runner:todo', 'repo:todo', 'review:todo'])
  })

  it('counts the key of the service as a provider', () => {
    assert.deepEqual(states(fresh(), { ...OPTIONS, serviceKey: true })?.[1], 'provider:done')
  })

  it('marks each step from what the org has, and the first review as waiting while a job is in the queue', () => {
    let view = fresh({
      setup: { published: false, suspended: false, enabledRepos: 1, providers: 2, pendingRegistrations: 0 },
      runners: [{ id: 'r', name: 'mac-mini', orgId: ORG.id, lastSeenAt: new Date(NOW.getTime() - 5_000), running: 0 }],
      queue: { running: [], queued: [], runningCount: 0, queuedCount: 1 },
    })
    assert.deepEqual(states(view), ['app:done', 'provider:done', 'runner:done', 'repo:done', 'review:wait'])
  })

  it('says that a runner is on its way when it is registered but silent, or when a token waits for it', () => {
    let silent = fresh({ runners: [{ id: 'r', name: 'old', orgId: ORG.id, lastSeenAt: new Date(NOW.getTime() - 3_600_000), running: 0 }] })
    assert.equal(states(silent)?.[2], 'runner:wait')
    let token = fresh({ setup: { published: false, suspended: false, enabledRepos: 0, providers: 0, pendingRegistrations: 1 } })
    assert.equal(states(token)?.[2], 'runner:wait')
  })

  it('says that a suspended installation is to be done again', () => {
    let view = fresh({ setup: { published: false, suspended: true, enabledRepos: 0, providers: 0, pendingRegistrations: 0 } })
    assert.equal(states(view)?.[0], 'app:todo')
  })

  it('is gone once a review of the org is published', () => {
    assert.equal(setupSteps(screen(), OPTIONS), null)
  })

  it('leads a new admin to each step in one click', async () => {
    let { signIn } = setup(fresh())
    let { html } = await signIn(ALEX)
    assert.match(html, /<h2 id="setup-title" class="section-title">Mise en route<\/h2>/)
    assert.match(html, /1 étape sur 5/)
    assert.match(html, /href="https:\/\/github.com\/organizations\/sakuga-software\/settings\/installations\/\d+"[^>]*>Choisir les repos sur GitHub/)
    assert.match(html, /href="\/settings#nouveau-provider"[^>]*>Ajouter un provider/)
    assert.match(html, /href="\/runners"[^>]*>Créer un runner/)
    assert.match(html, /href="\/repos"[^>]*>Activer un repo/)
    assert.match(html, /Ouvrez une pull request/)
    assert.doesNotMatch(html, /Demandez à un admin/)
  })

  it('shows a member the same list to read, with « Demandez à un admin » and no link to a step to do', async () => {
    let { signIn } = setup(fresh())
    let { html } = await signIn(CAMILLE)
    assert.match(html, /Mise en route/)
    assert.equal(html.match(/Demandez à un admin de l’organisation\./g)?.length, 3)
    assert.doesNotMatch(html, /href="\/runners"[^>]*>Créer un runner/)
    assert.doesNotMatch(html, /href="\/repos"[^>]*>Activer un repo/)
    assert.doesNotMatch(html, /href="\/settings#nouveau-provider"/)
  })

  it('is not on the dashboard of an org with a published review', async () => {
    let { signIn } = setup()
    let { html } = await signIn(ALEX)
    assert.doesNotMatch(html, /Mise en route/)
  })
})

describe('the dashboard', () => {
  it('shows the failure, the week, the last reviews, the cost, the queue and the runners to an admin', async () => {
    let { signIn, reads } = setup()
    let { html } = await signIn(ALEX)
    assert.deepEqual([...new Set(reads)], [ORG.id])
    assert.match(html, /La review lite de <span class="mono">sakuga-software\/orchard#128<\/span> a échoué/)
    assert.match(html, /le bail a expiré deux fois sur runners-host/)
    assert.match(html, /La review précédente \(3\/5, publiée le/)
    assert.match(html, /href="https:\/\/github.com\/sakuga-software\/orchard\/pull\/128"/)
    assert.match(html, /action="\/jobs\/11111111-1111-4111-8111-111111111111\/retry"/)
    assert.match(html, /Relancer en balanced/)
    assert.match(html, /coût inconnu/)
    assert.match(html, /Reviews publiées · 7 jours/)
    assert.match(html, /Changements demandés/)
    assert.match(html, /2\/5/)
    assert.match(html, /Seuil d’alerte atteint/)
    assert.match(html, /2 reviews ou résolutions du mois sans coût/)
    assert.match(html, /Sur <span class="mono">mac-mini<\/span>/)
    assert.match(html, /tentative 2/)
    assert.match(html, /href="\/runners"/)
    assert.match(html, /href="\/repos\/22222222-2222-4222-8222-222222222222\/config"/)
    assert.match(html, /à partir de 10 findings clos/)
    assert.match(html, /encore sur\s*<code>review.yml<\/code>/)
    assert.match(html, /src="\/assets\/dashboard.js\?v=1.2.3"/)
  })

  it('shows the same dashboard to a member, without the retry buttons', async () => {
    let { signIn } = setup()
    let { html } = await signIn(CAMILLE)
    assert.match(html, /Lecture seule/)
    assert.match(html, /le bail a expiré deux fois/)
    assert.doesNotMatch(html, /\/retry"/)
    assert.doesNotMatch(html, /Relancer en/)
  })

  it('says that a retry is under way, with no button, until its review is published', async () => {
    let { signIn } = setup(screen({ banner: banner({ retry: { id: 'j9', level: 'balanced', state: 'queued' } }) }))
    let { html } = await signIn(ALEX)
    assert.match(html, /Relance en balanced en file/)
    assert.doesNotMatch(html, /Relancer en/)
  })

  it('lists an offline runner first, with its state, as the Runners screen does (REV-30)', async () => {
    let { signIn } = setup(
      screen({
        runners: [
          { id: 'run1', name: 'mac-mini', orgId: ORG.id, lastSeenAt: new Date(NOW.getTime() - 5_000), running: 1 },
          { id: 'run2', name: 'hetzner-cx22', orgId: ORG.id, lastSeenAt: new Date(NOW.getTime() - 3 * 86_400_000), running: 0 },
        ],
      }),
    )
    let { html } = await signIn(ALEX)
    let section = html.slice(html.indexOf('id="dash-runners-title"'))
    assert.match(section, /<span class="status status-offline">Hors ligne depuis 3 j<\/span>/)
    assert.ok(section.indexOf('hetzner-cx22') < section.indexOf('mac-mini'), 'the offline runner comes first')
  })

  it('has empty states', async () => {
    let { signIn } = setup(
      screen({
        banner: null,
        failures: [],
        recent: [],
        workflowRepos: [],
        runners: [],
        caps: { dailyCapUsd: null, monthlyCapUsd: null, alertPct: 80 },
        costs: { dayUsd: 0, monthUsd: 0, dayByProvider: [], monthByProvider: [], monthUnknown: 0 },
        queue: { running: [], queued: [], runningCount: 0, queuedCount: 0 },
      }),
    )
    let { html } = await signIn(ALEX)
    assert.doesNotMatch(html, /<\/span> a échoué/)
    assert.match(html, /Aucune review pour l’instant/)
    assert.match(html, /Aucun job en échec sur 7 jours/)
    assert.match(html, /Aucun plafond pour l’organisation/)
    assert.match(html, /Aucun runner/)
    assert.doesNotMatch(html, /review.yml/)
  })

  it('lets an admin retry a failed job, with a CSRF token, and says what happened', async () => {
    let { signIn, request, retries } = setup()
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request(`/jobs/${JOB_ID}/retry`, { cookie, form: { _csrf: csrf, level: 'balanced' } })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/?notice=retried')
    assert.deepEqual(retries, [`${ORG.id} ${JOB_ID} balanced ${HEAD}`])
    let html = await (await request('/?notice=retried', { cookie })).text()
    assert.match(html, /Review relancée/)
  })

  it('refuses a retry from a member, without a CSRF token, or with an unknown level', async () => {
    let { signIn, request, retries } = setup()
    let member = await signIn(CAMILLE)
    assert.equal((await request(`/jobs/${JOB_ID}/retry`, { cookie: member.cookie, form: { _csrf: member.csrf, level: 'lite' } })).status, 403)
    let admin = await signIn(ALEX)
    assert.notEqual((await request(`/jobs/${JOB_ID}/retry`, { cookie: admin.cookie, form: { level: 'lite' } })).status, 303)
    assert.equal((await request(`/jobs/${JOB_ID}/retry`, { cookie: admin.cookie, form: { _csrf: admin.csrf, level: 'ultra' } })).status, 400)
    assert.deepEqual(retries, [])
  })

  it('sends a bad id to « missing » without asking the store', async () => {
    let { signIn, request, retries } = setup()
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request('/jobs/not-a-uuid/retry', { cookie, form: { _csrf: csrf, level: 'lite' } })
    assert.equal(response.headers.get('Location'), '/?notice=missing')
    assert.deepEqual(retries, [])
  })

  it('asks GitHub for the head of the pull request before a retry', async () => {
    let { signIn, request, retries, asked } = setup(screen(), { kind: 'queued', jobId: 'new' }, { open: true, headSha: 'b'.repeat(40) })
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request(`/jobs/${JOB_ID}/retry`, { cookie, form: { _csrf: csrf, level: 'lite' } })
    assert.deepEqual(asked, ['42 7 sakuga-software/orchard#128'])
    assert.deepEqual(retries, [`${ORG.id} ${JOB_ID} lite ${'b'.repeat(40)}`])
    assert.equal(response.headers.get('Location'), '/?notice=stale')
  })

  it('queues nothing for a pull request closed on GitHub, or when GitHub does not answer', async () => {
    for (let [github, notice] of [
      [{ open: false, headSha: HEAD }, 'closed'],
      [new Error('502'), 'github_failed'],
    ] as const) {
      let { signIn, request, retries } = setup(screen(), { kind: 'queued', jobId: 'new' }, github)
      let { cookie, csrf } = await signIn(ALEX)
      let response = await request(`/jobs/${JOB_ID}/retry`, { cookie, form: { _csrf: csrf, level: 'lite' } })
      assert.equal(response.headers.get('Location'), `/?notice=${notice}`)
      assert.deepEqual(retries, [])
    }
  })

  it('without the GitHub App, lets the jobs of the database decide', async () => {
    let { signIn, request, retries } = setup(screen(), { kind: 'queued', jobId: 'new' }, null)
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request(`/jobs/${JOB_ID}/retry`, { cookie, form: { _csrf: csrf, level: 'heavy' } })
    assert.equal(response.headers.get('Location'), '/?notice=retried')
    assert.deepEqual(retries, [`${ORG.id} ${JOB_ID} heavy null`])
  })

  it('maps each outcome of a retry to its notice', async () => {
    for (let [kind, notice] of [
      ['already', 'already'],
      ['stale', 'stale'],
      ['not_found', 'missing'],
      ['capped', 'capped'],
    ] as const) {
      let { signIn, request } = setup(screen(), kind === 'already' ? { kind, jobId: 'x' } : kind === 'capped' ? { kind, period: 'day' } : { kind })
      let { cookie, csrf } = await signIn(ALEX)
      let response = await request(`/jobs/${JOB_ID}/retry`, { cookie, form: { _csrf: csrf, level: 'lite' } })
      assert.equal(response.headers.get('Location'), `/?notice=${notice}`)
    }
  })
})
