import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG, OTHER_ORG } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import type { ConfigOverrides } from '../repo-config/model.ts'
import { serviceProviders } from '../repo-config/providers.ts'
import type { RepoConfigStore, RepoConfigView } from '../repo-config/store.ts'
import { createAppRouter } from '../router.ts'

const COOKIE = '__Host-kento_session'
const ORCHARD = '00000000-0000-4000-8000-000000000001'
const ELSEWHERE = '00000000-0000-4000-8000-000000000009'

/** The Config screen with the fake sign-in, and the configs in memory. */
function setup(orgConfig: ConfigOverrides = {}) {
  let auth = fakeAuth({ orgs: [ORG, OTHER_ORG] })
  auth.setRole(ORG, ALEX, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let rows: Record<string, RepoConfigView & { orgId: string }> = {
    [ORCHARD]: {
      orgId: ORG.id,
      id: ORCHARD,
      fullName: 'sakuga-software/orchard',
      enabled: true,
      defaultLevel: 'lite',
      config: {},
      orgConfig,
      version: 0,
      updatedBy: null,
      updatedAt: null,
      spentThisMonthUsd: 3.42,
      trustedBots: ['renovate[bot]'],
    },
    [ELSEWHERE]: {
      orgId: OTHER_ORG.id,
      id: ELSEWHERE,
      fullName: 'orchard/app',
      enabled: true,
      defaultLevel: 'lite',
      config: {},
      orgConfig: {},
      version: 0,
      updatedBy: null,
      updatedAt: null,
      spentThisMonthUsd: 0,
      trustedBots: ['sakuga-agent[bot]'],
    },
  }
  let saves: { field: string; version: number }[] = []
  let store: RepoConfigStore = {
    async read(orgId, repoId) {
      let row = rows[repoId]
      return row && row.orgId === orgId ? { ...row } : null
    },
    async save(orgId, repoId, userId, expectedVersion, change) {
      let row = rows[repoId]
      if (!row || row.orgId !== orgId) return { kind: 'not_found' }
      if (row.version !== expectedVersion) return { kind: 'conflict', version: row.version, updatedBy: row.updatedBy, updatedAt: row.updatedAt }
      let next = change({ config: structuredClone(row.config), defaultLevel: row.defaultLevel })
      row.config = next.config
      row.defaultLevel = next.defaultLevel
      row.version += 1
      row.updatedBy = userId ? 'alex' : null
      row.updatedAt = new Date('2026-10-27T17:02:00Z')
      saves.push({ field: JSON.stringify(next), version: row.version })
      return { kind: 'saved', version: row.version, fullName: row.fullName }
    },
  }
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: auth.deps,
    repoConfig: { store, providers: serviceProviders },
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
    let html = await (await request(`/repos/${ORCHARD}/config`, { cookie })).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
    return { cookie, csrf, html }
  }

  return { request, signIn, rows, saves }
}

const BALANCED = { field: 'models.balanced', provider: 'service', model: 'anthropic/claude-sonnet-5.5', fallback: '' }

