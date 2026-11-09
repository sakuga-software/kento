// REV-18. The routes of the Findings screen: the selection for an admin, « Marquer dismissed » and
// « Marquer wontfix », and the notice of their answer.
import { readFileSync } from 'node:fs'

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
    lastSeenSha: 'a'.repeat(40), githubCommentId: 900_001, considered: false, createdAt: new Date('2026-10-29T10:00:00Z'), updatedAt: new Date('2026-10-29T10:00:00Z'),
  }
}

function setup(outcome: StatusOutcome = { changed: 2, unchanged: 0, fixed: 0, missing: 0, failed: 0, replied: 2, unreplied: 0 }, empty = false) {
  let auth = fakeAuth({ orgs: [ORG] })
  auth.setRole(ORG, ALEX, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let rows = [finding(A, 'Clé lue sans expiration'), { ...finding(B, 'Erreur avalée'), considered: true }, { ...finding(C, 'Déjà corrigé'), status: 'fixed' as const }]
  let { store, lists } = fakeFindingsScreenStore({ page: empty ? EMPTY_PAGE : { ...EMPTY_PAGE, rows, counts: { ...EMPTY_PAGE.counts, open: 2, all: 2 }, matching: 2 } })
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
  return { request, signIn, calls, lists }
}

describe('the findings to consider (REV-102)', () => {
  it('tags a finding that its last review lists « À considérer », and only that one', async () => {
    let { signIn } = setup()
    let { html } = await signIn()
    let tagged = [...html.matchAll(/<tr id="finding-([0-9a-f-]+)">[\s\S]*?<\/tr>/g)].filter((m) => m[0].includes('>À considérer</span>')).map((m) => m[1])
    assert.deepEqual(tagged, [B])
    assert.match(html, /<span title="Code déjà relu par une review précédente : ce finding ne bloque pas la PR\." class="tag tag-info">À considérer<\/span>|<span class="tag tag-info" title="Code déjà relu par une review précédente : ce finding ne bloque pas la PR\.">À considérer<\/span>/)
  })

  it('filters them with « Type », in the URL, and keeps the filter through the tabs and « Effacer les filtres »', async () => {
    let { request, signIn, lists } = setup()
    let { cookie } = await signIn()
    let html = await (await request('/findings?type=a-considerer', { cookie })).text()
    assert.equal(lists.at(-1)!.considered, true)
    assert.match(html, /<option value="a-considerer" selected>\s*À considérer \(code déjà relu\)\s*<\/option>/)
    assert.match(html, /href="\/findings\?status=all&amp;type=a-considerer"/)
    assert.match(html, /<a href="\/findings" class="button button-ghost">Effacer les filtres/)
    await request('/findings?type=autre', { cookie })
    assert.equal(lists.at(-1)!.considered, false, 'a value that the screen does not know is ignored')
  })
})

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

  it('shows the list under its tab, the statuses as a segmented control, and the precision under its own tab (REV-91)', async () => {
    let { request, signIn } = setup()
    let { cookie, html } = await signIn()
    assert.match(html, /<nav aria-label="Vues des findings" class="tabs"><a href="\/findings\?status=all&amp;priority=major" aria-current="page">Liste<\/a><a href="\/findings\?status=all&amp;priority=major&amp;vue=precision">Précision<\/a><\/nav>/)
    assert.match(html, /Précision sur 30 j : /)
    assert.match(html, /<nav aria-label="Statut des findings" class="segmented-links findings-views">/)
    assert.match(html, /for="findings-rule"[^>]*>\s*Source\s*<\/label>/)
    assert.match(html, /<option value=""[^>]*>\s*Review et règles\s*<\/option>/)
    // The org of the test has no rule: the list « Source » is disabled, as before REV-91.
    assert.match(html, /<select[^>]*id="findings-rule"[^>]*disabled|<select[^>]*disabled[^>]*id="findings-rule"/)
    assert.match(html, /class="button findings-submit" type="submit"|type="submit" class="button findings-submit"/)
    assert.doesNotMatch(html, /Précision · 30 derniers jours/)
    let precision = await (await request('/findings?vue=precision', { cookie })).text()
    assert.match(precision, /<a href="\/findings\?vue=precision" aria-current="page">Précision<\/a>/)
    assert.doesNotMatch(precision, /name="ids"/)
    assert.doesNotMatch(precision, /findings-filters/)
    // Liste → Précision → Liste keeps the filters of the person.
    let back = await (await request('/findings?status=all&priority=major&vue=precision', { cookie })).text()
    assert.match(back, /<a href="\/findings\?status=all&amp;priority=major">Liste<\/a>/)
  })

  it('keeps the tabs and the precision for an org with no finding yet (REV-91)', async () => {
    let { request, signIn } = setup(undefined, true)
    let { cookie } = await signIn()
    let html = await (await request('/findings', { cookie })).text()
    assert.match(html, /Aucun finding pour l’instant/)
    assert.match(html, /<nav aria-label="Vues des findings" class="tabs">/)
    let precision = await (await request('/findings?vue=precision', { cookie })).text()
    assert.match(precision, /<a href="\/findings\?vue=precision" aria-current="page">Précision<\/a>/)
    assert.match(precision, /Précision · 30 derniers jours/)
    assert.doesNotMatch(precision, /Aucun finding pour l’instant/)
  })

  it('runs no list query on « Précision », which shows neither rows nor filters (REV-91)', async () => {
    let { request, signIn, lists } = setup()
    let { cookie } = await signIn()
    let before = lists.length
    let precision = await (await request('/findings?status=all&vue=precision', { cookie })).text()
    assert.match(precision, /Précision · 30 derniers jours/)
    assert.equal(lists.length, before)
  })

  it('drops a cursor that does not decode, from the query and from the links (REV-91)', async () => {
    let { request, signIn, lists } = setup()
    let { cookie } = await signIn()
    let html = await (await request('/findings?status=all&after=not-a-cursor&before=%E2%9C%97', { cookie })).text()
    assert.equal(lists.at(-1)!.after, null)
    assert.equal(lists.at(-1)!.before, null)
    // The tabs, the statuses and the `back` of the actions are built from the list: no cursor in them.
    assert.doesNotMatch(html, /href="[^"]*(?:after|before)=/)
    assert.match(html, /<input type="hidden" name="back" value="status=all" \/>/)
    let good = Buffer.from(`2026-11-01T10:00:00.000000Z|${A}`).toString('base64url')
    await request(`/findings?after=${good}`, { cookie })
    assert.equal(lists.at(-1)!.after, good)
  })

  it('loads findings.js once on the list, for an admin and a member, and not on « Précision » (REV-91)', async () => {
    let { request, signIn } = setup()
    let scripts = (html: string) => html.match(/\/assets\/findings\.js/g)?.length ?? 0
    let admin = await signIn()
    // « Filtrer » hides under `.js`: theme.js sets it, as a blocking script of the head, before the first paint.
    assert.match(admin.html, /<head>(?:(?!<\/head>).)*<script src="\/assets\/theme\.js\?v=[^"]*"><\/script>(?:(?!<\/head>).)*<\/head>/s)
    assert.match(readFileSync(new URL('../../public/assets/theme.js', import.meta.url), 'utf8'), /^ *document\.documentElement\.classList\.add\('js'\)$/m)
    assert.equal(scripts(admin.html), 1)
    assert.equal(scripts(await (await request('/findings?q=cle', { cookie: admin.cookie })).text()), 1)
    let member = await signIn(CAMILLE)
    assert.equal(scripts(member.html), 1)
    assert.equal(scripts(await (await request('/findings?vue=precision', { cookie: admin.cookie })).text()), 0)
    // One tag, after the bar: not one inside the bar and one outside it.
    assert.match(admin.html, /data-select-none[^]*<\/div><script src="\/assets\/findings\.js/)
  })

  it('keeps a rule of the URL in the filters when the org has no rule left, and « Source » is disabled (REV-91)', async () => {
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
    assert.match(html, /Aucun finding open pour ces filtres/)
    assert.equal(html.match(/\/assets\/findings\.js/g)?.length, 1)
  })

  it('marks the checked findings dismissed with the reason, by the login of the admin, and comes back to the list with the count', async () => {
    let { request, signIn, calls } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request('/findings/status', {
      cookie,
      form: [['_csrf', csrf], ['back', 'status=all&priority=major&evil=1&vue=precision'], ['ids', A], ['ids', B], ['status', 'dismissed'], ['reason', 'Hors sujet']],
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

  it('says how many findings of the batch no longer exist (REV-58)', async () => {
    let { request, signIn } = setup({ changed: 2, unchanged: 0, fixed: 0, missing: 1, failed: 0, replied: 2, unreplied: 0 })
    let { cookie, csrf } = await signIn()
    let done = await request('/findings/status', {
      cookie,
      form: [['_csrf', csrf], ['ids', A], ['ids', B], ['ids', C], ['status', 'dismissed'], ['reason', 'Faux positif']],
    })
    assert.equal(done.headers.get('Location'), '/findings?done=dismissed&n=2&missing=1&replied=2')
    let html = await (await request(done.headers.get('Location')!, { cookie })).text()
    assert.match(html, /role="status" class="banner banner-alert"/)
    assert.match(html, /2 findings marqués dismissed\.<\/strong>/)
    assert.match(await (await request('/findings?done=wontfix&n=0&missing=2', { cookie })).text(), /2 findings n’existent plus dans cette organisation/)
    assert.match(html, /1 finding n’existe plus dans cette organisation, par exemple parce que son repo a été retiré depuis l’affichage de la page\. La liste ci-dessous est à jour\./)
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
