import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, OCTOCAT, ORG, OTHER_ORG } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import type { RepoCheck } from '../repos/check.ts'
import type { RepoListQuery, RepoPage, RepoView, ReposStore } from '../repos/store.ts'
import { precisionOf } from '../findings/precision.ts'
import type { FindingsScreenStore } from '../findings/screen.ts'
import { fakeFindingsScreenStore } from '../findings/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import { withInstance } from '../../test/instance.ts'

const COOKIE = '__Host-kento_session'
const ORCHARD = '00000000-0000-4000-8000-000000000001'
const FRUITBACK = '00000000-0000-4000-8000-000000000002'
const ELSEWHERE = '00000000-0000-4000-8000-000000000009'

function row(fields: Partial<RepoView> & Pick<RepoView, 'id' | 'fullName'>): RepoView {
  return {
    githubRepoId: 1,
    enabled: false,
    defaultLevel: 'lite',
    private: true,
    defaultBranch: 'main',
    workflow: 'none',
    workflowPath: null,
    workflowRef: null,
    workflowCheckedAt: new Date('2026-10-28T11:58:00Z'),
    streak: 0,
    resetBy: null, resetPr: null,
    lastReview: null,
    ...fields,
  }
}

/** The screens with the fake sign-in, and a store of repositories in memory, per org. */
function setup(findings: FindingsScreenStore | null = null, orgs = [ORG, OTHER_ORG]) {
  let auth = fakeAuth({ orgs })
  auth.setRole(ORG, OCTOCAT, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let rows: Record<string, RepoView[]> = {
    [ORG.id]: [
      row({
        id: ORCHARD, fullName: 'sakuga-software/orchard', workflow: 'reusable', workflowRef: 'stable',
        workflowPath: '.github/workflows/sakuga-review.yml',
      }),
      row({
        id: FRUITBACK, fullName: 'sakuga-software/fruitback', private: false, enabled: true, workflow: 'copy',
        workflowPath: '.github/workflows/sakuga-review.yml', streak: 3, resetBy: 'failure', resetPr: 12,
        lastReview: { prNumber: 677, score: 4, model: 'anthropic/claude-haiku-5.5', publishedAt: new Date('2026-10-28T11:00:00Z') },
      }),
    ],
    [OTHER_ORG.id]: [row({ id: ELSEWHERE, fullName: 'orchard/app', enabled: true })],
  }
  let changes: string[] = []
  let lists: RepoListQuery[] = []
  let pages: Partial<RepoPage> = {}
  let store: ReposStore = {
    async list(orgId, query = {}) {
      lists.push(query)
      let all = rows[orgId] ?? []
      let shown = all
        .filter((r) => query.filter !== 'enabled' || r.enabled)
        .filter((r) => !query.search || r.fullName.includes(query.search))
      return {
        rows: shown,
        counts: {
          all: all.length,
          enabled: all.filter((r) => r.enabled).length,
          disabled: all.filter((r) => !r.enabled).length,
          switching: all.filter((r) => r.workflow === 'reusable' || r.workflow === 'copy').length,
        },
        matching: shown.length,
        offset: 0,
        page: 1,
        pages: 1,
        checkedAt: all[0]?.workflowCheckedAt ?? null,
        unchecked: false,
        ...pages,
      }
    },
    async fullName(orgId, repoId) {
      return rows[orgId]?.find((r) => r.id === repoId)?.fullName ?? null
    },
    async setEnabled(orgId, repoId, enabled) {
      let repo = rows[orgId]?.find((r) => r.id === repoId)
      if (!repo) return null
      changes.push(`${repo.fullName}:${enabled}`)
      repo.enabled = enabled
      return { fullName: repo.fullName, cancelled: enabled ? 0 : 2 }
    },
    async saveCheck() {},
  }
  let checks: string[] = []
  let checking = { now: false }
  let check: RepoCheck = {
    async run(org) {
      checks.push(org.name)
      return { repos: 2, failed: 0 }
    },
    refreshIfStale: () => checking.now,
  }
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: auth.deps,
    repos: { store, check, githubUrl: 'https://github.com' },
    findings: findings ? { store: findings, githubUrl: 'https://github.com' } : null,
  })

  function request(path: string, init: { cookie?: string | null; headers?: Record<string, string>; form?: Record<string, string> } = {}) {
    let headers = new Headers(init.headers)
    if (init.cookie) headers.set('Cookie', init.cookie)
    return router.fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: init.form ? 'POST' : 'GET',
        headers,
        body: init.form ? new URLSearchParams(init.form) : undefined,
      }),
    )
  }

  async function signIn(profile = OCTOCAT) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: cookieOf(start, COOKIE) })
    let cookie = cookieOf(callback, COOKIE)!
    let html = await (await request('/repos', { cookie })).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
    return { cookie, csrf, html }
  }

  return { request, signIn, rows, changes, checks, checking, lists, pages }
}

