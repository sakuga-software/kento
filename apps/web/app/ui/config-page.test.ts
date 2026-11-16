import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG, OTHER_ORG } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import type { ConfigOverrides } from '../repo-config/model.ts'
import { serviceOption, serviceProviders, type ProviderCatalog } from '../repo-config/providers.ts'
import type { RepoConfigStore, RepoConfigView } from '../repo-config/store.ts'
import { createAppRouter } from '../router.ts'

const COOKIE = '__Host-kento_session'
const ORCHARD = '00000000-0000-4000-8000-000000000001'
const ELSEWHERE = '00000000-0000-4000-8000-000000000009'

/** The Config screen with the fake sign-in, and the configs in memory. */
function setup(orgConfig: ConfigOverrides = {}, providers: ProviderCatalog = serviceProviders) {
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
    repoConfig: { store, providers },
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


/** REV-28. The fields that the page focuses at load: the `id` of each element with `autofocus`. */
function autofocused(html: string): string[] {
  return [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bautofocus\b[^>]*>/gi)].map((m) => /\bid="([^"]+)"/.exec(m[0])?.[1] ?? '?')
}

describe('the Config screen of a repository', () => {
  it('shows each level with its model, inherited from the org, and the five tabs', async () => {
    let { signIn } = setup({ models: { heavy: { provider: 'service', model: 'anthropic/claude-opus-5.5', fallback: null } } })
    let { html } = await signIn()
    assert.match(html, /<title>Config of orchard · Kentō<\/title>/)
    assert.match(html, /config v0, everything comes from the organization/)
    for (let tab of ['Provider and models', 'Levels and passes', 'Trigger', 'Rules', 'Assignment']) assert.match(html, new RegExp(tab))
    assert.match(html, /aria-current="page">Provider and models/)
    assert.match(html, /value="anthropic\/claude-haiku-5\.5"/)
    assert.match(html, /value="z-ai\/glm-5\.3"/)
    assert.match(html, /value="anthropic\/claude-opus-5\.5"/)
    assert.equal(html.match(/from the org/g)?.length, 4, 'the version line and the three levels')
    assert.doesNotMatch(html, /set for this repo|Back to the org value/)
  })

  it('replaces the model of balanced for an admin, then « Revenir à l’org » takes the value of the org back', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', ...BALANCED, model: 'anthropic/claude-sonnet-5.6' } })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), `/repos/${ORCHARD}/config?tab=models&done=saved&v=1`)
    assert.deepEqual(rows[ORCHARD]!.config, { models: { balanced: { provider: 'service', model: 'anthropic/claude-sonnet-5.6', fallback: null } } })

    let html = await (await request(response.headers.get('Location')!, { cookie })).text()
    assert.match(html, /Config saved<\/strong> \(v1\)/)
    assert.match(html, /config v1, changed by alex on 27 Oct at 18:02/)
    assert.match(html, /set for this repo/)
    assert.match(html, /Back to the org value<span class="visually-hidden"> for balanced/)

    let csrf2 = /name="_csrf" value="([0-9a-f]+)"/.exec(html)![1]!
    let reset = await request(`/repos/${ORCHARD}/config/reset`, { cookie, form: { _csrf: csrf2, version: '1', field: 'models.balanced' } })
    assert.equal(reset.status, 303)
    assert.deepEqual(rows[ORCHARD]!.config, {})
    assert.match(await (await request(reset.headers.get('Location')!, { cookie })).text(), /Value of the organization restored<\/strong> \(v2\)/)
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
    assert.match(trigger, /Spent this month: \$3\.42 of \$12\.50\./)
    assert.match(trigger, /name="monthlyCapUsd" value="12\.50"/)
    assert.match(trigger, /renovate\[bot\]/)
    assert.match(trigger, /PR from a fork/)
    let levels = await (await request(`/repos/${ORCHARD}/config?tab=levels`, { cookie })).text()
    assert.match(levels, /value="balanced" checked/)
    assert.match(levels, /One pass/)
    // REV-43: « Soon » and no milestone of the team; a label ends with a period, not an em dash.
    assert.doesNotMatch(levels.replace(/ d="[^"]*"/g, ''), /\bM[0-9]\b|bench/, 'the paths of the icons aside')
    assert.match(levels, /<span class="tag tag-quiet">Soon<\/span>/)
    assert.match(levels, /<strong class="mono">lite<\/strong>\. Fast and the cheapest, about 1 cent per review\./)
    assert.doesNotMatch(levels + trigger, / — /)
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
    assert.match(html, /Choose a provider of the organization\./)
    assert.match(html, /value="a b"/)
    assert.match(html, /aria-invalid="true"/)
    let cap = await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', field: 'monthlyCapUsd', monthlyCapUsd: 'beaucoup' } })
    assert.equal(cap.status, 422)
    assert.equal(saves.length, 0)
    // REV-28: each form opens on its first field in error, with a summary for a screen reader.
    assert.deepEqual(autofocused(html), ['level-balanced-provider'])
    let capHtml = await cap.text()
    assert.deepEqual(autofocused(capHtml), ['config-cap'])
    assert.match(capHtml, /role="alert"[^>]*><p><strong>Nothing is saved/)
    let model = await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', field: 'models.lite', provider: 'service', model: 'a b', fallback: '' } })
    assert.deepEqual(autofocused(await model.text()), ['level-lite-model'])
    let paths = await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', field: 'paths', paths: '../etc' } })
    assert.equal(paths.status, 422)
    assert.deepEqual(autofocused(await paths.text()), ['config-paths'])
  })

  it('refuses a form from an older version (409): someone saved in between, nothing is overwritten', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn()
    assert.equal((await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', field: 'trigger', trigger: 'command' } })).status, 303)
    let stale = await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', ...BALANCED } })
    assert.equal(stale.status, 409)
    assert.match(await stale.text(), /The config changed in the meantime<\/strong> \(v1, changed by alex/)
    assert.deepEqual(rows[ORCHARD]!.config, { trigger: 'command' })
  })

  it('shows a member the config under « Lecture seule », with no form, and refuses their POST (403)', async () => {
    let { request, signIn, saves } = setup()
    let { cookie, csrf, html } = await signIn(CAMILLE)
    assert.match(html, /Read only<\/strong>/)
    assert.match(html, /anthropic\/claude-haiku-5\.5/)
    // REV-27: a member reads the provider and the model of the next job, with where they come from.
    assert.match(html, /Next job<\/span> <strong>OpenRouter · key of the service<\/strong>/)
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
    assert.match(levels, /from the org/)
    assert.doesNotMatch(levels, /Back to the org value<span class="visually-hidden"> for the level/)
    assert.equal((await request(`/repos/${ORCHARD}/config`, { cookie, form: { _csrf: csrf, version: '0', field: 'level', defaultLevel: 'lite' } })).status, 303)
    levels = await (await request(`/repos/${ORCHARD}/config?tab=levels`, { cookie })).text()
    assert.match(levels, /value="lite" checked/)
    assert.match(levels, /set for this repo/)
    let reset = await request(`/repos/${ORCHARD}/config/reset`, { cookie, form: { _csrf: csrf, version: '1', field: 'level' } })
    assert.equal(reset.status, 303)
    assert.deepEqual(rows[ORCHARD]!.config, {})
    assert.equal(rows[ORCHARD]!.defaultLevel, 'lite')
    assert.match(await (await request(`/repos/${ORCHARD}/config?tab=levels`, { cookie })).text(), /value="heavy" checked/)
  })

  it('names the tabs to come with « Bientôt » and no link (REV-32)', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn()
    let html = await (await request(`/repos/${ORCHARD}/config`, { cookie })).text()
    assert.doesNotMatch(html, /\?tab=rules"/)
    assert.doesNotMatch(html, /\?tab=assignment"/)
    assert.match(html, /<span class="config-tab-soon">Rules<span class="tag tag-quiet">Soon<\/span><span class="visually-hidden">: not available yet<\/span><\/span>/)
    assert.match(html, /<span class="config-tab-soon">Assignment<span class="tag tag-quiet">Soon<\/span><span class="visually-hidden">: not available yet<\/span><\/span>/)
  })

  it('shows the tabs to come empty, with no milestone name (REV-43)', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn()
    assert.match(await (await request(`/repos/${ORCHARD}/config?tab=rules`, { cookie })).text(), /come soon\./)
    assert.match(await (await request(`/repos/${ORCHARD}/config?tab=assignment`, { cookie })).text(), /come soon\./)
  })
})

describe('the « Default » provider in Config (REV-27)', () => {
  const DEFAULT_ID = '0f1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f'
  const catalog: ProviderCatalog = {
    list: async () => [
      serviceOption(true),
      {
        id: DEFAULT_ID,
        kind: 'anthropic',
        label: 'Anthropic of Sakuga',
        hint: 'Anthropic, default provider of the organization · key on the runner',
        isDefault: true,
        keyFrom: 'key on the runner',
        serviceHoldsKey: false,
        models: { lite: ['claude-haiku-4-5'] },
      },
    ],
  }

  it('a level without a choice shows the default provider, and « Set here » says that it fixes the choice', async () => {
    let { signIn } = setup({}, catalog)
    let { html } = await signIn()
    let lite = html.slice(html.indexOf('id="level-lite"'), html.indexOf('id="level-balanced"'))
    assert.match(lite, /<strong>Anthropic of Sakuga · key on the runner<\/strong> · <span class="mono">claude-haiku-4-5<\/span>, no fallback/)
    assert.match(lite, new RegExp(`<option value="${DEFAULT_ID}" selected>`))
    assert.match(lite, /fixes this choice for the repo, and the level no longer follows the (&quot;|")Default(&quot;|") provider/)
  })

  it('a level that the org chose shows no such warning', async () => {
    let { signIn } = setup({ models: { lite: { provider: 'service', model: 'anthropic/claude-haiku-5.5', fallback: null } } }, catalog)
    let { html } = await signIn()
    let lite = html.slice(html.indexOf('id="level-lite"'), html.indexOf('id="level-balanced"'))
    assert.match(lite, /chosen for the organization/)
    assert.doesNotMatch(lite, /no longer follows the/)
  })

  it('a level whose chosen provider was removed shows what runs and what the config names', async () => {
    let { signIn } = setup({ models: { lite: { provider: '9e1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f', model: 'claude-x', fallback: 'claude-y' } } }, catalog)
    let { html } = await signIn(CAMILLE)
    let lite = html.slice(html.indexOf('id="level-lite"'), html.indexOf('id="level-balanced"'))
    assert.match(lite, /the chosen provider no longer exists/)
    assert.match(lite, /\(the config names <span class="mono">claude-x<\/span>, fallback <span class="mono">claude-y<\/span>\)/)
  })
})
