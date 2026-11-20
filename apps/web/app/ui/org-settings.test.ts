import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, OCTOCAT, ORG, OTHER_ORG } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import type { AppStatus, ReadAppStatus } from '../org-settings/app-status.ts'
import type { OrgSettingsStore, OrgSettingsValues, OrgSettingsView } from '../org-settings/store.ts'
import { serviceOption, serviceProviders, type ProviderCatalog } from '../repo-config/providers.ts'
import { createAppRouter } from '../router.ts'

const COOKIE = '__Host-kento_session'
const NOW = new Date('2026-10-29T10:00:00Z')

function view(orgId: string, overrides: Partial<OrgSettingsView> = {}): OrgSettingsView {
  return {
    login: orgId === ORG.id ? 'sakuga-software' : 'orchard',
    githubInstallationId: orgId === ORG.id ? 1001 : 1002,
    suspendedAt: null,
    caps: { dailyCapUsd: null, monthlyCapUsd: null, alertPct: 80 },
    trustedBots: ['sakuga-agent[bot]'],
    config: {},
    version: 0,
    updatedBy: null,
    updatedAt: null,
    repos: { total: 4, enabled: 1 },
    costs: { dayUsd: 1.5, monthUsd: 12.25, dayByProvider: [{ providerId: null, label: 'Service key', usd: 1.5 }] },
    deliveries: {
      last: { deliveryId: 'd-2', event: 'pull_request', action: 'synchronize', status: 202, outcome: 'queued', reason: null, receivedAt: new Date(NOW.getTime() - 120_000) },
      lastPullRequest: { deliveryId: 'd-2', event: 'pull_request', action: 'synchronize', status: 202, outcome: 'queued', reason: null, receivedAt: new Date(NOW.getTime() - 120_000) },
      failures24h: 1,
      total24h: 9,
      lastFailure: { deliveryId: 'd-1', event: 'issue_comment', action: 'created', status: 500, outcome: 'failed', reason: 'database is down', receivedAt: new Date(NOW.getTime() - 3_600_000) },
    },
    ...overrides,
  }
}

const APP: AppStatus = {
  slug: 'kento-review',
  name: 'Kentō Review',
  htmlUrl: 'https://github.com/apps/kento-review',
  deliveriesUrl: 'https://github.com/organizations/sakuga-software/settings/apps/kento-review/advanced',
  webhook: { url: 'https://review.sakuga.dev/webhooks/github', sslVerified: true },
  installation: {
    permissions: { contents: 'read', pull_requests: 'write', issues: 'write', checks: 'write', members: 'read', metadata: 'read' },
    events: ['pull_request', 'issue_comment'],
    repositorySelection: 'all',
    suspendedAt: null,
    htmlUrl: 'https://github.com/organizations/sakuga-software/settings/installations/1001',
  },
}

/** The settings in memory, one row per org, with the same version rule as the real store. */
function fakeStore() {
  let rows: Record<string, OrgSettingsView> = { [ORG.id]: view(ORG.id), [OTHER_ORG.id]: view(OTHER_ORG.id) }
  let saves: { orgId: string; values: OrgSettingsValues }[] = []
  let store: OrgSettingsStore = {
    async read(orgId) {
      return rows[orgId] ? structuredClone(rows[orgId]) : null
    },
    async save(orgId, _userId, expectedVersion, change) {
      let row = rows[orgId]
      if (!row) return { kind: 'not_found' }
      if (row.version !== expectedVersion) return { kind: 'conflict', version: row.version, updatedBy: row.updatedBy, updatedAt: row.updatedAt }
      let next = change({ caps: { ...row.caps }, trustedBots: [...row.trustedBots], config: structuredClone(row.config) })
      Object.assign(row, next, { version: row.version + 1, updatedBy: 'octocat', updatedAt: NOW })
      saves.push({ orgId, values: next })
      return { kind: 'saved', version: row.version }
    },
    async trustedBotsFor() {
      return new Set()
    },
    async recordDelivery() {},
  }
  return { store, rows, saves }
}

