import type { Level } from '@sakuga-review/protocol'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG } from '../auth/test-helpers.ts'
import type { PullRequestNow, ReadPullRequest } from '../dashboard/github.ts'
import type { DashboardScreen, DashboardStore, FailureBanner, RetryOutcome } from '../dashboard/store.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { precisionOf } from '../findings/precision.ts'
import type { FindingsScreenStore } from '../findings/screen.ts'
import { EMPTY_REPORT, fakeFindingsScreenStore } from '../findings/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import { capState, failureText, setupSteps, stallText, weekMeanDuration } from './dashboard.tsx'
import { runnerState } from './runners.tsx'

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

/** The runners of the default screen. */
function runnersOf(): DashboardScreen['runners'] {
  return [{ id: 'run1', name: 'mac-mini', orgId: ORG.id, lastSeenAt: new Date(NOW.getTime() - 5_000), running: 1 }]
}

/** The counts that the store reads in SQL, from the runners of a screen. */
function countRunners(runners: DashboardScreen['runners']): DashboardScreen['runnerCounts'] {
  let counts = { online: 0, late: 0, offline: 0 }
  for (let runner of runners) {
    let state = runnerState({ revokedAt: null, lastSeenAt: runner.lastSeenAt }, NOW)
    if (state !== 'revoked') counts[state]++
  }
  return counts
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
      dayByProvider: [{ providerId: null, label: 'Service key', usd: 4.5 }],
      monthByProvider: [{ providerId: null, label: 'Service key', usd: 31.2 }],
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
    runners: runnersOf(),
    stall: null,
    workflowRepos: ['sakuga-software/dojo'],
    setup: { published: true, suspended: false, enabledRepos: 2, providers: 1, serviceRunners: 1, pendingRegistrations: 0 },
    ...overrides,
    runnerCounts: overrides.runnerCounts ?? countRunners(overrides.runners ?? runnersOf()),
  }
}

const HEAD = 'a'.repeat(40)