describe('the Repos screen', () => {
  it('names the commands of the instance in the note on the switch (REV-127)', async () => {
    let fallback = async () => /<h2 id="fallback-title">.*?<\/ul>/s.exec((await setup().signIn()).html)![0]
    let own = await withInstance({ commandNames: ['acme-review'] }, fallback)
    assert.match(own, /<li><code>@acme-review<\/code> speaks to Kentō only\.<\/li>/)
    assert.doesNotMatch(own, /two answers|kento-review/)
    let shared = await withInstance({ commandNames: ['acme-review', 'sakuga-review'] }, fallback)
    assert.match(shared, /<li>A <code>@sakuga-review<\/code> command then gets two answers\. <code>@acme-review<\/code> speaks to Kentō only\.<\/li>/)
  })

  it('shows the precision of each repository of the page over 30 days, linked to its closed findings (REV-18)', async () => {
    let { store } = fakeFindingsScreenStore({ precisions: { [FRUITBACK]: precisionOf(12, 3), [ORCHARD]: precisionOf(2, 1) } })
    let { html } = await setup(store).signIn()
    assert.match(html, new RegExp(`href="/findings\\?status=closed&amp;repo=${FRUITBACK}"><span title="12 fixed · 3 dismissed" class="precision-value">80%`))
    assert.match(html, new RegExp(`href="/findings\\?status=closed&amp;repo=${ORCHARD}"><span [^>]*class="precision-value precision-pending">n = 3 of 10`))
  })

  it('shows each repository with its mode, level, model, switch counter and last review', async () => {
    let { signIn } = setup()
    let { html } = await signIn()
    assert.match(html, /<h1 class="page-title">Repos<\/h1>/)
    assert.match(html, /review\.yml@stable/)
    // REV-91: "Reviews by" in the four words of the design, with the detail under it.
    assert.match(html, /Kentō \+ review\.yml/)
    // KNT-146: the badge starts with its decorative icon.
    assert.match(html, /<span class="tag"><svg[^>]*aria-hidden="true"[^>]*>(?:(?!<\/svg>).)*<\/svg>review\.yml<\/span>/)
    assert.match(html, /3\/20/)
    assert.match(html, /set back to zero after a failure/)
    assert.match(html, /claude-haiku-5\.5/)
    assert.match(html, new RegExp(`href="/repos/${FRUITBACK}/pulls/677"`))
    assert.match(html, /#677 · 4\/5/)
    assert.match(html, /Precision 30 d/)
    // REV-25: the name can be cut short on screen; its title keeps it whole.
    assert.match(html, /<a href="https:\/\/github\.com\/sakuga-software\/orchard" rel="noreferrer" title="sakuga-software\/orchard" class="repo-name"><svg[^>]*aria-hidden="true"[^>]*>(?:(?!<\/svg>).)*<\/svg><span>orchard<\/span><\/a>/)
    // KNT-146: the visibility with its icon.
    assert.match(html, /<span class="hint repo-visibility"><svg[^>]*aria-hidden="true"[^>]*>(?:(?!<\/svg>).)*<\/svg>private<\/span>/)
    assert.match(html, /Switch criterion/)
    assert.match(html, /Fallback during the switch/)
    assert.match(html, /<li>A <code>@sakuga-review<\/code> command then gets two answers\. <code>@kento-review<\/code> speaks to Kentō only\.<\/li>/)
    // "Manage the installation" leads to the page of the App on GitHub.
    assert.match(html, /href="https:\/\/github\.com\/organizations\/sakuga-software\/settings\/installations\/11"/)
    // The repositories of another org of the person are not on screen.
    assert.doesNotMatch(html, /orchard\/app/)
  })

  it('KNT-150: an org of two installations links the page of each one on GitHub', async () => {
    let labs = { id: 'installation-3', githubInstallationId: 13, githubAccountId: 902, login: 'acme-labs' }
    let { signIn } = setup(null, [{ ...ORG, installations: [...ORG.installations, labs] }, OTHER_ORG])
    let html = (await signIn(OCTOCAT)).html
    assert.match(html, /href="https:\/\/github\.com\/organizations\/sakuga-software\/settings\/installations\/11"[^>]*>(?:<svg.*?<\/svg>)?Manage sakuga-software on GitHub/)
    assert.match(html, /href="https:\/\/github\.com\/organizations\/acme-labs\/settings\/installations\/13"[^>]*>(?:<svg.*?<\/svg>)?Manage acme-labs on GitHub/)
  })

  it('gives an admin "Enable", "Disable" and "Read GitHub again", and a member none of them', async () => {
    let { signIn } = setup()
    let admin = (await signIn(OCTOCAT)).html
    assert.match(admin, new RegExp(`action="/repos/${ORCHARD}/enable"`))
    assert.match(admin, new RegExp(`action="/repos/${FRUITBACK}/disable"`))
    assert.match(admin, /action="\/repos\/check"/)
    // KNT-147: the script that changes a row in place, after confirm.js, for an admin only.
    assert.equal(admin.match(/src="\/assets\/repo-toggle\.js\?v=1\.2\.3"/g)?.length, 1)
    assert.ok(admin.indexOf('/assets/confirm.js') < admin.indexOf('/assets/repo-toggle.js'))

    let member = (await signIn(CAMILLE)).html
    assert.match(member, /Read only<\/strong>/)
    assert.doesNotMatch(member, /\/enable"|\/disable"|data-confirm|action="\/repos\/check"|Manage the installation|repo-toggle\.js|notice-slot/)
    // KNT-147: an admin gets the live region of the notices on every load, empty with no notice.
    assert.match(admin, /<div role="status" class="notice-slot"><\/div>/)
  })

  it('enables a repository for an admin, with CSRF, and says what the next push does', async () => {
    let { request, signIn, changes } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request(`/repos/${ORCHARD}/enable`, { cookie, form: { _csrf: csrf } })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), `/repos?done=enabled&repo=${ORCHARD}#repo-${ORCHARD}`)
    assert.deepEqual(changes, ['sakuga-software/orchard:true'])
    let html = await (await request(response.headers.get('Location')!, { cookie })).text()
    assert.match(html, /orchard is enabled\.<\/strong> The next push of a PR creates a Kentō job\./)
  })

  it('asks to confirm a disable in its row, then disables and says that the published reviews stay', async () => {
    let { request, signIn, changes } = setup()
    let { cookie, csrf, html: page } = await signIn()
    // REV-33: the confirmation is in the row of the repository, closed, with the destructive style and "Cancel".
    let row = page.slice(page.indexOf(`id="repo-${FRUITBACK}"`), page.indexOf('</tr>', page.indexOf(`id="repo-${FRUITBACK}"`)))
    // REV-91: "Disable Kentō…" sits in the menu "…" of its row. KNT-163: without JavaScript, a
    // `<details>`; the menu hydrates it (RowMenu), and draws a menu button and a popover in its place.
    assert.match(row, /<!-- rmx:h:\w+ --><details class="row-menu"><summary aria-label="Actions of fruitback">…<\/summary>/)
    // No icon in it: the menu draws them once it hydrates (25 rows, the budget of the page).
    assert.doesNotMatch(row.slice(row.indexOf('<details class="row-menu">')), /<svg/)
    assert.match(row, /<details class="confirm"><summary class="button button-danger"><span>Disable<span class="visually-hidden"> fruitback<\/span> Kentō…<\/span><\/summary>/)
    // REV-36: the button posts the one form of the list, which carries the token.
    assert.match(row, new RegExp(`<button type="submit" form="repo-actions" formaction="/repos/${FRUITBACK}/disable" class="button button-danger-solid">Disable fruitback</button>`))
    assert.match(page, new RegExp(`<form id="repo-actions" method="post" hidden><input type="hidden" name="_csrf" value="${csrf}" /></form>`))
    // "Cancel" is a part of the popover only: without JavaScript, the trigger closes the confirmation.
    assert.doesNotMatch(row, /Cancel/)
    assert.match(row, /The published reviews and the counter stay/)
    // No destructive button has the style of the main action.
    assert.doesNotMatch(page, /button-primary[^>]*>\s*Disable/)
    assert.deepEqual(changes, [], 'the confirmation changes nothing')

    let response = await request(`/repos/${FRUITBACK}/disable`, { cookie, form: { _csrf: csrf } })
    assert.equal(response.status, 303)
    assert.deepEqual(changes, ['sakuga-software/fruitback:false'])
    let html = await (await request(response.headers.get('Location')!, { cookie })).text()
    assert.match(html, /fruitback is disabled\.<\/strong> No new job starts \(2 queued jobs cancelled\)/)
    assert.match(html, /The published reviews stay/)
  })

  it('refuses a change from a member (403), without CSRF, from another site, or on a repository of another org', async () => {
    let { request, signIn, changes } = setup()
    let member = await signIn(CAMILLE)
    assert.equal((await request(`/repos/${ORCHARD}/enable`, { cookie: member.cookie, form: { _csrf: member.csrf } })).status, 403)
    assert.equal((await request('/repos/check', { cookie: member.cookie, form: { _csrf: member.csrf } })).status, 403)
    // A member gets no confirmation either.
    assert.doesNotMatch(await (await request('/repos', { cookie: member.cookie })).text(), /data-confirm|\/disable"/)

    let admin = await signIn(OCTOCAT)
    assert.equal((await request(`/repos/${ORCHARD}/enable`, { cookie: admin.cookie, form: {} })).status, 403)
    assert.equal(
      (await request(`/repos/${ORCHARD}/enable`, { cookie: admin.cookie, headers: { 'Sec-Fetch-Site': 'cross-site' }, form: { _csrf: admin.csrf } })).status,
      403,
    )
    assert.equal((await request(`/repos/${ELSEWHERE}/disable`, { cookie: admin.cookie, form: { _csrf: admin.csrf } })).status, 404)
    assert.equal((await request('/repos/not-a-uuid/disable', { cookie: admin.cookie, form: { _csrf: admin.csrf } })).status, 404)
    assert.deepEqual(changes, [])
  })

  it('shows "Remove review.yml" to an admin at 20/20 with the workflow still there, and "switched" without it', async () => {
    let { signIn, rows } = setup()
    rows[ORG.id]![1]!.streak = 23
    rows[ORG.id]![1]!.resetBy = 'failure'
    let { html } = await signIn()
    assert.match(html, /20\/20/)
    assert.doesNotMatch(html, /set back to zero/)
    assert.match(html, /href="https:\/\/github\.com\/sakuga-software\/fruitback\/delete\/main\/\.github\/workflows\/sakuga-review\.yml"/)
    assert.match((await signIn(CAMILLE)).html, /ready to remove review\.yml/)

    rows[ORG.id]![1]!.workflow = 'none'
    assert.match((await signIn()).html, /switched/)
  })

  it('reads the screen again by itself while GitHub is being checked, and not after (REV-26)', async () => {
    let { request, signIn, checking } = setup()
    let { cookie, html } = await signIn()
    assert.doesNotMatch(html, /data-recheck/)
    assert.doesNotMatch(html, /assets\/repos.js/)
    // KNT-163: the menus "…" hydrate, with the props of each row in the data of the page.
    let data = JSON.parse(html.match(/<script type="application\/json" id="rmx-data">(.*?)<\/script>/)![1]!) as {
      h: Record<string, { exportName: string; moduleUrl: string; props: Record<string, unknown> }>
    }
    let menus = Object.values(data.h).filter((entry) => entry.exportName === 'RowMenu')
    assert.equal(menus.length, (html.match(/<details class="row-menu">/g) ?? []).length)
    assert.match(menus[0]!.moduleUrl, /^\/assets\/app\/ui\/public\/row-menu\.tsx$/)
    // A few props a row: its id and name, and `disable` only where it applies.
    assert.deepEqual(menus.map((entry) => Object.keys(entry.props).sort().join()), ['id,name', 'disable,id,name'])
    assert.match(html, /<script type="module" src="\/assets\/app\/ui\/public\/boot\.ts" data-runtime="[^"]+"><\/script>/)
    // The one inline script that runs, the import map, carries the nonce of the policy of the response.
    let response = await request('/repos', { cookie })
    let nonce = response.headers.get('Content-Security-Policy')?.match(/'nonce-([^']+)'/)?.[1]
    let page = await response.text()
    // The import map comes before the module of the page (Fable critique P3-4).
    assert.ok(page.indexOf('type="importmap"') < page.indexOf('<script type="module"'))
    let inline = [...page.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((match) => match[1]!)
    assert.deepEqual(inline.map((attrs) => attrs.match(/type="([^"]+)"/)?.[1]).sort(), ['application/json', 'importmap'])
    assert.ok(nonce)
    assert.ok(inline.find((attrs) => attrs.includes('importmap'))!.includes(`nonce="${nonce}"`))
    assert.match(html, /<button type="submit" class="button list-search-submit">Search<\/button>/)
    checking.now = true
    html = await (await request('/repos', { cookie })).text()
    assert.match(html, /<span data-recheck="">check in progress on GitHub · <a href="\/repos">Reload<\/a><\/span>/)
    assert.match(html, /src="\/assets\/repos.js\?v=1.2.3"/)
    assert.doesNotMatch(html, /reload in a moment/)
  })

  it('says in a note, not an alert, that a failed job set the counter back to zero, with a link to its PR', async () => {
    let { signIn } = setup()
    let { html } = await signIn()
    assert.match(html, /<span class="hint">set back to zero after a failure on <a href="https:\/\/github\.com\/sakuga-software\/fruitback\/pull\/12" rel="noreferrer">#12<\/a><\/span>/)
    assert.doesNotMatch(html, /hint-alert/)
  })

  it('searches the name and filters the list, with the counts of the org, and keeps both in the links (REV-36)', async () => {
    let { request, signIn, lists } = setup()
    let { cookie, html } = await signIn()
    assert.match(html, /<form method="get" action="\/repos" role="search" class="list-search">/)
    assert.match(html, /<a href="\/repos" aria-current="page">All<span class="list-filter-count">2<\/span><\/a>/)
    assert.match(html, /<a href="\/repos\?filter=enabled">Enabled<span class="list-filter-count">1<\/span><\/a>/)
    assert.match(html, /Not enabled<span class="list-filter-count">1<\/span>/)
    assert.match(html, /To switch<span class="list-filter-count">2<\/span>/)

    lists.length = 0
    html = await (await request('/repos?filter=enabled&q=%20fruit%20', { cookie })).text()
    assert.deepEqual(lists, [{ filter: 'enabled', search: 'fruit', page: 1 }])
    assert.match(html, /<a href="\/repos\?filter=enabled&amp;q=fruit" aria-current="page">Enabled/)
    assert.match(html, /name="q" value="fruit"/)
    assert.match(html, /<input type="hidden" name="filter" value="enabled" \/>/)
    assert.doesNotMatch(html, /id="repo-00000000-0000-4000-8000-000000000001"/)

    lists.length = 0
    html = await (await request('/repos?filter=nope&q=zzz', { cookie })).text()
    assert.deepEqual(lists, [{ filter: 'all', search: 'zzz', page: 1 }])
    assert.match(html, /No repo matches/)
    assert.match(html, /No name contains (&quot;|")zzz(&quot;|")/)
  })

  it('gives "Enable" the secondary style, and brings the admin back to the page of the list after it (REV-36)', async () => {
    let { request, signIn } = setup()
    let { cookie, csrf } = await signIn()
    let html = await (await request('/repos?filter=disabled&q=orch', { cookie })).text()
    let action = `/repos/${ORCHARD}/enable\\?filter=disabled&amp;q=orch`
    assert.match(html, new RegExp(`<button type="submit" form="repo-actions" formaction="${action}" class="button button-small"><svg[^>]*aria-hidden="true"[^>]*>(?:(?!</svg>).)*</svg>Enable`))
    assert.doesNotMatch(html, /button-primary/)
    let response = await request(`/repos/${ORCHARD}/enable?filter=disabled&q=orch&page=3&evil=1`, { cookie, form: { _csrf: csrf } })
    assert.equal(response.headers.get('Location'), `/repos?filter=disabled&q=orch&page=3&done=enabled&repo=${ORCHARD}#repo-${ORCHARD}`)
    // The repository left the filter: the notice still names it.
    let after = await (await request(response.headers.get('Location')!, { cookie })).text()
    assert.match(after, /orchard is enabled\./)
  })

  it('shows the range, Previous, the numbers of the pages and Next, with the filter and the search (KNT-146)', async () => {
    let { signIn, request, pages, lists } = setup()
    let { cookie, html } = await signIn()
    assert.doesNotMatch(html, /class="pager/, 'one page: no pager')

    Object.assign(pages, { offset: 50, matching: 120, page: 3, pages: 5 })
    lists.length = 0
    html = await (await request('/repos?filter=enabled&q=s&page=3', { cookie })).text()
    assert.deepEqual(lists, [{ filter: 'enabled', search: 's', page: 3 }])
    assert.match(html, /<nav aria-label="Pages of the list" class="pager pager-numbered">/)
    assert.match(html, /51 to 51 of 120/)
    assert.match(html, /href="\/repos\?filter=enabled&amp;q=s&amp;page=2" rel="prev"/)
    assert.match(html, /href="\/repos\?filter=enabled&amp;q=s&amp;page=4" rel="next"/)
    // Page 1 drops `page` from the link: the first page has one URL.
    assert.match(html, /<a href="\/repos\?filter=enabled&amp;q=s" class="button button-small pager-page"><span class="visually-hidden">Page <\/span>1<\/a>/)
    assert.match(html, /<a href="\/repos\?filter=enabled&amp;q=s&amp;page=3" aria-current="page" class="button button-small pager-page">/)
    assert.equal((html.match(/aria-current="page" class="button button-small pager-page"/g) ?? []).length, 1)
    // The search and the filters start again at page 1.
    assert.match(html, /<a href="\/repos\?filter=enabled&amp;q=s" aria-current="page">Enabled/)
    assert.doesNotMatch(html, /name="page"/)
    // The icons of the pager are decorative.
    assert.match(html, /rel="next" class="button button-small"><span class="pager-step">Next<\/span><svg viewBox="0 0 24 24"[^>]*aria-hidden="true"/)

    Object.assign(pages, { offset: 100, page: 5, pages: 5 })
    html = await (await request('/repos?filter=enabled&q=s&page=9', { cookie })).text()
    assert.match(html, /<span aria-disabled="true" class="button button-small">[^]*?<span class="pager-step">Next<\/span>/)
    assert.doesNotMatch(html, /rel="next"/)
    // The dimmed Next says so to a screen reader; the steps and the numbers sit in a <div>, not a <span>.
    assert.match(html, /<span class="pager-step">Next<\/span><span class="visually-hidden"> \(no next page\)<\/span>/)
    assert.match(html, /<div class="pager-links">/)
  })

  it('"Read GitHub again" reads GitHub at once for an admin', async () => {
    let { request, signIn, checks } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request('/repos/check', { cookie, form: { _csrf: csrf } })
    assert.equal(response.headers.get('Location'), '/repos?done=checked')
    assert.deepEqual(checks, ['sakuga-software'])
  })
})
