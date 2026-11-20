// REV-22. The screen of a user: every member reads it, only the user changes it.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, cookiesOf, fakeAuth, OCTOCAT, ORG, SESSION_COOKIE } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'
import { readPrefForm } from '../users/controller.tsx'
import type { UserScreen, UsersStore } from '../users/store.ts'

const COOKIE = SESSION_COOKIE
const NOW = new Date('2026-10-30T10:00:00Z')
const ORCHARD = '22222222-2222-4222-8222-222222222222'
const REVIEW = '44444444-4444-4444-8444-444444444444'

function screen(pulls = 12): UserScreen {
  let rows = Array.from({ length: Math.min(pulls, 10) }, (_, i) => ({
    repoId: REVIEW,
    repo: 'sakuga-software/sakuga-review',
    prNumber: 100 + i,
    state: i === 1 ? ('closed' as const) : ('open' as const),
    reviews: 2,
    findings: { open: 1, fixed: 2, dismissed: 0, wontfix: 0, stale: 0 },
    verdict: 'REQUEST_CHANGES',
    score: 3,
    lastReviewAt: new Date(NOW.getTime() - 3_600_000),
  }))
  return {
    user: { id: 'u-1', githubId: 1, login: 'octocat', name: 'Octocat', avatarUrl: null },
    role: 'admin',
    prefs: { global: { autoReview: true, level: null }, repos: [{ repoId: ORCHARD, fullName: 'sakuga-software/orchard', autoReview: false, level: 'heavy' }] },
    addable: [{ id: REVIEW, fullName: 'sakuga-software/sakuga-review' }],
    received: { open: 4, fixed: 7, dismissed: 1, wontfix: 2, stale: 0, closed: 10, all: 14 },
    pulls: { rows, total: pulls },
  }
}

function setup() {
  let auth = fakeAuth({ orgs: [ORG] })
  auth.setRole(ORG, OCTOCAT, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let saved: string[] = []
  let asked: string[] = []
  let store: UsersStore = {
    async member(orgId, login) {
      return orgId === ORG.id && login.toLowerCase() === 'octocat' ? { id: 'u-1', login: 'octocat' } : orgId === ORG.id && login === 'camille' ? { id: 'u-2', login: 'camille' } : null
    },
    async screen(orgId, login, pulls) {
      asked.push(`${orgId} ${login} ${pulls}`)
      return login.toLowerCase() === 'octocat' ? screen() : null
    },
    async savePref(orgId, userId, repoId, pref) {
      saved.push(`${orgId} ${userId} ${repoId} ${pref.autoReview} ${pref.level}`)
      return repoId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' ? { outcome: 'not_found' } : { outcome: 'saved' }
    },
    async removePref(userId, repoId) {
      saved.push(`remove ${userId} ${repoId}`)
    },
  }
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: auth.deps,
    users: { store, now: () => NOW.getTime() },
  })
  let request = (path: string, cookie?: string | null) =>
    router.fetch(new Request(new URL(path, 'http://localhost'), { headers: cookie ? { Cookie: cookie } : {} }))
  async function signIn(profile = OCTOCAT) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, cookiesOf(start))
    let cookie = cookieOf(callback, COOKIE)!
    let html = await (await request('/users/octocat', cookie)).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
    return { cookie, csrf, html }
  }
  let post = (path: string, cookie: string, form: Record<string, string>) =>
    router.fetch(
      new Request(new URL(path, 'http://localhost'), {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://review.test' },
        body: new URLSearchParams(form),
      }),
    )
  return { request, signIn, post, saved, asked }
}