describe('the Config screen of a repository', () => {
  it('shows each level with its model, inherited from the org, and the five tabs', async () => {
    let { signIn } = setup({ models: { heavy: { provider: 'service', model: 'anthropic/claude-opus-5.5', fallback: null } } })
    let { html } = await signIn()
    assert.match(html, /<title>Config de orchard · Kentō<\/title>/)
    assert.match(html, /config v0 : tout est hérité de l’org/)
    for (let tab of ['Provider et modèles', 'Niveaux et passes', 'Déclenchement', 'Règles', 'Assignation']) assert.match(html, new RegExp(tab))
    assert.match(html, /aria-current="page">Provider et modèles/)
    assert.match(html, /value="anthropic\/claude-haiku-5\.5"/)
    assert.match(html, /value="z-ai\/glm-5\.3"/)
    assert.match(html, /value="anthropic\/claude-opus-5\.5"/)
    assert.equal(html.match(/hérité de l’org/g)?.length, 4, 'the version line and the three levels')
    assert.doesNotMatch(html, /remplacé ici|Revenir à l’org/)
  })

  it('replaces the model of balanced for an admin, then « Revenir à l’org » takes the value of the org back', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', ...BALANCED, model: 'anthropic/claude-sonnet-5.6' } })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), `/repos/${ORCHARD}/config?tab=models&done=saved&v=1`)
    assert.deepEqual(rows[ORCHARD]!.config, { models: { balanced: { provider: 'service', model: 'anthropic/claude-sonnet-5.6', fallback: null } } })

    let html = await (await request(response.headers.get('Location')!, { cookie })).text()
    assert.match(html, /Config enregistrée<\/strong> \(v1\)/)
    assert.match(html, /config v1, modifiée par alex le 27 oct\. à 18:02/)
    assert.match(html, /remplacé ici/)
    assert.match(html, /Revenir à l’org<span class="visually-hidden"> pour balanced/)

    let csrf2 = /name="_csrf" value="([0-9a-f]+)"/.exec(html)![1]!
    let reset = await request(`/repos/${ORCHARD}/config/reset`, { cookie, form: { _csrf: csrf2, version: '1', field: 'models.balanced' } })
    assert.equal(reset.status, 303)
    assert.deepEqual(rows[ORCHARD]!.config, {})
    assert.match(await (await request(reset.headers.get('Location')!, { cookie })).text(), /Valeur de l’org reprise<\/strong> \(v2\)/)
  })

  it('sets the trigger, the paths, the limit and the default level, each with its own form', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn()
    let post = async (version: number, form: Record<string, string>) =>
      (await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: String(version), ...form } })).status
    assert.equal(await post(0, { field: 'trigger', trigger: 'ready' }), 303)
    assert.equal(await post(1, { field: 'paths', paths: 'apps/web\n**/*.sql' }), 303)
    assert.equal(await post(2, { field: 'monthlyCapUsd', monthlyCapUsd: '12,50' }), 303)
    assert.equal(await post(3, { field: 'level', defaultLevel: 'balanced' }), 303)
    // REV-13: the level is a key of the config, and the column keeps it for an earlier release.
    assert.deepEqual(rows[ORCHARD]!.config, { trigger: 'ready', paths: ['apps/web', '**/*.sql'], monthlyCapUsd: 12.5, level: 'balanced' })
    assert.equal(rows[ORCHARD]!.defaultLevel, 'balanced')

    let trigger = await (await request(`/repos/${ORCHARD}/config?tab=trigger`, { cookie })).text()
    assert.match(trigger, /value="ready" checked/)
    assert.match(trigger, /<textarea[^>]*>apps\/web\n\*\*\/\*\.sql<\/textarea>/)
    assert.match(trigger, /Dépensé ce mois-ci : 3,42\s\$ sur 12,50\s\$\./)
    assert.match(trigger, /name="monthlyCapUsd" value="12,50"/)
    assert.match(trigger, /renovate\[bot\]/)
    assert.match(trigger, /PR d’un fork/)
    let levels = await (await request(`/repos/${ORCHARD}/config?tab=levels`, { cookie })).text()
    assert.match(levels, /value="balanced" checked/)
    assert.match(levels, /Une passe/)
  })

  it('sends a wrong form back with its values and its errors (422), and writes nothing', async () => {
    let { request, signIn, saves } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request(`/repos/${ORCHARD}/config`, {
      cookie,
      form: { _csrf: csrf, version: '0', field: 'models.balanced', provider: 'elsewhere', model: 'a b', fallback: '' },
    })
    assert.equal(response.status, 422)
    let html = await response.text()
    assert.match(html, /Choisissez un provider de l’org\./)
    assert.match(html, /value="a b"/)
    assert.match(html, /aria-invalid="true"/)
    let cap = await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', field: 'monthlyCapUsd', monthlyCapUsd: 'beaucoup' } })
    assert.equal(cap.status, 422)
    assert.equal(saves.length, 0)
  })

  it('refuses a form from an older version (409): someone saved in between, nothing is overwritten', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn()
    assert.equal((await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', field: 'trigger', trigger: 'command' } })).status, 303)
    let stale = await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', ...BALANCED } })
    assert.equal(stale.status, 409)
    assert.match(await stale.text(), /La config a changé entre-temps<\/strong> \(v1, modifiée par alex/)
    assert.deepEqual(rows[ORCHARD]!.config, { trigger: 'command' })
  })

  it('shows a member the config under « Lecture seule », with no form, and refuses their POST (403)', async () => {
    let { request, signIn, saves } = setup()
    let { cookie, csrf, html } = await signIn(CAMILLE)
    assert.match(html, /Lecture seule\./)
    assert.match(html, /anthropic\/claude-haiku-5\.5/)
    assert.doesNotMatch(html, new RegExp(`action="/repos/${ORCHARD}/config`))
    let trigger = await (await request(`/repos/${ORCHARD}/config?tab=trigger`, { cookie })).text()
    assert.doesNotMatch(trigger, /<form method="post" action="\/repos\//)
    assert.equal((await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', ...BALANCED } })).status, 403)
    assert.equal((await request(`/repos/${ORCHARD}/config/reset`, { cookie, form: { _csrf: csrf, version: '0', field: 'trigger' } })).status, 403)
    assert.equal(saves.length, 0)
  })

  it('refuses a change without CSRF, from another site, on a repository of another org, or with an unknown field', async () => {
    let { request, signIn, saves } = setup()
    let { cookie, csrf } = await signIn()
    assert.equal((await request(`/repos/${ORCHARD}/config`, { cookie, form: { version: '0', ...BALANCED } })).status, 403)
    assert.equal(
      (await request(`/repos/${ORCHARD}/config`, { cookie, headers: { 'Sec-Fetch-Site': 'cross-site' }, form: { _csrf: csrf, version: '0', ...BALANCED } })).status,
      403,
    )
    assert.equal((await request(`/repos/${ELSEWHERE}/config`, { cookie, form: { _csrf: csrf, version: '0', ...BALANCED } })).status, 404)
    assert.equal((await request(`/repos/${ELSEWHERE}/config`, { cookie })).status, 404)
    assert.equal((await request('/repos/not-a-uuid/config', { cookie })).status, 404)
    assert.equal((await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', field: 'enabled' } })).status, 400)
    assert.equal((await request(`/repos/${ORCHARD}/config/reset`, { cookie, form: { _csrf: csrf, version: '0', field: 'enabled' } })).status, 400)
    assert.equal((await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: 'x', ...BALANCED } })).status, 400)
    assert.equal(saves.length, 0)
  })

  it('inherits the level of the org, and « Revenir à l’org » takes it back (REV-13)', async () => {
    let { request, signIn, rows } = setup({ level: 'heavy' })
    let { cookie, csrf } = await signIn()
    let levels = await (await request(`/repos/${ORCHARD}/config?tab=levels`, { cookie })).text()
    assert.match(levels, /value="heavy" checked/)
    assert.match(levels, /hérité de l’org/)
    assert.doesNotMatch(levels, /Revenir à l’org<span class="visually-hidden"> pour le niveau/)
    assert.equal((await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', field: 'level', defaultLevel: 'lite' } })).status, 303)
    levels = await (await request(`/repos/${ORCHARD}/config?tab=levels`, { cookie })).text()
    assert.match(levels, /value="lite" checked/)
    assert.match(levels, /remplacé ici/)
    let reset = await request(`/repos/${ORCHARD}/config/reset`, { cookie, form: { _csrf: csrf, version: '1', field: 'level' } })
    assert.equal(reset.status, 303)
    assert.deepEqual(rows[ORCHARD]!.config, {})
    assert.equal(rows[ORCHARD]!.defaultLevel, 'lite')
    assert.match(await (await request(`/repos/${ORCHARD}/config?tab=levels`, { cookie })).text(), /value="heavy" checked/)
  })

  it('shows the tabs of M5 empty', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn()
    assert.match(await (await request(`/repos/${ORCHARD}/config?tab=rules`, { cookie })).text(), /arrivent avec M5/)
    assert.match(await (await request(`/repos/${ORCHARD}/config?tab=assignment`, { cookie })).text(), /arrivent avec M5/)
  })
})