function setup(app: Awaited<ReturnType<ReadAppStatus>> | null = { ok: true, status: APP }, providers: ProviderCatalog = serviceProviders) {
  let auth = fakeAuth({ orgs: [ORG, OTHER_ORG] })
  auth.setRole(ORG, OCTOCAT, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let fake = fakeStore()
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: 'abcdef1234567',
    webhook: disabledWebhook,
    auth: { ...auth.deps, now: () => NOW.getTime() },
    orgSettings: {
      store: fake.store,
      providers,
      readAppStatus: app ? async () => app : null,
      webhookUrl: 'https://review.sakuga.dev/webhooks/github',
      webhookSecret: true,
    },
  })

  function request(path: string, init: { cookie?: string | null; form?: Record<string, string> } = {}) {
    let headers = new Headers()
    if (init.cookie) headers.set('Cookie', init.cookie)
    return router.fetch(
      new Request(new URL(path, 'http://localhost'), { method: init.form ? 'POST' : 'GET', headers, body: init.form ? new URLSearchParams(init.form) : undefined }),
    )
  }

  async function signIn(profile = OCTOCAT) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: cookieOf(start, COOKIE) })
    let cookie = cookieOf(callback, COOKIE)!
    let html = await (await request('/settings', { cookie })).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
    return { cookie, csrf }
  }

  return { ...fake, request, signIn }
}


/** REV-28. The fields that the page focuses at load: the `id` of each element with `autofocus`. */
function autofocused(html: string): string[] {
  return [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bautofocus\b[^>]*>/gi)].map((m) => /\bid="([^"]+)"/.exec(m[0])?.[1] ?? '?')
}