describe('the screen of a user', () => {
  it('shows a user their preferences with the forms, the theme, the findings received and their pull requests', async () => {
    let { signIn } = setup()
    let { html } = await signIn(OCTOCAT)
    assert.match(html, /<h1 class="page-title">octocat<\/h1>/)
    assert.match(html, /Octocat · Admin of sakuga-software, from their rights on GitHub\./)
    assert.match(html, /Reviews of my PRs/)
    assert.match(html, /action="\/users\/octocat\/prefs"/)
    assert.match(html, /<option value="off">Off: only on a command<\/option>/)
    assert.match(html, /sakuga-software\/orchard<\/th><td>off<\/td><td>heavy<\/td>/)
    assert.match(html, new RegExp(`action="/users/octocat/prefs/${ORCHARD}/remove"`))
    assert.match(html, /Add a repo/)
    // KNT-142: the theme is here, in a section of its own, and comes back to this screen without JavaScript.
    assert.match(html, /<h2 id="user-theme-title" class="section-title">Theme<\/h2>/)
    assert.match(html, /<form method="post" action="\/preferences\/theme" data-theme-switch="" class="user-pref-form">/)
    assert.match(html, /<input type="hidden" name="returnTo" value="\/users\/octocat" \/>/)
    assert.match(html, /<fieldset aria-describedby="theme-hint" class="field theme-switch"><legend class="label">Theme of this browser<\/legend>/)
    assert.match(html, /<p id="theme-hint" class="description">For every screen of Kentō in this browser\./)
    assert.match(html, /<input type="radio" name="theme" value="system" checked/)
    assert.match(html, /Findings received · 30 days/)
    assert.match(html, /<a href="\/findings\?author=octocat&amp;days=30">See my 4 open findings<\/a>/)
    assert.match(html, /My reviewed PRs <span class="count">12<\/span>/)
    assert.match(html, /sakuga-software\/sakuga-review#100/)
    assert.match(html, /Changes requested<\/span> · 3\/5/)
    assert.match(html, /1 open · 2 fixed/)
    assert.match(html, /Closed/)
    assert.match(html, /<a href="\/users\/octocat\?prs=20">Show 2 more PRs<\/a>/)
    // The avatar of the bar leads to this screen, and marks it.
    assert.match(html, /<a href="\/users\/octocat" aria-current="page" title="octocat" class="bar-avatar">/)
  })

  it('checks the theme of the cookie in the switch (KNT-142)', async () => {
    let { signIn, request } = setup()
    let { cookie } = await signIn(OCTOCAT)
    let html = await (await request('/users/octocat', `${cookie}; kento_theme=sumi`)).text()
    assert.match(html, /<html lang="en" data-theme="sumi">/)
    assert.match(html, /<input type="radio" name="theme" value="sumi" checked \/>Sumi/)
    assert.match(html, /<input type="radio" name="theme" value="system" \/>Device/)
  })

  it('shows another member the same screen to read, with no form', async () => {
    let { signIn, request } = setup()
    let { cookie } = await signIn(CAMILLE)
    let html = await (await request('/users/octocat', cookie)).text()
    assert.match(html, /Reviews of their PRs/)
    assert.doesNotMatch(html, /action="\/users\/octocat\/prefs/)
    assert.doesNotMatch(html, /id="user-theme-title"/)
    assert.doesNotMatch(html, /name="theme"/)
    assert.match(html, /Automatic review on · level from the repo\./)
    assert.match(html, /See their 4 open findings/)
  })

  it('answers 404 for a login that is no member of the org', async () => {
    let { signIn, request } = setup()
    let { cookie } = await signIn(OCTOCAT)
    assert.equal((await request('/users/stranger', cookie)).status, 404)
  })

  it('saves the preferences of the user, for every repository or for one, and says so', async () => {
    let { signIn, post, saved } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)
    let all = await post('/users/octocat/prefs', cookie, { _csrf: csrf, repo: '', auto: 'off', level: 'heavy' })
    assert.equal(all.status, 303)
    assert.equal(all.headers.get('Location'), '/users/octocat?done=saved')
    let one = await post('/users/octocat/prefs', cookie, { _csrf: csrf, repo: REVIEW, auto: 'on', level: '' })
    assert.equal(one.headers.get('Location'), '/users/octocat?done=added')
    let gone = await post(`/users/octocat/prefs/${ORCHARD}/remove`, cookie, { _csrf: csrf })
    assert.equal(gone.headers.get('Location'), '/users/octocat?done=removed')
    assert.deepEqual(saved, [`${ORG.id} u-1 null false heavy`, `${ORG.id} u-1 ${REVIEW} true null`, `remove u-1 ${ORCHARD}`])
  })

  it('refuses the forms of another member, a form without CSRF token, and a value it does not know', async () => {
    let { signIn, post, saved } = setup()
    let { cookie, csrf } = await signIn(CAMILLE)
    assert.equal((await post('/users/octocat/prefs', cookie, { _csrf: csrf, repo: '', auto: 'off', level: '' })).status, 403)
    assert.equal((await post(`/users/octocat/prefs/${ORCHARD}/remove`, cookie, { _csrf: csrf })).status, 403)
    assert.equal((await post('/users/camille/prefs', cookie, { repo: '', auto: 'off', level: '' })).status, 403)
    assert.equal((await post('/users/camille/prefs', cookie, { _csrf: csrf, repo: '', auto: 'maybe', level: '' })).status, 400)
    assert.deepEqual(saved, [])
  })

  it('reads a preference form', () => {
    assert.deepEqual(readPrefForm(new URLSearchParams({ repo: '', auto: 'on', level: 'lite' }) as unknown as FormData), {
      repoId: null,
      pref: { autoReview: true, level: 'lite' },
    })
    assert.equal(readPrefForm(new URLSearchParams({ repo: 'x', auto: 'on', level: '' }) as unknown as FormData), null)
    assert.equal(readPrefForm(new URLSearchParams({ repo: '', auto: 'on', level: 'ultra' }) as unknown as FormData), null)
  })
})
