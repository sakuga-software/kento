import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG, OTHER_ORG } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import type { RepoCheck } from '../repos/check.ts'
import type { RepoListQuery, RepoPage, RepoView, ReposStore } from '../repos/store.ts'
import { createAppRouter } from '../router.ts'

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
function setup() {
  let auth = fakeAuth({ orgs: [ORG, OTHER_ORG] })
  auth.setRole(ORG, ALEX, 'admin')
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
        next: null,
        previous: null,
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
      checks.push(org.login)
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

  async function signIn(profile = ALEX) {
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
  it('shows each repository with its mode, level, model, switch counter and last review', async () => {
    let { signIn } = setup()
    let { html } = await signIn()
    assert.match(html, /<h1 class="page-title">Repos<\/h1>/)
    assert.match(html, /review\.yml@stable/)
    assert.match(html, /App Kentō/)
    assert.match(html, /review\.yml encore là/)
    assert.match(html, /3\/20/)
    assert.match(html, /remis à zéro après un échec/)
    assert.match(html, /claude-haiku-5\.5/)
    assert.match(html, /href="https:\/\/github\.com\/sakuga-software\/fruitback\/pull\/677"/)
    assert.match(html, /#677 · 4\/5/)
    assert.match(html, /pas encore mesurée/)
    // REV-25: the name can be cut short on screen; its title keeps it whole.
    assert.match(html, /<a href="https:\/\/github\.com\/sakuga-software\/orchard" rel="noreferrer" title="sakuga-software\/orchard" class="repo-name">orchard<\/a>/)
    assert.match(html, /Critère de bascule/)
    assert.match(html, /Repli pendant la transition/)
    // « Gérer l'installation » leads to the page of the App on GitHub.
    assert.match(html, /href="https:\/\/github\.com\/organizations\/sakuga-software\/settings\/installations\/11"/)
    // The repositories of another org of the person are not on screen.
    assert.doesNotMatch(html, /orchard\/app/)
  })

  it('gives an admin « Activer », « Désactiver » and « Actualiser », and a member none of them', async () => {
    let { signIn } = setup()
    let admin = (await signIn(ALEX)).html
    assert.match(admin, new RegExp(`action="/repos/${ORCHARD}/enable"`))
    assert.match(admin, new RegExp(`action="/repos/${FRUITBACK}/disable"`))
    assert.match(admin, /action="\/repos\/check"/)

    let member = (await signIn(CAMILLE)).html
    assert.match(member, /Lecture seule\./)
    assert.doesNotMatch(member, /\/enable"|\/disable"|data-confirm|action="\/repos\/check"|Gérer l’installation/)
  })

  it('enables a repository for an admin, with CSRF, and says what the next push does', async () => {
    let { request, signIn, changes } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request(`/repos/${ORCHARD}/enable`, { cookie, form: { _csrf: csrf } })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), `/repos?done=enabled&repo=${ORCHARD}#repo-${ORCHARD}`)
    assert.deepEqual(changes, ['sakuga-software/orchard:true'])
    let html = await (await request(response.headers.get('Location')!, { cookie })).text()
    assert.match(html, /orchard est activé\.<\/strong> Le prochain push d’une PR crée un job Kentō\./)
  })

  it('asks to confirm a disable in its row, then disables and says that the published reviews stay', async () => {
    let { request, signIn, changes } = setup()
    let { cookie, csrf, html: page } = await signIn()
    // REV-33: the confirmation is in the row of the repository, closed, with the destructive style and « Annuler ».
    let row = page.slice(page.indexOf(`id="repo-${FRUITBACK}"`), page.indexOf('</tr>', page.indexOf(`id="repo-${FRUITBACK}"`)))
    assert.match(row, /<details data-confirm class="confirm"><summary class="button button-danger"><span>Désactiver<span class="visually-hidden"> fruitback<\/span>…<\/span><\/summary>/)
    // REV-36: the button posts the one form of the list, which carries the token.
    assert.match(row, new RegExp(`<button type="submit" form="repo-actions" formaction="/repos/${FRUITBACK}/disable" class="button button-danger-solid">Désactiver fruitback</button>`))
    assert.match(page, new RegExp(`<form id="repo-actions" method="post" hidden><input type="hidden" name="_csrf" value="${csrf}" /></form>`))
    assert.match(row, /<button type="button" data-confirm-cancel hidden class="button">Annuler<\/button>/)
    assert.match(row, /Les reviews déjà publiées restent sur GitHub/)
    // No destructive button has the style of the main action.
    assert.doesNotMatch(page, /button-primary[^>]*>\s*Désactiver/)
    assert.deepEqual(changes, [], 'the confirmation changes nothing')

    let response = await request(`/repos/${FRUITBACK}/disable`, { cookie, form: { _csrf: csrf } })
    assert.equal(response.status, 303)
    assert.deepEqual(changes, ['sakuga-software/fruitback:false'])
    let html = await (await request(response.headers.get('Location')!, { cookie })).text()
    assert.match(html, /fruitback est désactivé\.<\/strong> Aucun nouveau job ne part \(2 jobs en file annulés\)/)
    assert.match(html, /les reviews publiées restent/)
  })

  it('refuses a change from a member (403), without CSRF, from another site, or on a repository of another org', async () => {
    let { request, signIn, changes } = setup()
    let member = await signIn(CAMILLE)
    assert.equal((await request(`/repos/${ORCHARD}/enable`, { cookie: member.cookie, form: { _csrf: member.csrf } })).status, 403)
    assert.equal((await request('/repos/check', { cookie: member.cookie, form: { _csrf: member.csrf } })).status, 403)
    // A member gets no confirmation either.
    assert.doesNotMatch(await (await request('/repos', { cookie: member.cookie })).text(), /data-confirm|\/disable"/)

    let admin = await signIn(ALEX)
    assert.equal((await request(`/repos/${ORCHARD}/enable`, { cookie: admin.cookie, form: {} })).status, 403)
    assert.equal(
      (await request(`/repos/${ORCHARD}/enable`, { cookie: admin.cookie, headers: { 'Sec-Fetch-Site': 'cross-site' }, form: { _csrf: admin.csrf } })).status,
      403,
    )
    assert.equal((await request(`/repos/${ELSEWHERE}/disable`, { cookie: admin.cookie, form: { _csrf: admin.csrf } })).status, 404)
    assert.equal((await request('/repos/not-a-uuid/disable', { cookie: admin.cookie, form: { _csrf: admin.csrf } })).status, 404)
    assert.deepEqual(changes, [])
  })

  it('shows « Retirer review.yml » to an admin at 20/20 with the workflow still there, and « basculé » without it', async () => {
    let { signIn, rows } = setup()
    rows[ORG.id]![1]!.streak = 23
    rows[ORG.id]![1]!.resetBy = 'failure'
    let { html } = await signIn()
    assert.match(html, /20\/20/)
    assert.doesNotMatch(html, /remis à zéro/)
    assert.match(html, /href="https:\/\/github\.com\/sakuga-software\/fruitback\/delete\/main\/\.github\/workflows\/sakuga-review\.yml"/)
    assert.match((await signIn(CAMILLE)).html, /prêt à retirer review\.yml/)

    rows[ORG.id]![1]!.workflow = 'none'
    assert.match((await signIn()).html, /basculé/)
  })

  it('reads the screen again by itself while GitHub is being checked, and not after (REV-26)', async () => {
    let { request, signIn, checking } = setup()
    let { cookie, html } = await signIn()
    assert.doesNotMatch(html, /data-recheck/)
    assert.doesNotMatch(html, /assets\/repos.js/)
    checking.now = true
    html = await (await request('/repos', { cookie })).text()
    assert.match(html, /<span data-recheck="">vérification en cours sur GitHub · <a href="\/repos">Recharger<\/a><\/span>/)
    assert.match(html, /src="\/assets\/repos.js\?v=1.2.3"/)
    assert.doesNotMatch(html, /rechargez dans un instant/)
  })

  it('says in a note, not an alert, that a failed job set the counter back to zero, with a link to its PR', async () => {
    let { signIn } = setup()
    let { html } = await signIn()
    assert.match(html, /<span class="hint">remis à zéro après un échec sur <a href="https:\/\/github\.com\/sakuga-software\/fruitback\/pull\/12" rel="noreferrer">#12<\/a><\/span>/)
    assert.doesNotMatch(html, /hint-alert/)
  })

  it('searches the name and filters the list, with the counts of the org, and keeps both in the links (REV-36)', async () => {
    let { request, signIn, lists } = setup()
    let { cookie, html } = await signIn()
    assert.match(html, /<form method="get" action="\/repos" role="search" class="list-search">/)
    assert.match(html, /<a href="\/repos" aria-current="page">Tous<span class="list-filter-count">2<\/span><\/a>/)
    assert.match(html, /<a href="\/repos\?filter=enabled">Activés<span class="list-filter-count">1<\/span><\/a>/)
    assert.match(html, /Non activés<span class="list-filter-count">1<\/span>/)
    assert.match(html, /À basculer<span class="list-filter-count">2<\/span>/)

    lists.length = 0
    html = await (await request('/repos?filter=enabled&q=%20fruit%20', { cookie })).text()
    assert.deepEqual(lists, [{ filter: 'enabled', search: 'fruit', after: null, before: null }])
    assert.match(html, /<a href="\/repos\?filter=enabled&amp;q=fruit" aria-current="page">Activés/)
    assert.match(html, /name="q" value="fruit"/)
    assert.match(html, /<input type="hidden" name="filter" value="enabled" \/>/)
    assert.doesNotMatch(html, /id="repo-00000000-0000-4000-8000-000000000001"/)

    lists.length = 0
    html = await (await request('/repos?filter=nope&q=zzz', { cookie })).text()
    assert.deepEqual(lists, [{ filter: 'all', search: 'zzz', after: null, before: null }])
    assert.match(html, /Aucun repo ne correspond/)
    assert.match(html, /Aucun nom ne contient « zzz »/)
  })

  it('gives « Activer » the secondary style, and brings the admin back to the page of the list after it (REV-36)', async () => {
    let { request, signIn } = setup()
    let { cookie, csrf } = await signIn()
    let html = await (await request('/repos?filter=disabled&q=key', { cookie })).text()
    let action = `/repos/${ORCHARD}/enable\\?filter=disabled&amp;q=key`
    assert.match(html, new RegExp(`<button type="submit" form="repo-actions" formaction="${action}" class="button button-small">Activer`))
    assert.doesNotMatch(html, /button-primary/)
    let response = await request(`/repos/${ORCHARD}/enable?filter=disabled&q=key&after=x&evil=1`, { cookie, form: { _csrf: csrf } })
    assert.equal(response.headers.get('Location'), `/repos?filter=disabled&q=key&after=x&done=enabled&repo=${ORCHARD}#repo-${ORCHARD}`)
    // The repository left the filter: the notice still names it.
    let after = await (await request(response.headers.get('Location')!, { cookie })).text()
    assert.match(after, /orchard est activé\./)
  })

  it('shows the range and the links to the pages around, with the filter and the search (REV-36)', async () => {
    let { signIn, request, pages } = setup()
    let { cookie, html } = await signIn()
    assert.doesNotMatch(html, /class="pager"/, 'one page: no pager')

    Object.assign(pages, { offset: 50, matching: 120, previous: ORCHARD, next: FRUITBACK })
    html = await (await request('/repos?filter=enabled&q=s', { cookie })).text()
    assert.match(html, /<nav aria-label="Pages de la liste" class="pager">/)
    assert.match(html, /51–51 sur 120/)
    assert.match(html, new RegExp(`href="/repos\\?filter=enabled&amp;q=s&amp;before=${ORCHARD}" rel="prev"`))
    assert.match(html, new RegExp(`href="/repos\\?filter=enabled&amp;q=s&amp;after=${FRUITBACK}" rel="next"`))
  })

  it('« Actualiser » reads GitHub at once for an admin', async () => {
    let { request, signIn, checks } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request('/repos/check', { cookie, form: { _csrf: csrf } })
    assert.equal(response.headers.get('Location'), '/repos?done=checked')
    assert.deepEqual(checks, ['sakuga-software'])
  })
})
