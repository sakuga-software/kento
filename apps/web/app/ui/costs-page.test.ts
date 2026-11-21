// KNT-188. The Costs screen: a member of the org only, the org of the session only, the period in
// the URL (KNT-195), and every number in the HTML of the server.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, cookiesOf, fakeAuth, OCTOCAT, ORG, OTHER_ORG, SESSION_COOKIE, STRANGER } from '../auth/test-helpers.ts'
import type { CostPeriod } from '../costs/period.ts'
import type { CostReport, CostsStore } from '../costs/store.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import { change, dayLabel, utcWhen } from './costs.tsx'

const NOW = new Date('2026-11-21T10:00:00Z')

/** A report whose repository carries the id of the org it was read for. */
function reportOf(orgId: string, period: CostPeriod, empty = false): CostReport {
  return {
    period,
    now: NOW,
    start: new Date('2026-11-01T00:00:00Z'),
    end: new Date('2026-11-22T00:00:00Z'),
    days: [
      { day: '2026-11-20', usd: 1.25, previousUsd: 0.5 },
      { day: '2026-11-21', usd: 0.004, previousUsd: null },
    ],
    totalUsd: empty ? 0 : 1.254,
    previousTotalUsd: 0.5,
    count: empty ? 0 : 3,
    unknown: empty ? 0 : 1,
    byRepo: [{ key: 'repo-1', label: `${orgId}/app`, usd: 1.254, count: 3 }],
    byLevel: [{ key: 'heavy', label: 'heavy', usd: 1.254, count: 3 }],
    byModel: [{ key: 'model-large', label: 'model-large', usd: 1.254, count: 3 }],
    top: [
      { id: 'r1', kind: 'review', repoId: 'repo-1', repo: `${orgId}/app`, prNumber: 7, level: 'heavy', model: 'model-large', usd: 1.25, createdAt: NOW },
    ],
    caps: { dailyCapUsd: null, monthlyCapUsd: 10, alertPct: 80 },
    projectionUsd: period === 'month' ? 1.79 : null,
  }
}

function setup(options: { empty?: boolean; charts?: boolean } = {}) {
  let auth = fakeAuth({ orgs: [ORG, OTHER_ORG] })
  auth.setRole(ORG, OCTOCAT, 'member')
  auth.setRole(ORG, CAMILLE, 'admin')
  auth.setRole(OTHER_ORG, CAMILLE, 'admin')
  let reads: string[] = []
  let store: CostsStore = {
    async report(orgId, period) {
      reads.push(`${orgId} ${period}`)
      return reportOf(orgId, period, options.empty)
    },
  }
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: auth.deps,
    costs: { store, charts: options.charts },
  })
  function request(path: string, cookie?: string | null) {
    let headers = new Headers({ Accept: 'text/html' })
    if (cookie) headers.set('Cookie', cookie)
    return router.fetch(new Request(new URL(path, 'http://localhost'), { headers }))
  }
  async function signIn(profile = OCTOCAT) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, cookiesOf(start))
    return cookieOf(callback, SESSION_COOKIE)
  }
  return { auth, request, signIn, reads }
}

