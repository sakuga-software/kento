// REV-18. The routes of the Findings screen: the selection for an admin, "Mark dismissed" and
// "Mark wontfix", and the notice of their answer.
import { readFileSync } from 'node:fs'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, cookiesOf, fakeAuth, OCTOCAT, ORG, SESSION_COOKIE } from '../auth/test-helpers.ts'
import type { BulkStatus, StatusOutcome } from '../findings/dismiss.ts'
import type { FindingRow, FindingScreenPage } from '../findings/screen.ts'
import { EMPTY_PAGE, fakeFindingsScreenStore } from '../findings/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'

const COOKIE = SESSION_COOKIE
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

function finding(id: string, title: string): FindingRow {
  return {
    id, repoId: 'r', repo: 'sakuga-software/orchard', prNumber: 12, path: 'a.ts', line: 3, title, severity: 'major', category: 'bug',
    confidence: 80, status: 'open', statusReason: null, ruleId: null, ruleTitle: null, firstSeenSha: 'a'.repeat(40),
    lastSeenSha: 'a'.repeat(40), githubCommentId: 900_001, considered: false, createdAt: new Date('2026-10-29T10:00:00Z'), updatedAt: new Date('2026-10-29T10:00:00Z'),
  }
}

function setup(
  outcome: StatusOutcome = { changed: 2, unchanged: 0, fixed: 0, missing: 0, failed: 0, replied: 2, unreplied: 0 },
  empty = false,
  paging: Partial<FindingScreenPage> = {},
) {
  let auth = fakeAuth({ orgs: [ORG] })
  auth.setRole(ORG, OCTOCAT, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let rows = [finding(A, 'Key read with no expiry'), { ...finding(B, 'Error swallowed'), considered: true }, { ...finding(C, 'Already fixed'), status: 'fixed' as const }]
  let { store, lists } = fakeFindingsScreenStore({ page: empty ? EMPTY_PAGE : { ...EMPTY_PAGE, rows, counts: { ...EMPTY_PAGE.counts, open: 2, all: 2 }, matching: 2, ...paging } })
  let calls: { orgId: string; ids: string[]; status: BulkStatus; reason: string | null; actor: string }[] = []
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: auth.deps,
    findings: {
      store,
      githubUrl: 'https://github.com',
      async setStatus(input) {
        calls.push(input)
        return outcome
      },
    },
  })
  function request(path: string, init: { cookie?: string; form?: [string, string][] } = {}) {
    let headers = new Headers()
    if (init.cookie) headers.set('Cookie', init.cookie)
    let body = init.form ? new URLSearchParams(init.form) : undefined
    return router.fetch(new Request(new URL(path, 'http://localhost'), { method: init.form ? 'POST' : 'GET', headers, body }))
  }
  async function signIn(profile = OCTOCAT) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: cookiesOf(start) })
    let cookie = cookieOf(callback, COOKIE)!
    let html = await (await request('/findings?status=all&priority=major', { cookie })).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
    return { cookie, csrf, html }
  }
  return { request, signIn, calls, lists }
}

describe('the findings to consider (REV-102)', () => {
  it('tags a finding that its last review lists "To consider", and only that one', async () => {
    let { signIn } = setup()
    let { html } = await signIn()
    let tagged = [...html.matchAll(/<tr id="finding-([0-9a-f-]+)">[\s\S]*?<\/tr>/g)].filter((m) => m[0].includes('>To consider</span>')).map((m) => m[1])
    assert.deepEqual(tagged, [B])
    assert.match(html, /<span title="An earlier review already read this code\. This finding does not block the pull request\." class="tag tag-info">To consider<\/span>|<span class="tag tag-info" title="An earlier review already read this code\. This finding does not block the pull request\.">To consider<\/span>/)
  })

  it('filters them with "Type", in the URL, and keeps the filter through the tabs and "Clear the filters"', async () => {
    let { request, signIn, lists } = setup()
    let { cookie } = await signIn()
    let html = await (await request('/findings?type=to-consider', { cookie })).text()
    assert.equal(lists.at(-1)!.considered, true)
    assert.match(html, /<option value="to-consider" selected>\s*To consider \(code already reviewed\)\s*<\/option>/)
    assert.match(html, /href="\/findings\?status=all&amp;type=to-consider"/)
    assert.match(html, /<a href="\/findings" class="button button-ghost">Clear the filters/)
    // KNT-195: a value that the screen does not know goes away, with a redirect to the URL without it.
    let unknown = await request('/findings?type=autre', { cookie })
    assert.equal(unknown.status, 303)
    assert.equal(unknown.headers.get('Location'), '/findings')
  })
})