function setup(
  view: DashboardScreen = screen(),
  outcome: RetryOutcome = { kind: 'queued', jobId: 'new' },
  github: PullRequestNow | Error | null = { open: true, headSha: HEAD },
  serviceKey = false,
  findings: FindingsScreenStore | null = null,
) {
  let auth = fakeAuth({ orgs: [ORG] })
  auth.setRole(ORG, ALEX, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let retries: string[] = []
  let dismissals: string[] = []
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
    async dismissFailure(orgId, jobId, login) {
      dismissals.push(`${orgId} ${jobId} ${login}`)
      return jobId === JOB_ID
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
    findings: findings ? { store: findings, githubUrl: 'https://github.com' } : null,
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

  return { request, signIn, retries, dismissals, reads, asked }
}

describe('the words of the dashboard', () => {
  it('says why a job failed and what to do, in plain words (app/ui/reasons.test.ts has the whole table)', () => {
    assert.deepEqual(failureText({ reason: 'lease expired 2 times', runnerName: 'runners-host' }), {
      text: 'the runner stopped answering during the job twice, last runners-host',
      action: 'Check on the Runners screen that a runner is online, then retry.',
      raw: null,
    })
    let refused = failureText({ reason: 'the provider "Anthropic" refused its key (401): unauthorized', runnerName: null })
    assert.equal(refused.text, 'the provider "Anthropic" refused its key, code 401')
    assert.equal(refused.raw, 'the provider "Anthropic" refused its key (401): unauthorized')
    assert.equal(failureText({ reason: 'clone failed', runnerName: 'x' }).text, 'the runner could not clone the repo')
    assert.equal(failureText({ reason: null, runnerName: null }).text, 'no reason recorded')
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
    setup: { published: false, suspended: false, enabledRepos: 0, providers: 0, serviceRunners: 1, pendingRegistrations: 0 },
    ...overrides,
  })
}

describe('the list "Getting started" (REV-26)', () => {
  const OPTIONS = { serviceKey: false, installationUrl: 'https://github.com/organizations/sakuga-software/settings/installations/42' }
  const states = (view: DashboardScreen, options = OPTIONS) => setupSteps(view, options)?.map((step) => `${step.key}:${step.state}`)

  it('has five steps from the state of a new org: only the App is done', () => {
    assert.deepEqual(states(fresh()), ['app:done', 'provider:todo', 'runner:todo', 'repo:todo', 'review:todo'])
  })

  it('counts the key of the service as a provider while the service has a trusted runner', () => {
    assert.deepEqual(states(fresh(), { ...OPTIONS, serviceKey: true })?.[1], 'provider:done')
    let step = setupSteps(fresh(), { ...OPTIONS, serviceKey: true })![1]!
    assert.match(step.text, /The runners of the service review with the key of the service\. A runner of your organization needs its own OpenRouter key\./)
  })

  it('does not count the key of the service when the service has no trusted runner: a runner of the org never gets it (REV-130)', () => {
    let view = fresh({ setup: { published: false, suspended: false, enabledRepos: 0, providers: 0, serviceRunners: 0, pendingRegistrations: 0 } })
    let step = setupSteps(view, { ...OPTIONS, serviceKey: true })![1]!
    assert.equal(step.state, 'todo')
    assert.equal(
      step.text,
      'No provider. The key of the service goes only to a runner of the service, and there is none. A runner of your organization needs its own OpenRouter key, or add a provider.',
    )
    assert.doesNotMatch(step.text, /A trusted runner gets the key of the service/)
  })

  it('marks each step from what the org has, and the first review as waiting while a job is in the queue', () => {
    let view = fresh({
      setup: { published: false, suspended: false, enabledRepos: 1, providers: 2, serviceRunners: 1, pendingRegistrations: 0 },
      runners: [{ id: 'r', name: 'mac-mini', orgId: ORG.id, lastSeenAt: new Date(NOW.getTime() - 5_000), running: 0 }],
      queue: { running: [], queued: [], runningCount: 0, queuedCount: 1 },
    })
    assert.deepEqual(states(view), ['app:done', 'provider:done', 'runner:done', 'repo:done', 'review:wait'])
  })

  it('says that a runner is on its way when it is registered but silent, or when a token waits for it', () => {
    let silent = fresh({ runners: [{ id: 'r', name: 'old', orgId: ORG.id, lastSeenAt: new Date(NOW.getTime() - 3_600_000), running: 0 }] })
    assert.equal(states(silent)?.[2], 'runner:wait')
    let token = fresh({ setup: { published: false, suspended: false, enabledRepos: 0, providers: 0, serviceRunners: 1, pendingRegistrations: 1 } })
    assert.equal(states(token)?.[2], 'runner:wait')
  })

  it('says that a suspended installation is to be done again', () => {
    let view = fresh({ setup: { published: false, suspended: true, enabledRepos: 0, providers: 0, serviceRunners: 1, pendingRegistrations: 0 } })
    assert.equal(states(view)?.[0], 'app:todo')
  })

  it('is gone once a review of the org is published', () => {
    assert.equal(setupSteps(screen(), OPTIONS), null)
  })

  it('leads a new admin to each step in one click', async () => {
    let { signIn } = setup(fresh())
    let { html } = await signIn(ALEX)
    assert.match(html, /<h2 id="setup-title" class="section-title">Getting started<\/h2>/)
    assert.match(html, /1 of 5 steps/)
    assert.match(html, /href="https:\/\/github.com\/organizations\/sakuga-software\/settings\/installations\/\d+"[^>]*>Choose the repos on GitHub/)
    assert.match(html, /href="\/settings#new-provider"[^>]*>Add a provider/)
    assert.match(html, /href="\/runners"[^>]*>Create a runner/)
    assert.match(html, /href="\/repos"[^>]*>Enable a repo/)
    assert.match(html, /Open a pull request/)
    assert.doesNotMatch(html, /Ask an admin/)
  })

  it('shows a member the same list to read, with "Ask an admin" and no link to a step to do', async () => {
    let { signIn } = setup(fresh())
    let { html } = await signIn(CAMILLE)
    assert.match(html, /Getting started/)
    assert.equal(html.match(/Ask an admin of the organization\./g)?.length, 3)
    assert.doesNotMatch(html, /href="\/runners"[^>]*>Create a runner/)
    assert.doesNotMatch(html, /href="\/repos"[^>]*>Enable a repo/)
    assert.doesNotMatch(html, /href="\/settings#new-provider"/)
  })

  it('is not on the dashboard of an org with a published review', async () => {
    let { signIn } = setup()
    let { html } = await signIn(ALEX)
    assert.doesNotMatch(html, /Mise en route/)
  })
})

describe('"To do" and the band of numbers (REV-91)', () => {
  it('weighs the mean time of each day by its published reviews', () => {
    let day = (n: number, mean: number | null) => ({ day: '2026-10-29', published: { lite: n, balanced: 0, heavy: 0 }, failed: 0, meanDurationMs: mean })
    assert.equal(weekMeanDuration([day(1, 60_000), day(3, 120_000)]), 105_000)
    assert.equal(weekMeanDuration([day(0, null), day(2, 30_000)]), 30_000)
    assert.equal(weekMeanDuration([day(0, null)]), null)
  })

  it('lists the cost over its alert, the silent runner and review.yml, each with its way out, and counts them', async () => {
    let { signIn } = setup(
      screen({
        banner: null,
        runners: [{ id: 'run9', name: 'portable-alex', orgId: ORG.id, lastSeenAt: new Date(NOW.getTime() - 47 * 60_000), running: 0 }],
      }),
    )
    let { html } = await signIn(ALEX)
    let todo = html.slice(html.indexOf('id="todo-title"'), html.indexOf('</ul>', html.indexOf('id="todo-title"')))
    assert.match(todo, /To do <span class="count">3<\/span>/)
    assert.match(todo, /The daily alert threshold is reached/)
    assert.match(todo, /\$4\.50 of \$5\.00 · 90%/)
    assert.match(todo, /href="\/settings#cap"[^>]*>Change the cap/)
    assert.match(todo, /<code>portable-alex<\/code> has given no signal for 47 min/)
    assert.match(todo, /It has no job/)
    assert.match(todo, /still on\s*<code>review.yml<\/code>/)
    // A member reads where the limit is, and cannot change it.
    let member = (await signIn(CAMILLE)).html
    assert.match(member, /href="\/settings#cap"[^>]*>See the cap/)
  })

  it('counts the silent runners that the bounded list leaves out, with no empty names (REV-91)', async () => {
    let { signIn } = setup(screen({ banner: null, workflowRepos: [], runners: [], runnerCounts: { online: 0, late: 1, offline: 4 } }))
    let { html } = await signIn(ALEX)
    let todo = html.slice(html.indexOf('id="todo-title"'), html.indexOf('</section>', html.indexOf('id="todo-runners"')))
    assert.match(todo, /<h3 id="todo-runners" class="todo-title">5 runners give no signal<\/h3>/)
    assert.match(todo, /<p class="hint">A runner is online again at its next signal\.<\/p>/)
    // Each row is a region named by its title, inside an item of the list.
    assert.match(html, /<li><section aria-labelledby="todo-runners" class="todo">/)
    let one = (await setup(screen({ banner: null, workflowRepos: [], runners: [], runnerCounts: { online: 0, late: 1, offline: 0 } })).signIn(ALEX)).html
    assert.match(one, /1 runner gives no signal/)
  })

  it('says a limit of 0 is reached with no share and no bar, never "NaN%" (REV-91)', async () => {
    let { signIn } = setup(screen({ banner: null, workflowRepos: [], caps: { dailyCapUsd: 0, monthlyCapUsd: null, alertPct: 80 } }))
    let { html } = await signIn(ALEX)
    let todo = html.slice(html.indexOf('id="todo-title"'), html.indexOf('</ul>', html.indexOf('id="todo-title"')))
    assert.match(todo, /The daily cap is reached/)
    assert.match(todo, /\$4\.50 of \$0\.00<\/span>/)
    assert.doesNotMatch(todo, /NaN|Infinity/)
    assert.doesNotMatch(todo, /dash-gauge/)
  })

  it('says in the band that the limit of the month is reached, 0 included (REV-91)', async () => {
    for (let monthlyCapUsd of [0, 20]) {
      let { signIn } = setup(screen({ caps: { dailyCapUsd: null, monthlyCapUsd, alertPct: 80 } }))
      let { html } = await signIn(ALEX)
      let kpis = html.slice(html.indexOf('class="dash-kpis'), html.indexOf('</section>', html.indexOf('class="dash-kpis')))
      assert.match(kpis, new RegExp(`cap reached · of \\$${monthlyCapUsd}\\.00`))
      assert.doesNotMatch(kpis, /alert at 80/)
    }
    let { signIn } = setup(screen({ caps: { dailyCapUsd: null, monthlyCapUsd: 150, alertPct: 80 } }))
    assert.match((await signIn(ALEX)).html, /of \$150\.00 · alert at 80%/)
  })

  it('says that nothing is to do when nothing is', async () => {
    let { signIn } = setup(
      screen({ banner: null, workflowRepos: [], runners: [], caps: { dailyCapUsd: null, monthlyCapUsd: null, alertPct: 80 } }),
    )
    let { html } = await signIn(ALEX)
    assert.match(html, /To do <span class="count">0<\/span>/)
    assert.match(html, /Nothing to do/)
  })
})

describe('the dashboard', () => {
  it('shows the failure, the week, the last reviews, the cost, the queue and the runners to an admin', async () => {
    let { signIn, reads } = setup()
    let { html } = await signIn(ALEX)
    assert.deepEqual([...new Set(reads)], [ORG.id])
    assert.match(html, /The lite review of <span class="mono">sakuga-software\/orchard#128<\/span> failed/)
    assert.match(html, /the runner stopped answering during the job twice, last runners-host/)
    assert.match(html, /The previous review \(3\/5, published on/)
    assert.match(html, /href="https:\/\/github.com\/sakuga-software\/orchard\/pull\/128"/)
    assert.match(html, /action="\/jobs\/11111111-1111-4111-8111-111111111111\/retry"/)
    assert.match(html, /Run again at balanced/)
    assert.match(html, /unknown cost/)
    assert.match(html, /Published reviews · 7 days/)
    assert.match(html, /Changes requested/)
    assert.match(html, /2\/5/)
    assert.match(html, /Alert threshold reached/)
    assert.match(html, /2 reviews or resolutions of the month with no known/)
    assert.match(html, /On <span class="mono">mac-mini<\/span>/)
    assert.match(html, /attempt 2/)
    // REV-43: the queue says "held until" with a hint, never the "bail" of the runner protocol.
    assert.match(html, /<span title="Without a signal of the runner before this hour, the job goes back to the queue.">\s*held until <time/)
    assert.doesNotMatch(html, /\bbail\b/)
    assert.match(html, /href="\/runners"/)
    // REV-91: the last reviews link the screen of each pull request, and "Tous les findings".
    assert.match(html, /href="\/repos\/22222222-2222-4222-8222-222222222222\/pulls\/\d+"/)
    assert.match(html, /<a href="\/findings">All findings<\/a>/)
    assert.match(html, /No closed finding over 30 days\. The share of the findings that a push fixes shows here from 10/)
    assert.doesNotMatch(html.replace(/ d="[^"]*"/g, ''), /\bM[0-9]\b/, 'no milestone of the team on screen, the paths of the icons aside (REV-43)')
    assert.doesNotMatch(html, / — /, 'no em dash between two parts of a sentence (REV-43)')
    assert.match(html, /still on\s*<code>review.yml<\/code>/)
    assert.match(html, /src="\/assets\/dashboard.js\?v=1.2.3"/)
  })

  it('draws no precision bar without closed findings, never NaN (REV-91)', async () => {
    let { store } = fakeFindingsScreenStore({ report: { ...EMPTY_REPORT, org: { fixed: 0, dismissed: 0, closed: 0, rate: 0.5 } } })
    let { signIn } = setup(screen(), undefined, undefined, false, store)
    let { html } = await signIn()
    let kpis = html.slice(html.indexOf('class="dash-kpis'), html.indexOf('</section>', html.indexOf('class="dash-kpis')))
    assert.doesNotMatch(kpis, /NaN|Infinity/)
    assert.match(kpis, /Precision · 30 d<\/span><span class="kpi-value kpi-pending">—<\/span>/)
  })

  it('shows the precision of the org and of its repositories, or "n = 9 of 10" under 10 closed findings (REV-18)', async () => {
    let { store } = fakeFindingsScreenStore({
      report: {
        ...EMPTY_REPORT,
        org: precisionOf(41, 9),
        repos: [
          { id: '33333333-3333-4333-8333-333333333333', fullName: 'sakuga-software/orchard', ...precisionOf(37, 4) },
          { id: '44444444-4444-4444-8444-444444444444', fullName: 'sakuga-software/fruitback', ...precisionOf(4, 5) },
          // A name with no owner stays whole.
          { id: '55555555-5555-4555-8555-555555555555', fullName: 'loner', ...precisionOf(1, 0) },
        ],
        repoCount: 3,
      },
    })
    let { signIn } = setup(screen(), undefined, undefined, false, store)
    let { html } = await signIn()
    assert.match(html, /<span title="41 fixed · 9 dismissed" class="precision-value precision-large">82%/)
    assert.match(html, /href="\/findings\?status=closed&amp;repo=33333333-3333-4333-8333-333333333333"[^>]*>orchard<\/a><span class="precision-figures"><span title="37 fixed · 4 dismissed" class="precision-value">90%/)
    assert.match(html, />fruitback<\/a><span class="precision-figures"><span [^>]*class="precision-value precision-pending">n = 9 of 10/)
    assert.match(html, /title="loner" class="precision-name">loner<\/a>/)
    assert.doesNotMatch(html, /No closed finding over 30 days/)
  })

  it('shows the same dashboard to a member, without the retry buttons', async () => {
    let { signIn } = setup()
    let { html } = await signIn(CAMILLE)
    assert.match(html, /Read only/)
    assert.match(html, /the runner stopped answering during the job twice/)
    assert.doesNotMatch(html, /\/retry"/)
    assert.doesNotMatch(html, /Run again at/)
    assert.doesNotMatch(html, /\/dismiss"/)
  })

  it('says that a retry is under way, with no button, until its review is published', async () => {
    let { signIn } = setup(screen({ banner: banner({ retry: { id: 'j9', level: 'balanced', state: 'queued' } }) }))
    let { html } = await signIn(ALEX)
    assert.match(html, /Retry at balanced queued/)
    assert.doesNotMatch(html, /Run again at/)
  })

  it('lists the runners that work first, the offline ones after, with the counts of all and a link to the rest (REV-37)', async () => {
    let { signIn } = setup(
      screen({
        runners: [
          { id: 'run1', name: 'mac-mini', orgId: ORG.id, lastSeenAt: new Date(NOW.getTime() - 5_000), running: 1 },
          { id: 'run2', name: 'hetzner-cx22', orgId: ORG.id, lastSeenAt: new Date(NOW.getTime() - 3 * 86_400_000), running: 0 },
        ],
        runnerCounts: { online: 1, late: 0, offline: 23 },
      }),
    )
    let { html } = await signIn(ALEX)
    let section = html.slice(html.indexOf('id="dash-runners-title"'))
    assert.match(section, /<p class="runner-counts">1 online · 23 offline<\/p>/)
    assert.match(section, /<span class="status status-offline">Offline for 3 d<\/span>/)
    assert.ok(section.indexOf('mac-mini') < section.indexOf('hetzner-cx22'), 'the store order stays: the online runner first')
    assert.match(section, /<a href="\/runners">and 22 more<span class="visually-hidden"> on the Runners screen<\/span><\/a>/)
  })

  it('says that jobs wait with no runner online, since when, and what to do (REV-52)', async () => {
    let since = new Date(NOW.getTime() - 14 * 60_000)
    let lastSeen = new Date(NOW.getTime() - 2 * 3_600_000)
    let { signIn } = setup(screen({ runners: [], runnerCounts: { online: 0, late: 0, offline: 1 }, stall: { count: 2, since, lastRunnerSeenAt: lastSeen, serviceKeyJobs: 0, serviceRunnersOnline: 0 } }))
    let { html } = await signIn(ALEX)
    let section = html.slice(html.indexOf('id="todo-stall"'), html.indexOf('</li>', html.indexOf('id="todo-stall"')))
    assert.match(section, /2 jobs have waited in the queue for more than 10 min \(the oldest for 14 min\)/)
    assert.match(section, /No runner online for 2 h/)
    assert.match(section, /Start a runner, see the Runners screen/)
    assert.match(section, /<a href="\/runners" class="button">See the runners<\/a>/)
    assert.ok(html.indexOf('id="todo-stall"') < html.indexOf('id="todo-failure-'), 'the queue comes before the failure')
    assert.ok(html.indexOf('id="todo-stall"') < html.indexOf('id="dash-runners-title"'))
    // REV-91: each row of "To do" has its own id, once on the page, and names its region with it.
    let ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]!)
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'no id twice on the page')
    assert.match(html, /aria-labelledby="todo-stall"/)
    assert.match(html, /aria-labelledby="todo-failure-11111111-1111-4111-8111-111111111111"/)
    assert.match(html, /<h3 id="todo-failure-11111111-1111-4111-8111-111111111111" class="todo-title">/)

    assert.deepEqual(stallText({ count: 1, since, lastRunnerSeenAt: null, serviceKeyJobs: 0, serviceRunnersOnline: 0 }, 0, NOW).cause, 'No runner ever called Kentō.')
    let busy = stallText({ count: 1, since, lastRunnerSeenAt: NOW, serviceKeyJobs: 0, serviceRunnersOnline: 0 }, 2, NOW)
    assert.match(busy.title, /^1 job has waited in the queue/)
    assert.match(busy.cause, /^2 runners are online, but none takes these jobs/)
  })

  it('says that jobs with no provider wait for a runner with an OpenRouter key (REV-130)', async () => {
    let since = new Date(NOW.getTime() - 14 * 60_000)
    let all = stallText({ count: 2, since, lastRunnerSeenAt: NOW, serviceKeyJobs: 2, serviceRunnersOnline: 0 }, 1, NOW)
    assert.equal(
      all.cause,
      'These jobs have no provider: they wait for a runner with an OpenRouter key. The key of the service goes only to a runner of the service, never to a runner of your organization.',
    )
    assert.equal(all.action, 'Give your runner its own OpenRouter key (PROVIDER_KIND=openrouter and PROVIDER_API_KEY), or add a provider in Settings.')
    assert.match(stallText({ count: 3, since, lastRunnerSeenAt: NOW, serviceKeyJobs: 1, serviceRunnersOnline: 0 }, 1, NOW).cause, /^1 of these jobs has no provider: it waits for a runner with an OpenRouter key\./)
    // A trusted runner of the service is online: the jobs wait for it to be free, and no key is missing.
    let busy = stallText({ count: 2, since, lastRunnerSeenAt: NOW, serviceKeyJobs: 2, serviceRunnersOnline: 1 }, 2, NOW)
    assert.match(busy.cause, /^2 runners are online, but none takes these jobs/)
    assert.doesNotMatch(`${busy.cause} ${busy.action}`, /OpenRouter key/)
    // With no runner online, the cause stays the missing runner.
    assert.match(stallText({ count: 2, since, lastRunnerSeenAt: null, serviceKeyJobs: 2, serviceRunnersOnline: 0 }, 0, NOW).cause, /^No runner ever called Kentō/)

    let { signIn } = setup(screen({ runnerCounts: { online: 1, late: 0, offline: 0 }, stall: { count: 2, since, lastRunnerSeenAt: NOW, serviceKeyJobs: 2, serviceRunnersOnline: 0 } }))
    let { html } = await signIn(ALEX)
    let section = html.slice(html.indexOf('id="todo-stall"'), html.indexOf('</li>', html.indexOf('id="todo-stall"')))
    assert.match(section, /These jobs have no provider: they wait for a runner with an OpenRouter key\./)
    assert.match(section, /Give your runner its own OpenRouter key \(PROVIDER_KIND=openrouter and PROVIDER_API_KEY\), or add a provider in Settings\./)
  })

  it('has no banner of the queue while no job waits for too long', async () => {
    let { signIn } = setup()
    let { html } = await signIn(ALEX)
    assert.doesNotMatch(html, /todo-stall/)
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
    assert.doesNotMatch(html, /<\/span> failed/)
    assert.match(html, /No review yet/)
    assert.match(html, /No failure to handle over 7 days/)
    assert.match(html, /The organization has no cap/)
    assert.match(html, /No runner/)
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
    assert.match(html, /Review started again/)
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

  it('sends a bad id to "missing" without asking the store', async () => {
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

  it('logs a retry at level info, with the review level in its own field', async () => {
    let { signIn, request } = setup(screen(), { kind: 'queued', jobId: 'new' }, null)
    let { cookie, csrf } = await signIn(ALEX)
    let out = ''
    let write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      out += chunk
      return true
    }) as typeof process.stdout.write
    try {
      await request(`/jobs/${JOB_ID}/retry`, { cookie, form: { _csrf: csrf, level: 'heavy' } })
    } finally {
      process.stdout.write = write
    }
    let line = out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((l) => l.event === 'dashboard.retry')
    assert.equal(line?.level, 'info')
    assert.equal(line?.reviewLevel, 'heavy')
  })

  it('gives an admin "Hide" on the banner and on each failure of the list (REV-59)', async () => {
    let { signIn } = setup()
    let { html } = await signIn(ALEX)
    assert.match(html, new RegExp(`action="/jobs/${JOB_ID}/dismiss"`))
    assert.match(html, /aria-label="Hide the failure of sakuga-software\/orchard#128"/)
  })

  it('lets an admin hide a failure, with a CSRF token, and says that the week still counts it (REV-59)', async () => {
    let { signIn, request, dismissals } = setup()
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request(`/jobs/${JOB_ID}/dismiss`, { cookie, form: { _csrf: csrf } })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/?notice=dismissed')
    assert.deepEqual(dismissals, [`${ORG.id} ${JOB_ID} ${ALEX.login}`])
    let html = await (await request('/?notice=dismissed', { cookie })).text()
    assert.match(html, /Failure hidden\. It still counts in "Failures · 7 d"/)
  })

  it('refuses "Hide" from a member or without a CSRF token, and says when nothing was hidden (REV-59)', async () => {
    let { signIn, request, dismissals } = setup()
    let member = await signIn(CAMILLE)
    assert.equal((await request(`/jobs/${JOB_ID}/dismiss`, { cookie: member.cookie, form: { _csrf: member.csrf } })).status, 403)
    let admin = await signIn(ALEX)
    assert.notEqual((await request(`/jobs/${JOB_ID}/dismiss`, { cookie: admin.cookie, form: {} })).status, 303)
    assert.deepEqual(dismissals, [])
    let bad = await request('/jobs/not-a-uuid/dismiss', { cookie: admin.cookie, form: { _csrf: admin.csrf } })
    assert.equal(bad.headers.get('Location'), '/?notice=dismiss_missing')
    assert.deepEqual(dismissals, [])
    let other = await request(`/jobs/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/dismiss`, { cookie: admin.cookie, form: { _csrf: admin.csrf } })
    assert.equal(other.headers.get('Location'), '/?notice=dismiss_missing')
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