describe('the Costs screen (KNT-188)', () => {
  it('sends a request without a session to the sign-in, and reads nothing', async () => {
    let { request, signIn, reads } = setup()
    let anonymous = await request('/costs')
    assert.match(anonymous.headers.get('Location') ?? '', /^\/login/)
    let stranger = await signIn(STRANGER)
    let refused = await request('/costs', stranger)
    assert.notEqual(refused.status, 200)
    assert.deepEqual(reads, [])
  })

  it('reads the org of the membership, never the one that a session or a query names', async () => {
    let { auth, request, signIn, reads } = setup()
    let cookie = await signIn(OCTOCAT)
    // octocat is a member of sakuga-software only; the session and the query name the other org.
    for (let session of auth.tables.sessions!) session.activeOrganizationId = OTHER_ORG.id
    let response = await request(`/costs?period=30d&org=${OTHER_ORG.id}`, cookie)
    assert.equal(response.status, 200)
    let html = await response.text()
    assert.deepEqual(reads, [`${ORG.id} 30d`])
    assert.match(html, /org-1\/app/)
    assert.doesNotMatch(html, /org-2/)
  })

  it('reads the period of the query, and sends the default and an unknown one to /costs (KNT-195)', async () => {
    let { request, signIn, reads } = setup()
    let cookie = await signIn(OCTOCAT)
    for (let asked of ['month', 'year', '']) {
      let response = await request(`/costs?period=${asked}`, cookie)
      assert.equal(response.status, 303, asked)
      assert.equal(response.headers.get('Location'), '/costs')
    }
    assert.equal((await request('/costs', cookie)).status, 200)
    assert.equal((await request('/costs?period=last-month', cookie)).status, 200)
    assert.deepEqual(reads, [`${ORG.id} month`, `${ORG.id} last-month`])
  })

  it('renders every number in tables, with the charts empty and hidden until the browser draws them', async () => {
    let { request, signIn } = setup()
    let cookie = await signIn(OCTOCAT)
    let html = await (await request('/costs', cookie)).text()
    // The period links: the default has no query, the current one is marked.
    assert.match(html, /<a href="\/costs" aria-current="page">This month<\/a>/)
    assert.match(html, /<a href="\/costs\?period=90d">90 days<\/a>/)
    // The summary: total, the period before, the projection and the cap.
    assert.match(html, /\$1\.25/)
    assert.match(html, /\$0\.50 last month, same days · \+151%/)
    assert.match(html, /Projection of the month/)
    assert.match(html, /13% used · alert at 80%/)
    assert.match(html, /1 review or resolution with no known cost/)
    // The days, with the raw values that the chart reads; a day with no day before has an empty value.
    assert.match(html, /<tr data-label="20 Nov"><th scope="row"><time datetime="2026-11-20">20 Nov<\/time><\/th><td data-value="1.25" class="num">\$1\.25<\/td><td data-value="0.5" class="num">\$0\.50<\/td><\/tr>/)
    assert.match(html, /<td data-value="" class="num">–<\/td>/)
    // Open details: without JavaScript the tables show. The chart boxes are hidden.
    // The attributes in any order (Kentō #34df04).
    assert.equal(html.match(/<details(?=[^>]*\sopen[\s>])(?=[^>]*\sclass="chart-data")[^>]*>/g)?.length, 4)
    assert.equal(html.match(/<div(?=[^>]*\sdata-kind="(days|bars)")(?=[^>]*\shidden[\s>])(?=[^>]*\sclass="chart-box")[^>]*>/g)?.length, 4)
    // The repo links to its config; the chart names it after the org.
    assert.match(html, /<tr data-label="app"><th scope="row"><a href="\/repos\/repo-1\/config">org-1\/app<\/a><\/th>/)
    // The most expensive run links to the screen of its pull request.
    assert.match(html, /<a href="\/repos\/repo-1\/pulls\/7">org-1\/app#7<\/a>/)
    // The navigation names the screen.
    assert.match(html, /href="\/costs"[^>]*aria-current="page"[^>]*>Costs</)
  })

  it('renders the tables alone when the asset server cannot serve the charts (Fable P2-2)', async () => {
    let { request, signIn } = setup({ charts: false })
    let cookie = await signIn(OCTOCAT)
    let response = await request('/costs', cookie)
    assert.equal(response.status, 200)
    let html = await response.text()
    assert.doesNotMatch(html, /chart-box|cost-chart|importmap/)
    assert.match(html, /<table[^>]*id="cost-days-table"/)
    assert.match(html, /\$1\.25/)
    assert.equal(html.match(/<details(?=[^>]*\sopen[\s>])[^>]*>/g)?.length, 4)
  })

  it('names each "Show the data" after its chart, and writes the days and the times in UTC (Fable P3)', async () => {
    let { request, signIn } = setup()
    let cookie = await signIn(OCTOCAT)
    let html = await (await request('/costs', cookie)).text()
    for (let name of ['cost per day', 'cost by repo', 'cost by level', 'cost by model']) {
      assert.match(html, new RegExp(`Show the data<span class="visually-hidden">: ${name}</span>`), name)
    }
    assert.match(html, /This month \(UTC\)/)
    assert.match(html, /When \(UTC\)/)
    assert.match(html, /21 Nov, 10:00 UTC/)
    // 00:30 in Paris on the 1st is still the 31st in UTC: the row says the day of its bucket.
    assert.equal(utcWhen(new Date('2026-10-31T23:30:00Z')), '31 Oct, 23:30 UTC')
  })

  it('says that nothing cost anything, with no chart, when the period is empty', async () => {
    let { request, signIn } = setup({ empty: true })
    let cookie = await signIn(OCTOCAT)
    let html = await (await request('/costs?period=90d', cookie)).text()
    assert.match(html, /No cost over 90 days/)
    assert.doesNotMatch(html, /chart-box/)
  })

  it('formats a day of the costs, and the change from the period before', () => {
    assert.equal(dayLabel('2026-11-05'), '5 Nov')
    assert.equal(dayLabel('2026-01-31'), '31 Jan')
    assert.equal(change(15, 10), '+50%')
    assert.equal(change(5, 10), '−50%')
    assert.equal(change(10, 10), 'same')
    assert.equal(change(10, 0), null)
  })
})