describe('the settings of the org (REV-13)', () => {
  it('shows an admin the cost, the forms, the trusted bots and the state of the App', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(OCTOCAT)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /Cost cap/)
    assert.match(html, /\$1\.50/)
    assert.match(html, /Service key/)
    assert.match(html, /name="dailyCapUsd"/)
    assert.match(html, /Default values/)
    assert.match(html, /name="defaultLevel"/)
    assert.match(html, /sakuga-agent\[bot\]/)
    assert.match(html, /name="trustedBots"/)
    assert.match(html, /Everything is in place/)
    assert.match(html, /pull_request\.synchronize · 202 queued/)
    assert.match(html, /<strong>1<\/strong> of 9 deliveries/)
    assert.match(html, /Kentō did not process the delivery\. Redeliver it from the page of the App\./)
    assert.match(html, /<code class="mono">database is down<\/code>/)
    assert.match(html, /Redeliver from the page of the App/)
    assert.match(html, /settings\/apps\/kento-review\/advanced/)
    assert.match(html, /commit <span class="mono">abcdef123<\/span>/)
  })

  it('leads to each section from the top in one click, with one primary button per section at most (REV-29)', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(OCTOCAT)
    let html = await (await request('/settings', { cookie })).text()
    let nav = /<nav [^>]*aria-label="Sections of the settings"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? ''
    // KNT-149: a sidebar. The sections first, each one with the parts that have an anchor under it.
    let sectionsOnly = nav.replace(/<ul class="settings-nav-sub">.*?<\/ul>/gs, '')
    let anchors = [...sectionsOnly.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(anchors, ['cap', 'defaults', 'bots', 'app'])
    for (let id of anchors) assert.match(html, new RegExp(`<section [^>]*id="${id}"`), `the section #${id} is on the page`)
    let parts = [...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((id) => !anchors.includes(id))
    assert.deepEqual(parts, ['org-level', 'org-lite', 'org-balanced', 'org-heavy', 'app-installation', 'app-webhook', 'app-deliveries', 'app-permissions'])
    for (let id of parts) assert.match(html, new RegExp(`<(div|li|section|details) [^>]*id="${id}"`), `the part #${id} is on the page`)
    // The button that folds the list under 900 px controls the list, folded until settings.js opens it.
    assert.match(nav, /<button [^>]*aria-expanded="false"[^>]*aria-controls="settings-nav-list"/)
    assert.match(nav, /<ul [^>]*id="settings-nav-list"/)
    // Each section of the org: at most one primary button (the defaults have none, their rows are secondary).
    let sections = html.split('<section ').slice(1)
    assert.ok(sections.length >= 4)
    for (let section of sections) assert.ok((section.match(/button-primary/g) ?? []).length <= 1, section.slice(0, 120))
    assert.doesNotMatch(sections.find((s) => s.includes('id="defaults"'))!, /button-primary/)
  })

  it('has the four sections of its table of contents for a member, and without the state of the App (REV-29)', async () => {
    for (let [app, profile] of [[null, OCTOCAT], [null, CAMILLE], [undefined, CAMILLE]] as const) {
      let { request, signIn } = app === null ? setup(null) : setup()
      let { cookie } = await signIn(profile)
      let html = await (await request('/settings', { cookie })).text()
      for (let id of ['cap', 'defaults', 'bots', 'app']) {
        assert.match(html, new RegExp(`href="#${id}"`))
        assert.match(html, new RegExp(`<section [^>]*id="${id}"`), `#${id} for ${profile.login}, App ${app === null ? 'unknown' : 'known'}`)
      }
      // KNT-149: "Permissions and events" only when GitHub answered, as the part of the page.
      let known = app !== null
      assert.equal(/href="#app-permissions"/.test(html), known, `${profile.login}, App ${known ? 'known' : 'unknown'}`)
      assert.equal(/id="app-permissions"/.test(html), known)
    }
  })

  it('shows a member everything, read only', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(CAMILLE)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /Cost cap/)
    assert.match(html, /No daily cap/)
    assert.match(html, /sakuga-agent\[bot\]/)
    assert.match(html, /Everything is in place/)
    assert.doesNotMatch(html, /action="\/settings\/org/)
    assert.doesNotMatch(html, /name="trustedBots"/)
  })

  it('refuses every form to a member, and writes nothing', async () => {
    let { request, signIn, saves } = setup()
    let { cookie, csrf } = await signIn(CAMILLE)
    for (let [path, field] of [
      ['/settings/org', 'caps'],
      ['/settings/org', 'trustedBots'],
      ['/settings/org/reset', 'level'],
    ] as const) {
      let response = await request(path, { cookie, form: { _csrf: csrf, version: '0', field, dailyCapUsd: '0', alertPct: '80', trustedBots: 'evil[bot]' } })
      assert.equal(response.status, 403, `${path} ${field}`)
    }
    assert.deepEqual(saves, [])
  })

  it('refuses a form without the CSRF token, or from another site', async () => {
    let { request, signIn, saves } = setup()
    let { cookie } = await signIn(OCTOCAT)
    let response = await request('/settings/org', { cookie, form: { version: '0', field: 'caps', dailyCapUsd: '1', alertPct: '80' } })
    assert.equal(response.status, 403)
    assert.deepEqual(saves, [])
  })

  it('saves the limits, and the page says so', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)
    let response = await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'caps', dailyCapUsd: '0,01', monthlyCapUsd: '', alertPct: '75' } })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/settings?org=saved&v=1#cap')
    assert.deepEqual(rows[ORG.id]!.caps, { dailyCapUsd: 0.01, monthlyCapUsd: null, alertPct: 75 })
    assert.deepEqual(rows[OTHER_ORG.id]!.caps, { dailyCapUsd: null, monthlyCapUsd: null, alertPct: 80 }, 'the other org keeps its limits')
    let html = await (await request('/settings?org=saved&v=1', { cookie })).text()
    assert.match(html, /Settings saved/)
    assert.match(html, /Daily cap reached, \$1\.50 of \$0\.01/)
    assert.match(html, /settings v1, changed by octocat/)
  })

  it('warns from the alert percentage, under the limit', async () => {
    let { request, signIn, rows } = setup()
    rows[ORG.id]!.caps = { dailyCapUsd: 1.8, monthlyCapUsd: null, alertPct: 80 }
    let { cookie } = await signIn(OCTOCAT)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /Daily alert threshold reached/)
    assert.doesNotMatch(html, /Daily cap reached/)
  })

  it('shows the errors of the limits with the values typed, and writes nothing', async () => {
    let { request, signIn, saves } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)
    let response = await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'caps', dailyCapUsd: 'beaucoup', monthlyCapUsd: '-1', alertPct: '0' } })
    assert.equal(response.status, 422)
    let html = await response.text()
    assert.match(html, /name="dailyCapUsd" value="beaucoup"/)
    assert.match(html, /An amount in dollars/)
    assert.match(html, /A whole percentage, from 1 to 100/)
    assert.match(html, /aria-invalid="true"/)
    assert.deepEqual(saves, [])
    // REV-28: the page opens on the first field in error, and says that nothing was saved.
    assert.deepEqual(autofocused(html), ['cap-day'])
    assert.match(html, /Nothing is saved\.<\/strong> 3 fields to fix/)
  })

  it('focuses the first field in error of each form of the settings (REV-28)', async () => {
    let { request, signIn } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)
    let send = async (form: Record<string, string>) => autofocused(await (await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', ...form } })).text())
    assert.deepEqual(await send({ field: 'caps', dailyCapUsd: '', monthlyCapUsd: '', alertPct: '0' }), ['cap-alert'])
    assert.deepEqual(await send({ field: 'trustedBots', trustedBots: 'github.com/renovate' }), ['trusted-bots'])
    assert.deepEqual(await send({ field: 'models.heavy', provider: 'service', model: '', fallback: '' }), ['org-heavy-model'])
    assert.deepEqual(await send({ field: 'models.lite', provider: 'not-ours', model: 'x', fallback: '' }), ['org-lite-provider'])
  })

  it('saves the trusted bots in lowercase, and refuses a person', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)
    let refused = await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'trustedBots', trustedBots: 'renovate[bot]\ngithub.com/renovate' } })
    assert.equal(refused.status, 422)
    assert.match(await refused.text(), /is not the login of a bot/)
    let saved = await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'trustedBots', trustedBots: 'sakuga-agent[bot]\nRenovate' } })
    assert.equal(saved.status, 303)
    assert.equal(saved.headers.get('Location'), '/settings?org=saved&v=1#bots')
    assert.deepEqual(rows[ORG.id]!.trustedBots, ['sakuga-agent[bot]', 'renovate[bot]'])
  })

  it('saves a default level and the models of a level, then "Back to the Kentō value" removes one', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)
    assert.equal((await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'level', defaultLevel: 'balanced' } })).status, 303)
    assert.equal(
      (await request('/settings/org', { cookie, form: { _csrf: csrf, version: '1', field: 'models.heavy', provider: 'service', model: 'anthropic/claude-opus-5.5', fallback: '' } })).status,
      303,
    )
    assert.deepEqual(rows[ORG.id]!.config, { level: 'balanced', models: { heavy: { provider: 'service', model: 'anthropic/claude-opus-5.5', fallback: null } } })
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /set for the org/)
    assert.match(html, /Back to the Kentō value<span class="visually-hidden"> for heavy/)
    let reset = await request('/settings/org/reset', { cookie, form: { _csrf: csrf, version: '2', field: 'models.heavy' } })
    assert.equal(reset.status, 303)
    assert.equal(reset.headers.get('Location'), '/settings?org=reset&v=3#defaults')
    assert.deepEqual(rows[ORG.id]!.config, { level: 'balanced' })
  })

  it('refuses a model of a provider that the org does not have', async () => {
    let { request, signIn, saves } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)
    let response = await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'models.lite', provider: 'not-ours', model: 'x', fallback: '' } })
    assert.equal(response.status, 422)
    assert.match(await response.text(), /Choose a provider of the organization/)
    assert.deepEqual(saves, [])
  })

  it('refuses a form sent from an older version, and writes nothing', async () => {
    let { request, signIn, rows, saves } = setup()
    rows[ORG.id]!.version = 4
    rows[ORG.id]!.updatedBy = 'camille'
    let { cookie, csrf } = await signIn(OCTOCAT)
    let response = await request('/settings/org', { cookie, form: { _csrf: csrf, version: '3', field: 'caps', dailyCapUsd: '8', alertPct: '80' } })
    assert.equal(response.status, 409)
    assert.match(await response.text(), /The settings changed in the meantime<\/strong> \(v4, changed by camille/)
    assert.deepEqual(saves, [])
  })

  it('answers 400 to an unknown field, and to a reset of the limits', async () => {
    let { request, signIn } = setup()
    let { cookie, csrf } = await signIn(OCTOCAT)
    assert.equal((await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'suspendedAt' } })).status, 400)
    assert.equal((await request('/settings/org/reset', { cookie, form: { _csrf: csrf, version: '0', field: 'caps' } })).status, 400)
    assert.equal((await request('/settings/org', { cookie, form: { _csrf: csrf, version: 'x', field: 'caps' } })).status, 400)
  })

  it('names what the App lacks: a permission, an event, another webhook URL', async () => {
    let { request, signIn } = setup({
      ok: true,
      status: {
        ...APP,
        webhook: { url: 'https://old.example.dev/webhooks/github', sslVerified: false },
        installation: { ...APP.installation, permissions: { ...APP.installation.permissions, checks: 'read' }, events: ['pull_request'] },
      },
    })
    let { cookie } = await signIn(CAMILLE)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /4 items to fix/)
    assert.match(html, /Checks: write<span class="field-error">, granted: read/)
    assert.match(html, /issue_comment: not subscribed/)
    assert.match(html, /Kentō expects <span class="mono">https:\/\/review\.sakuga\.dev\/webhooks\/github/)
    assert.match(html, /SSL not verified/)
  })

  it('says when GitHub does not answer about the App', async () => {
    let { request, signIn } = setup({ ok: false, error: 'GET /app answered 401' })
    let { cookie } = await signIn(OCTOCAT)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /GitHub refused the key of the App, code 401\. Check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY on the service\./)
    assert.match(html, /<summary>Technical details<\/summary><code class="mono">GET \/app answered 401<\/code>/)
    assert.match(html, /GitHub state unknown/)
    assert.doesNotMatch(html, /Redeliver from the page/)
  })
})

