import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG, OTHER_ORG } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import type { RepoCheck } from '../repos/check.ts'
import type { RepoView, ReposStore } from '../repos/store.ts'
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
  let store: ReposStore = {
    async list(orgId) {
      return rows[orgId] ?? []
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
  let check: RepoCheck = {
    async run(org) {
      checks.push(org.login)
      return { repos: 2, failed: 0 }
    },
    refreshIfStale: () => false,
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

  return { request, signIn, rows, changes, checks }
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
    assert.match(row, new RegExp(`action="/repos/${FRUITBACK}/disable"><input type="hidden" name="_csrf" value="${csrf}" /><button type="submit" class="button button-danger-solid">Désactiver fruitback</button>`))
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

  it('says in a note, not an alert, that a failed job set the counter back to zero, with a link to its PR', async () => {
    let { signIn } = setup()
    let { html } = await signIn()
    assert.match(html, /<span class="hint">remis à zéro après un échec sur <a href="https:\/\/github\.com\/sakuga-software\/fruitback\/pull\/12" rel="noreferrer">#12<\/a><\/span>/)
    assert.doesNotMatch(html, /hint-alert/)
  })

  it('« Actualiser » reads GitHub at once for an admin', async () => {
    let { request, signIn, checks } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request('/repos/check', { cookie, form: { _csrf: csrf } })
    assert.equal(response.headers.get('Location'), '/repos?done=checked')
    assert.deepEqual(checks, ['sakuga-software'])
  })
})
