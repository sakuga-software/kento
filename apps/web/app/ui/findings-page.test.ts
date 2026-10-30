// REV-18. The routes of the Findings screen: the selection for an admin, « Marquer dismissed » and
// « Marquer wontfix », and the notice of their answer.
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG } from '../auth/test-helpers.ts'
import type { BulkStatus, StatusOutcome } from '../findings/dismiss.ts'
import type { FindingRow } from '../findings/screen.ts'
import { EMPTY_PAGE, fakeFindingsScreenStore } from '../findings/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { createAppRouter } from '../router.ts'

const COOKIE = '__Host-kento_session'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

function finding(id: string, title: string): FindingRow {
  return {
    id, repoId: 'r', repo: 'sakuga-software/orchard', prNumber: 12, path: 'a.ts', line: 3, title, severity: 'major', category: 'bug',
    confidence: 80, status: 'open', statusReason: null, ruleId: null, ruleTitle: null, firstSeenSha: 'a'.repeat(40),
    lastSeenSha: 'a'.repeat(40), githubCommentId: 900_001, createdAt: new Date('2026-10-29T10:00:00Z'), updatedAt: new Date('2026-10-29T10:00:00Z'),
  }
}

function setup(outcome: StatusOutcome = { changed: 2, unchanged: 0, fixed: 0, missing: 0, failed: 0, replied: 2, unreplied: 0 }) {
  let auth = fakeAuth({ orgs: [ORG] })
  auth.setRole(ORG, ALEX, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let rows = [finding(A, 'Clé lue sans expiration'), finding(B, 'Erreur avalée'), { ...finding(C, 'Déjà corrigé'), status: 'fixed' as const }]
  let { store } = fakeFindingsScreenStore({ page: { ...EMPTY_PAGE, rows, counts: { ...EMPTY_PAGE.counts, open: 2, all: 2 }, matching: 2 } })
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
  async function signIn(profile = ALEX) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: cookieOf(start, COOKIE)! })
    let cookie = cookieOf(callback, COOKIE)!
    let html = await (await request('/findings?status=all&priority=major', { cookie })).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
    return { cookie, csrf, html }
  }
  return { request, signIn, calls }
}

describe('the Findings screen, its selection and its actions', () => {
  it('gives an admin a checkbox per finding, the dialog of the reasons and « Marquer wontfix »; a member none of them', async () => {
    let { signIn } = setup()
    let admin = await signIn()
    assert.match(admin.html, new RegExp(`<input type="checkbox" name="ids" value="${A}" form="findings-bulk"`))
    assert.match(admin.html, /aria-label="Sélectionner « Clé lue sans expiration »"/)
    // A finding fixed by a push has no checkbox: a person does not set it aside.
    assert.doesNotMatch(admin.html, new RegExp(`value="${C}"`))
    assert.match(admin.html, /<summary class="button">Marquer dismissed…<\/summary>/)
    assert.match(admin.html, /value="Hors sujet" form="findings-bulk"/)
    assert.match(admin.html, /name="status" value="wontfix"[^>]*>\s*Marquer wontfix/)
    // The form comes back to the list on screen.
    assert.match(admin.html, /<input type="hidden" name="back" value="status=all&amp;priority=major" \/>/)
    let member = await signIn(CAMILLE)
    assert.doesNotMatch(member.html, /name="ids"/)
    assert.doesNotMatch(member.html, /Marquer dismissed/)
  })

  it('marks the checked findings dismissed with the reason, by the login of the admin, and comes back to the list with the count', async () => {
    let { request, signIn, calls } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request('/findings/status', {
      cookie,
      form: [['_csrf', csrf], ['back', 'status=all&priority=major&evil=1'], ['ids', A], ['ids', B], ['status', 'dismissed'], ['reason', 'Hors sujet']],
    })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/findings?status=all&priority=major&done=dismissed&n=2&replied=2')
    assert.deepEqual(calls, [{ orgId: ORG.id, ids: [A, B], status: 'dismissed', reason: 'Hors sujet', actor: 'alex' }])

    let html = await (await request(response.headers.get('Location')!, { cookie })).text()
    assert.match(html, /2 findings marqués dismissed\.<\/strong> 2 réponses postées dans les fils GitHub\./)
  })

  it('says when GitHub did not take a reply, and changes nothing without a reason', async () => {
    let { request, signIn, calls } = setup({ changed: 1, unchanged: 1, fixed: 1, missing: 0, failed: 1, replied: 0, unreplied: 1 })
    let { cookie, csrf } = await signIn()
    let refused = await request('/findings/status', { cookie, form: [['_csrf', csrf], ['ids', A], ['status', 'dismissed']] })
    assert.equal(refused.headers.get('Location'), '/findings?error=reason')
    assert.equal(calls.length, 0)
    assert.match(await (await request('/findings?error=reason', { cookie })).text(), /Rien n’a changé\.<\/strong> Choisissez un motif/)

    let done = await request('/findings/status', { cookie, form: [['_csrf', csrf], ['ids', A], ['ids', B], ['status', 'wontfix']] })
    let html = await (await request(done.headers.get('Location')!, { cookie })).text()
    assert.match(html, /role="status" class="banner banner-alert"/)
    assert.match(html, /1 fil n’a pas reçu de réponse/)
    assert.match(html, /1 avait déjà ce statut et ce motif/)
    assert.match(html, /1 finding fixed est resté tel quel : un push l’a corrigé/)
    assert.match(html, /1 finding n’a pas pu être enregistré : réessayez/)
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