describe('the selects of the filters (KNT-165)', () => {
  it('render the native select, then a component that hydrates next to it with its id only: the options stay once in the page', async () => {
    let { signIn } = setup()
    let { html } = await signIn()
    for (let id of ['findings-repo', 'findings-priority', 'findings-rule', 'findings-type']) {
      assert.match(html, new RegExp(`<span class="select-box"><select [^>]*id="${id}"[^>]*>[\\s\\S]*?</select><!-- rmx:h:\\w+ --><!-- /rmx:h --></span>`), id)
    }
    let data = JSON.parse(html.match(/<script type="application\/json" id="rmx-data">(.*?)<\/script>/)![1]!) as {
      h: Record<string, { exportName: string; props: Record<string, unknown> }>
    }
    let selects = Object.values(data.h).filter((entry) => entry.exportName === 'CustomSelect')
    assert.deepEqual(selects.map((entry) => entry.props), ['findings-repo', 'findings-priority', 'findings-rule', 'findings-type'].map((target) => ({ target })))
    // The labels of the options are written once: in the native select, not in the data of the page.
    assert.doesNotMatch(html.match(/<script type="application\/json" id="rmx-data">.*?<\/script>/)![0], /P0 · critical|All repos/)
  })
})

describe('the Findings screen, its selection and its actions', () => {
  it('gives an admin a checkbox per finding, the dialog of the reasons and "Mark wontfix"; a member none of them', async () => {
    let { signIn } = setup()
    let admin = await signIn()
    assert.match(admin.html, new RegExp(`<input type="checkbox" name="ids" value="${A}" form="findings-bulk"`))
    assert.match(admin.html, /aria-label="Select &quot;Key read with no expiry&quot;"/)
    // A finding fixed by a push has no checkbox: a person does not set it aside.
    assert.doesNotMatch(admin.html, new RegExp(`value="${C}"`))
    assert.match(admin.html, /<summary class="button">Mark dismissed…<\/summary>/)
    assert.match(admin.html, /value="Off topic" form="findings-bulk"/)
    assert.match(admin.html, /name="status" value="wontfix"[^>]*>\s*Mark wontfix/)
    // The form comes back to the list on screen.
    assert.match(admin.html, /<input type="hidden" name="back" value="status=all&amp;priority=major" \/>/)
    let member = await signIn(CAMILLE)
    assert.doesNotMatch(member.html, /name="ids"/)
    assert.doesNotMatch(member.html, /Mark dismissed/)
  })

  it('shows the list under its tab, the statuses as a segmented control, and the precision under its own tab (REV-91)', async () => {
    let { request, signIn } = setup()
    let { cookie, html } = await signIn()
    assert.match(html, /<nav aria-label="Views of the findings" class="tabs"><a href="\/findings\?status=all&amp;priority=major" aria-current="page">List<\/a><a href="\/findings\?status=all&amp;priority=major&amp;view=precision">Precision<\/a><\/nav>/)
    assert.match(html, /Precision over 30 d: /)
    assert.match(html, /<nav aria-label="Status of the findings" class="segmented-links findings-views">/)
    assert.match(html, /for="findings-rule"[^>]*>\s*Source\s*<\/label>/)
    assert.match(html, /<option value=""[^>]*>\s*Review and rules\s*<\/option>/)
    // The org of the test has no rule: the list "Source" is disabled, as before REV-91.
    assert.match(html, /<select[^>]*id="findings-rule"[^>]*disabled|<select[^>]*disabled[^>]*id="findings-rule"/)
    assert.match(html, /class="button findings-submit" type="submit"|type="submit" class="button findings-submit"/)
    assert.doesNotMatch(html, /Precision · last 30 days/)
    let precision = await (await request('/findings?view=precision', { cookie })).text()
    assert.match(precision, /<a href="\/findings\?view=precision" aria-current="page">Precision<\/a>/)
    assert.doesNotMatch(precision, /name="ids"/)
    assert.doesNotMatch(precision, /findings-filters/)
    // List → Precision → List keeps the filters of the person.
    let back = await (await request('/findings?status=all&priority=major&view=precision', { cookie })).text()
    assert.match(back, /<a href="\/findings\?status=all&amp;priority=major">List<\/a>/)
  })

  it('keeps the tabs and the precision for an org with no finding yet (REV-91)', async () => {
    let { request, signIn } = setup(undefined, true)
    let { cookie } = await signIn()
    let html = await (await request('/findings', { cookie })).text()
    assert.match(html, /No finding yet/)
    assert.match(html, /<nav aria-label="Views of the findings" class="tabs">/)
    let precision = await (await request('/findings?view=precision', { cookie })).text()
    assert.match(precision, /<a href="\/findings\?view=precision" aria-current="page">Precision<\/a>/)
    assert.match(precision, /Precision · last 30 days/)
    assert.doesNotMatch(precision, /No finding yet/)
  })

  it('runs no list query on "Precision", which shows neither rows nor filters (REV-91)', async () => {
    let { request, signIn, lists } = setup()
    let { cookie } = await signIn()
    let before = lists.length
    let precision = await (await request('/findings?status=all&view=precision', { cookie })).text()
    assert.match(precision, /Precision · last 30 days/)
    assert.equal(lists.length, before)
  })

  it('shows the numbered pager with the filters and the search, 1,234 written with its comma (KNT-148)', async () => {
    let { request, signIn } = setup(undefined, false, { offset: 1225, matching: 1234, page: 50, pages: 50 })
    let { cookie } = await signIn()
    let html = await (await request('/findings?status=all&priority=major&page=50', { cookie })).text()
    assert.match(html, /<nav aria-label="Pages of the list" class="pager pager-numbered">/)
    assert.match(html, /1,226 to 1,228 of 1,234 findings/)
    assert.match(html, /href="\/findings\?status=all&amp;priority=major&amp;page=49" rel="prev"/)
    assert.match(html, /<a href="\/findings\?status=all&amp;priority=major&amp;page=50" aria-current="page" class="button button-small pager-page">/)
    // Page 1 drops `page` from the link; the last page has no "Next".
    assert.match(html, /<a href="\/findings\?status=all&amp;priority=major" class="button button-small pager-page"><span class="visually-hidden">Page <\/span>1<\/a>/)
    assert.doesNotMatch(html, /rel="next"/)
    // A tab or a filter starts again at page 1.
    assert.doesNotMatch(html, /href="\/findings\?status=open[^"]*page=/)
    html = await (await request('/findings?status=all&priority=major&page=50', { cookie })).text()
    assert.match(html, /<input type="hidden" name="back" value="status=all&amp;priority=major&amp;page=50" \/>/)
  })

  it('reads ?page=n, drops a page that is not one and the old cursors, and keeps the page in `back` (KNT-148)', async () => {
    let { request, signIn, lists } = setup()
    let { cookie } = await signIn()
    // KNT-195: the URL of the list has neither the page that is not one nor the cursors.
    let old = await request('/findings?status=all&page=abc&after=x&before=y', { cookie })
    assert.equal(old.headers.get('Location'), '/findings?status=all')
    let html = await (await request('/findings?status=all', { cookie })).text()
    assert.equal(lists.at(-1)!.page, 1)
    // The tabs, the statuses and the `back` of the actions are built from the list: no cursor in them.
    assert.doesNotMatch(html, /href="[^"]*(?:after|before|page)=/)
    assert.match(html, /<input type="hidden" name="back" value="status=all" \/>/)
    // The store shows page 3 of 3.
    let third = setup(undefined, false, { offset: 50, matching: 60, page: 3, pages: 3 })
    let signed = await third.signIn()
    html = await (await third.request('/findings?status=all&page=3', { cookie: signed.cookie })).text()
    assert.equal(third.lists.at(-1)!.page, 3)
    assert.match(html, /<input type="hidden" name="back" value="status=all&amp;page=3" \/>/)
    // KNT-195: a page after the last one goes to the URL of the page on screen, the notice kept.
    let past = await third.request('/findings?status=all&page=9&done=dismissed&n=2', { cookie: signed.cookie })
    assert.equal(past.status, 303)
    assert.equal(past.headers.get('Location'), '/findings?status=all&page=3&done=dismissed&n=2')
    assert.equal(third.lists.at(-1)!.page, 9, 'the store read the page asked for, and gave the last one')
    // Kentō #306b6a: only to a lower page of 1 or more. A store that answers page 0, or a higher page,
    // gets the page shown at its URL: no redirect, so no loop.
    for (let answered of [0, 7]) {
      let odd = setup(undefined, false, { page: answered, pages: 7 })
      let oddCookie = (await odd.signIn()).cookie
      assert.equal((await odd.request('/findings?status=all&page=3', { cookie: oddCookie })).status, 200, `page ${answered}`)
    }
  })

  it('reads ?per=n from 10 to 100, keeps it in every link of the list and the form, and passes it to the store (KNT-178)', async () => {
    let { request, signIn, lists } = setup(undefined, false, { offset: 40, matching: 200, page: 5, pages: 10 })
    let { cookie } = await signIn()
    let html = await (await request('/findings?status=all&priority=major&per=10&page=5', { cookie })).text()
    assert.equal(lists.at(-1)!.limit, 10)
    assert.equal(lists.at(-1)!.page, 5)
    assert.match(html, /href="\/findings\?status=all&amp;priority=major&amp;per=10&amp;page=4" rel="prev"/)
    assert.match(html, /href="\/findings\?status=all&amp;priority=major&amp;per=10&amp;page=6" rel="next"/)
    assert.match(html, /href="\/findings\?priority=major&amp;per=10"/, 'a status keeps the size, from page 1')
    assert.match(html, /href="\/findings\?status=all&amp;priority=major&amp;per=10&amp;view=precision"/, 'the tab keeps it')
    assert.match(html, /<a href="\/findings\?status=all&amp;per=10" class="button button-ghost">Clear the filters/, 'a size is not a filter')
    assert.match(html, /<input type="hidden" name="per" value="10" \/>/)
    assert.match(html, /<input type="hidden" name="back" value="status=all&amp;priority=major&amp;per=10&amp;page=5" \/>/)
    assert.match(html, /<table data-offset="40" data-after="view done n same fixed missing failed replied unreplied error" class="table findings-table">/)
    // Without `per`, the store takes its own size, 25, and no link writes it.
    html = await (await request('/findings?status=all&priority=major&page=5', { cookie })).text()
    assert.equal(lists.at(-1)!.limit, undefined)
    assert.doesNotMatch(html, /per=|name="per"/)
  })

  it('sends a URL with empty fields, a value it cannot read or a size out of bounds to the URL of the same list, notice kept (KNT-195)', async () => {
    let { request, signIn, lists } = setup()
    let { cookie } = await signIn()
    let before = lists.length
    let cases: [string, string][] = [
      ['/findings?q=&repo=&priority=&rule=&type=', '/findings'],
      ['/findings?status=all&q=+cache+&repo=&priority=major', '/findings?status=all&priority=major&q=cache'],
      ['/findings?per=5', '/findings?per=10'],
      ['/findings?per=500&page=2', '/findings?per=100&page=2'],
      ['/findings?per=100&page=2&page=3', '/findings?per=100&page=2'],
      ['/findings?per=abc&page=1', '/findings'],
      ['/findings?page=2&per=50', '/findings?per=50&page=2'],
      ['/findings?status=open', '/findings'],
      ['/findings?repo=not-an-id&other=1', '/findings'],
      ['/findings?q=&done=dismissed&n=2', '/findings?done=dismissed&n=2'],
      // The tab "Precision" has no page; a search cut at its length is trimmed once.
      ['/findings?view=precision&page=3', '/findings?view=precision'],
      [`/findings?q=${'x'.repeat(99)}+b`, `/findings?q=${'x'.repeat(99)}`],
      ['/findings?per=1000000', '/findings?per=100'],
    ]
    for (let [from, to] of cases) {
      let response = await request(from, { cookie })
      assert.equal(response.status, 303, from)
      assert.equal(response.headers.get('Location'), to, from)
    }
    assert.equal(lists.length, before, 'no list read before the redirect')
    for (let url of ['/findings', '/findings?per=25', '/findings?status=all&priority=major&q=cache&per=50&view=precision', '/findings?done=dismissed&n=2']) {
      assert.equal((await request(url, { cookie })).status, 200, url)
    }
  })

  it('loads findings.js once on the list, for an admin and a member, and not on "Precision" (REV-91)', async () => {
    let { request, signIn } = setup()
    let scripts = (html: string) => html.match(/\/assets\/findings\.js/g)?.length ?? 0
    let admin = await signIn()
    // "Filter" hides under `.js`: theme.js sets it, as a blocking script of the head, before the first paint.
    assert.match(admin.html, /<head>(?:(?!<\/head>).)*<script src="\/assets\/theme\.js\?v=[^"]*"><\/script>(?:(?!<\/head>).)*<\/head>/s)
    assert.match(readFileSync(new URL('../../public/assets/theme.js', import.meta.url), 'utf8'), /^ *document\.documentElement\.classList\.add\('js'\)$/m)
    assert.equal(scripts(admin.html), 1)
    assert.equal(scripts(await (await request('/findings?q=cle', { cookie: admin.cookie })).text()), 1)
    let member = await signIn(CAMILLE)
    assert.equal(scripts(member.html), 1)
    assert.equal(scripts(await (await request('/findings?view=precision', { cookie: admin.cookie })).text()), 0)
    // One tag, after the bar: not one inside the bar and one outside it.
    assert.match(admin.html, /data-select-none[^]*<\/div><script src="\/assets\/findings\.js/)
  })

  it('keeps a rule of the URL in the filters when the org has no rule left, and "Source" is disabled (REV-91)', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn()
    let html = await (await request(`/findings?rule=${A}`, { cookie })).text()
    assert.match(html, /<select[^>]*id="findings-rule"[^>]*disabled|<select[^>]*disabled[^>]*id="findings-rule"/)
    assert.match(html, new RegExp(`<input type="hidden" name="rule" value="${A}" />`))
    let plain = await (await request('/findings', { cookie })).text()
    assert.doesNotMatch(plain, /<input type="hidden" name="rule"/)
  })

  it('loads findings.js once on a list empty under its filters, for its filters to apply on change (REV-91)', async () => {
    let { request, signIn } = setup(undefined, true)
    let { cookie } = await signIn()
    let html = await (await request('/findings?q=rien', { cookie })).text()
    assert.match(html, /No open finding for these filters/)
    assert.equal(html.match(/\/assets\/findings\.js/g)?.length, 1)
  })

  it('marks the checked findings dismissed with the reason, by the login of the admin, and comes back to the list with the count', async () => {
    let { request, signIn, calls } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request('/findings/status', {
      cookie,
      form: [['_csrf', csrf], ['back', 'status=all&priority=major&evil=1&view=precision'], ['ids', A], ['ids', B], ['status', 'dismissed'], ['reason', 'Off topic']],
    })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/findings?status=all&priority=major&done=dismissed&n=2&replied=2')
    assert.deepEqual(calls, [{ orgId: ORG.id, ids: [A, B], status: 'dismissed', reason: 'Off topic', actor: 'octocat' }])

    let html = await (await request(response.headers.get('Location')!, { cookie })).text()
    assert.match(html, /2 findings marked dismissed\.<\/strong> 2 replies posted in the GitHub threads\./)
  })

  it('says when GitHub did not take a reply, and changes nothing without a reason', async () => {
    let { request, signIn, calls } = setup({ changed: 1, unchanged: 1, fixed: 1, missing: 0, failed: 1, replied: 0, unreplied: 1 })
    let { cookie, csrf } = await signIn()
    let refused = await request('/findings/status', { cookie, form: [['_csrf', csrf], ['ids', A], ['status', 'dismissed']] })
    assert.equal(refused.headers.get('Location'), '/findings?error=reason')
    assert.equal(calls.length, 0)
    assert.match(await (await request('/findings?error=reason', { cookie })).text(), /Nothing changed\.<\/strong> Choose a reason/)

    let done = await request('/findings/status', { cookie, form: [['_csrf', csrf], ['ids', A], ['ids', B], ['status', 'wontfix']] })
    let html = await (await request(done.headers.get('Location')!, { cookie })).text()
    assert.match(html, /role="status" class="banner banner-alert"/)
    assert.match(html, /1 thread got no reply/)
    assert.match(html, /1 already had this status and this reason/)
    assert.match(html, /1 fixed finding stays as is: a later review did not find it again after a push changed its file\./)
    assert.match(html, /Kentō could not save 1 finding\. Try again/)
  })

  it('says how many findings of the batch no longer exist (REV-58)', async () => {
    let { request, signIn } = setup({ changed: 2, unchanged: 0, fixed: 0, missing: 1, failed: 0, replied: 2, unreplied: 0 })
    let { cookie, csrf } = await signIn()
    let done = await request('/findings/status', {
      cookie,
      form: [['_csrf', csrf], ['ids', A], ['ids', B], ['ids', C], ['status', 'dismissed'], ['reason', 'False positive']],
    })
    assert.equal(done.headers.get('Location'), '/findings?done=dismissed&n=2&missing=1&replied=2')
    let html = await (await request(done.headers.get('Location')!, { cookie })).text()
    assert.match(html, /role="status" class="banner banner-alert"/)
    assert.match(html, /2 findings marked dismissed\.<\/strong>/)
    assert.match(await (await request('/findings?done=wontfix&n=0&missing=2', { cookie })).text(), /2 findings no longer exist in this organization/)
    assert.match(html, /1 finding no longer exists in this organization, for example because someone removed the repo after the page loaded\. The list below is up to date\./)
  })

  it('refuses the form to a member, and to a post without the CSRF token', async () => {
    let { request, signIn, calls } = setup()
    let member = await signIn(CAMILLE)
    let refused = await request('/findings/status', { cookie: member.cookie, form: [['_csrf', member.csrf], ['ids', A], ['status', 'wontfix']] })
    assert.equal(refused.status, 403)
    let admin = await signIn()
    let forged = await request('/findings/status', { cookie: admin.cookie, form: [['ids', A], ['status', 'wontfix']] })
    assert.notEqual(forged.status, 303)
    assert.equal(calls.length, 0)
  })
})