describe('one rule for the provider of a level (REV-27)', () => {
  const DEFAULT_ID = '0f1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f'
  const runnerAnthropic = {
    id: DEFAULT_ID,
    kind: 'anthropic' as const,
    label: 'Anthropic of Sakuga',
    hint: 'Anthropic, default provider of the organization · key on the runner',
    isDefault: true,
    keyFrom: 'key on the runner',
    serviceHoldsKey: false,
    models: { lite: ['claude-haiku-4-5'] },
  }
  const catalog = (serviceKey: boolean): ProviderCatalog => ({ list: async () => [serviceOption(serviceKey), runnerAnthropic] })

  it('a level without a choice shows the "Default" provider, its key and its models, never "key of the service"', async () => {
    let { request, signIn } = setup(undefined, catalog(false))
    let { cookie } = await signIn(OCTOCAT)
    let html = await (await request('/settings', { cookie })).text()
    let lite = html.slice(html.indexOf('id="org-lite"'), html.indexOf('id="org-balanced"'))
    assert.match(lite, /Next job<\/span> <strong>Anthropic of Sakuga · key on the runner<\/strong> · <span class="mono">claude-haiku-4-5<\/span>/)
    assert.match(lite, /the (&quot;|")Default(&quot;|") provider of Providers and keys/)
    assert.match(lite, new RegExp(`<option value="${DEFAULT_ID}" selected>`), 'the form shows what runs')
    assert.match(lite, /the level no longer follows the (&quot;|")Default(&quot;|") provider/)
    // Without a key in the service, the OpenRouter option says "key on the runner", as its help.
    assert.match(html, /OpenRouter · key on the runner/)
    assert.doesNotMatch(html, /key of the service/)
    assert.doesNotMatch(html, /\$10 per day/, 'no level runs on the key of the service')
  })

  it('a level that chose OpenRouter says so, and the limit of the key of the service shows', async () => {
    let { request, signIn, rows } = setup(undefined, catalog(true))
    rows[ORG.id]!.config = { models: { heavy: { provider: 'service', model: 'anthropic/claude-opus-5.5', fallback: null } } }
    let { cookie } = await signIn(OCTOCAT)
    let html = await (await request('/settings', { cookie })).text()
    let heavy = html.slice(html.indexOf('id="org-heavy"'))
    assert.match(heavy, /<strong>OpenRouter · key of the service<\/strong> · <span class="mono">anthropic\/claude-opus-5.5<\/span>/)
    assert.match(heavy, /chosen for the organization, does not follow the (&quot;|")Default(&quot;|") provider/)
    assert.match(html, /The OpenRouter key of the service also has its own limit of \$10 per day/)
  })
})

