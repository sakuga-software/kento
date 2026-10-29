import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG, OTHER_ORG } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import type { AppStatus, ReadAppStatus } from '../org-settings/app-status.ts'
import type { OrgSettingsStore, OrgSettingsValues, OrgSettingsView } from '../org-settings/store.ts'
import { serviceProviders } from '../repo-config/providers.ts'
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
    costs: { dayUsd: 1.5, monthUsd: 12.25, dayByProvider: [{ providerId: null, label: 'Clé du service', usd: 1.5 }] },
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
      Object.assign(row, next, { version: row.version + 1, updatedBy: 'alex', updatedAt: NOW })
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

function setup(app: Awaited<ReturnType<ReadAppStatus>> | null = { ok: true, status: APP }) {
  let auth = fakeAuth({ orgs: [ORG, OTHER_ORG] })
  auth.setRole(ORG, ALEX, 'admin')
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
      providers: serviceProviders,
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

  async function signIn(profile = ALEX) {
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
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /Plafond de coût/)
    assert.match(html, /1,50\s\$/)
    assert.match(html, /Clé du service/)
    assert.match(html, /name="dailyCapUsd"/)
    assert.match(html, /Valeurs par défaut/)
    assert.match(html, /name="defaultLevel"/)
    assert.match(html, /sakuga-agent\[bot\]/)
    assert.match(html, /name="trustedBots"/)
    assert.match(html, /Tout est en place/)
    assert.match(html, /pull_request\.synchronize · 202 queued/)
    assert.match(html, /<strong>1<\/strong> sur 9 livraisons/)
    assert.match(html, /database is down/)
    assert.match(html, /Rejouer depuis la page de l’App/)
    assert.match(html, /settings\/apps\/kento-review\/advanced/)
    assert.match(html, /commit <span class="mono">abcdef123<\/span>/)
  })

  it('shows a member everything, read only', async () => {
    let { request, signIn } = setup()
    let { cookie } = await signIn(CAMILLE)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /Plafond de coût/)
    assert.match(html, /Aucun plafond par jour/)
    assert.match(html, /sakuga-agent\[bot\]/)
    assert.match(html, /Tout est en place/)
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
    let { cookie } = await signIn(ALEX)
    let response = await request('/settings/org', { cookie, form: { version: '0', field: 'caps', dailyCapUsd: '1', alertPct: '80' } })
    assert.equal(response.status, 403)
    assert.deepEqual(saves, [])
  })

  it('saves the limits, and the page says so', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'caps', dailyCapUsd: '0,01', monthlyCapUsd: '', alertPct: '75' } })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/settings?org=saved&v=1#plafond')
    assert.deepEqual(rows[ORG.id]!.caps, { dailyCapUsd: 0.01, monthlyCapUsd: null, alertPct: 75 })
    assert.deepEqual(rows[OTHER_ORG.id]!.caps, { dailyCapUsd: null, monthlyCapUsd: null, alertPct: 80 }, 'the other org keeps its limits')
    let html = await (await request('/settings?org=saved&v=1', { cookie })).text()
    assert.match(html, /Réglages enregistrés/)
    assert.match(html, /Plafond du jour atteint : 1,50\s\$ sur 0,01\s\$/)
    assert.match(html, /réglages v1, modifiés par alex/)
  })

  it('warns from the alert percentage, under the limit', async () => {
    let { request, signIn, rows } = setup()
    rows[ORG.id]!.caps = { dailyCapUsd: 1.8, monthlyCapUsd: null, alertPct: 80 }
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /Seuil d’alerte du jour atteint/)
    assert.doesNotMatch(html, /Plafond du jour atteint/)
  })

  it('shows the errors of the limits with the values typed, and writes nothing', async () => {
    let { request, signIn, saves } = setup()
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'caps', dailyCapUsd: 'beaucoup', monthlyCapUsd: '-1', alertPct: '0' } })
    assert.equal(response.status, 422)
    let html = await response.text()
    assert.match(html, /name="dailyCapUsd" value="beaucoup"/)
    assert.match(html, /Un montant en dollars/)
    assert.match(html, /Un pourcentage entier, de 1 à 100/)
    assert.match(html, /aria-invalid="true"/)
    assert.deepEqual(saves, [])
    // REV-28: the page opens on the first field in error, and says that nothing was saved.
    assert.deepEqual(autofocused(html), ['cap-day'])
    assert.match(html, /Rien n’est enregistré<\/strong> : 3 champs à corriger/)
  })

  it('focuses the first field in error of each form of the settings (REV-28)', async () => {
    let { request, signIn } = setup()
    let { cookie, csrf } = await signIn(ALEX)
    let send = async (form: Record<string, string>) => autofocused(await (await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', ...form } })).text())
    assert.deepEqual(await send({ field: 'caps', dailyCapUsd: '', monthlyCapUsd: '', alertPct: '0' }), ['cap-alert'])
    assert.deepEqual(await send({ field: 'trustedBots', trustedBots: 'github.com/renovate' }), ['trusted-bots'])
    assert.deepEqual(await send({ field: 'models.heavy', provider: 'service', model: '', fallback: '' }), ['org-heavy-model'])
    assert.deepEqual(await send({ field: 'models.lite', provider: 'not-ours', model: 'x', fallback: '' }), ['org-lite-provider'])
  })

  it('saves the trusted bots in lowercase, and refuses a person', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn(ALEX)
    let refused = await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'trustedBots', trustedBots: 'renovate[bot]\ngithub.com/renovate' } })
    assert.equal(refused.status, 422)
    assert.match(await refused.text(), /n’est pas le login d’un bot/)
    let saved = await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'trustedBots', trustedBots: 'sakuga-agent[bot]\nRenovate' } })
    assert.equal(saved.status, 303)
    assert.equal(saved.headers.get('Location'), '/settings?org=saved&v=1#bots')
    assert.deepEqual(rows[ORG.id]!.trustedBots, ['sakuga-agent[bot]', 'renovate[bot]'])
  })

  it('saves a default level and the models of a level, then « Revenir à Kentō » removes one', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn(ALEX)
    assert.equal((await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'level', defaultLevel: 'balanced' } })).status, 303)
    assert.equal(
      (await request('/settings/org', { cookie, form: { _csrf: csrf, version: '1', field: 'models.heavy', provider: 'service', model: 'anthropic/claude-opus-5.5', fallback: '' } })).status,
      303,
    )
    assert.deepEqual(rows[ORG.id]!.config, { level: 'balanced', models: { heavy: { provider: 'service', model: 'anthropic/claude-opus-5.5', fallback: null } } })
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /réglé pour l’org/)
    assert.match(html, /Revenir à Kentō<span class="visually-hidden"> pour heavy/)
    let reset = await request('/settings/org/reset', { cookie, form: { _csrf: csrf, version: '2', field: 'models.heavy' } })
    assert.equal(reset.status, 303)
    assert.equal(reset.headers.get('Location'), '/settings?org=reset&v=3#defauts')
    assert.deepEqual(rows[ORG.id]!.config, { level: 'balanced' })
  })

  it('refuses a model of a provider that the org does not have', async () => {
    let { request, signIn, saves } = setup()
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request('/settings/org', { cookie, form: { _csrf: csrf, version: '0', field: 'models.lite', provider: 'not-ours', model: 'x', fallback: '' } })
    assert.equal(response.status, 422)
    assert.match(await response.text(), /Choisissez un provider de l’org/)
    assert.deepEqual(saves, [])
  })

  it('refuses a form sent from an older version, and writes nothing', async () => {
    let { request, signIn, rows, saves } = setup()
    rows[ORG.id]!.version = 4
    rows[ORG.id]!.updatedBy = 'camille'
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request('/settings/org', { cookie, form: { _csrf: csrf, version: '3', field: 'caps', dailyCapUsd: '8', alertPct: '80' } })
    assert.equal(response.status, 409)
    assert.match(await response.text(), /Les réglages ont changé entre-temps<\/strong> \(v4, modifiés par camille/)
    assert.deepEqual(saves, [])
  })

  it('answers 400 to an unknown field, and to a reset of the limits', async () => {
    let { request, signIn } = setup()
    let { cookie, csrf } = await signIn(ALEX)
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
    assert.match(html, /4 points à corriger/)
    assert.match(html, /Checks : écriture<span class="field-error"> — accordé : lecture/)
    assert.match(html, /issue_comment : non abonné/)
    assert.match(html, /Kentō attend <span class="mono">https:\/\/review\.sakuga\.dev\/webhooks\/github/)
    assert.match(html, /SSL non vérifié/)
  })

  it('says when GitHub does not answer about the App', async () => {
    let { request, signIn } = setup({ ok: false, error: 'GET /app answered 401' })
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /GitHub n’a pas répondu sur l’App : GET \/app answered 401/)
    assert.match(html, /État GitHub inconnu/)
    assert.doesNotMatch(html, /Rejouer depuis la page/)
  })
})
