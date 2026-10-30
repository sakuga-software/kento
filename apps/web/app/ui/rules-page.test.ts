import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG, OTHER_ORG } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { serviceProviders } from '../repo-config/providers.ts'
import type { RepoConfigStore, RepoConfigView } from '../repo-config/store.ts'
import type { RuleValues } from '../rules/model.ts'
import { MAX_RULES, type RuleOutcome, type RulesStore, type RuleView } from '../rules/store.ts'
import { createAppRouter } from '../router.ts'

const COOKIE = '__Host-kento_session'
const ORCHARD = '00000000-0000-4000-8000-000000000001'
const ELSEWHERE = '00000000-0000-4000-8000-000000000009'

/** REV-28. The fields that the page focuses at load: the `id` of each element with `autofocus`. */
function autofocused(html: string): string[] {
  return [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bautofocus\b[^>]*>/gi)].map((m) => /\bid="([^"]+)"/.exec(m[0])?.[1] ?? '?')
}

/** The rules in memory, with the same contract as app/rules/store.ts. */
function memoryRules(repoOrg: Record<string, string>) {
  let rows: (RuleView & { orgId: string })[] = []
  let next = 1
  let id = () => `10000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
  let find = (orgId: string, ruleId: string) => rows.find((r) => r.id === ruleId && r.orgId === orgId)
  let store: RulesStore = {
    async list(orgId, repoId) {
      return rows.filter((r) => r.orgId === orgId && r.repoId === repoId).map((r) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== 'orgId')) as unknown as RuleView)
    },
    async activeOrgRules(orgId) {
      return rows.filter((r) => r.orgId === orgId && r.repoId === null && r.active).length
    },
    async create(orgId, repoId, _userId, values: RuleValues): Promise<RuleOutcome> {
      if (repoId !== null && repoOrg[repoId] !== orgId) return { kind: 'not_found' }
      if (rows.filter((r) => r.orgId === orgId && r.repoId === repoId).length >= MAX_RULES) return { kind: 'full' }
      let rule = { id: id(), orgId, repoId, ...values, active: true, disabledBy: null, disabledAt: null, version: 1, updatedBy: 'alex', updatedAt: new Date('2026-10-30T09:00:00Z') }
      rows.push(rule)
      return { kind: 'saved', id: rule.id, title: rule.title, version: 1, repoId }
    },
    async update(orgId, ruleId, _userId, version, values) {
      let rule = find(orgId, ruleId)
      if (!rule) return { kind: 'not_found' }
      if (rule.version !== version) return { kind: 'conflict', id: ruleId, version: rule.version, updatedBy: rule.updatedBy, updatedAt: rule.updatedAt }
      Object.assign(rule, values, { version: rule.version + 1 })
      return { kind: 'saved', id: ruleId, title: rule.title, version: rule.version, repoId: rule.repoId }
    },
    async setActive(orgId, ruleId, _userId, version, active) {
      let rule = find(orgId, ruleId)
      if (!rule) return { kind: 'not_found' }
      if (rule.version !== version) return { kind: 'conflict', id: ruleId, version: rule.version, updatedBy: rule.updatedBy, updatedAt: rule.updatedAt }
      Object.assign(rule, { active, disabledBy: active ? null : 'alex', disabledAt: active ? null : new Date('2026-10-30T09:12:00Z'), version: rule.version + 1 })
      return { kind: 'saved', id: ruleId, title: rule.title, version: rule.version, repoId: rule.repoId }
    },
    async remove(orgId, ruleId) {
      let rule = find(orgId, ruleId)
      if (!rule) return null
      rows = rows.filter((r) => r !== rule)
      return { title: rule.title, repoId: rule.repoId }
    },
  }
  return { store, rows: () => rows }
}

function setup(options: { config?: boolean } = {}) {
  let auth = fakeAuth({ orgs: [ORG, OTHER_ORG] })
  auth.setRole(ORG, ALEX, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let repo = (id: string, orgId: string, fullName: string): RepoConfigView & { orgId: string } => ({
    orgId,
    id,
    fullName,
    enabled: true,
    defaultLevel: 'lite',
    config: {},
    orgConfig: {},
    version: 0,
    updatedBy: null,
    updatedAt: null,
    spentThisMonthUsd: 0,
    trustedBots: [],
  })
  let repos = { [ORCHARD]: repo(ORCHARD, ORG.id, 'sakuga-software/orchard'), [ELSEWHERE]: repo(ELSEWHERE, OTHER_ORG.id, 'orchard/app') }
  let config: RepoConfigStore = {
    async read(orgId, repoId) {
      let row = repos[repoId as keyof typeof repos]
      return row && row.orgId === orgId ? { ...row } : null
    },
    async save() {
      return { kind: 'not_found' }
    },
  }
  let rules = memoryRules({ [ORCHARD]: ORG.id, [ELSEWHERE]: OTHER_ORG.id })
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: auth.deps,
    repoConfig: options.config === false ? null : { store: config, providers: serviceProviders },
    rules: rules.store,
  })

  function request(path: string, init: { cookie?: string | null; form?: Record<string, string> } = {}) {
    let headers = new Headers()
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
    let html = await (await request(options.config === false ? '/settings' : `/repos/${ORCHARD}/config?tab=rules`, { cookie })).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
    return { cookie, csrf, html }
  }

  return { request, signIn, rules }
}

const FK_RULE = { title: 'Toute migration drizzle a un index pour chaque FK', body: 'Chaque clé étrangère a son index.', paths: '**/migrations/**', severityFloor: 'major' }

describe('the rules of a repository and of the org (REV-19)', () => {
  it('opens the tab Règles, with what else goes to the model', async () => {
    let { signIn } = setup()
    let { html } = await signIn()
    assert.match(html, /<a href="\/repos\/[^"]+\/config\?tab=rules" aria-current="page">Règles<\/a>/)
    assert.doesNotMatch(html, /config-tab-soon">Règles/)
    assert.match(html, /Règles de orchard <span class="count">0<\/span>/)
    assert.match(html, /Aucune règle pour ce repo\./)
    assert.match(html, /Part aussi au modèle/)
    assert.match(html, /<a href="\/settings#regles">Aucune règle d’org<\/a>/)
    assert.match(html, /<span class="mono">CLAUDE\.md<\/span> et <span class="mono">AGENTS\.md<\/span>/)
    assert.match(html, /jamais du code d’une PR/)
    // An empty list opens the form of a new rule.
    assert.match(html, /<details id="repo-rule-new" open class="rule-new">/)
  })

  it('adds a rule of the repository, then edits, disables and removes it', async () => {
    let { request, signIn, rules } = setup()
    let { cookie, csrf } = await signIn()
    let added = await request('/rules', { cookie, form: { _csrf: csrf, repo: ORCHARD, ...FK_RULE } })
    assert.equal(added.status, 303)
    let rule = rules.rows()[0]!
    assert.deepEqual({ repoId: rule.repoId, paths: rule.paths, floor: rule.severityFloor }, { repoId: ORCHARD, paths: ['**/migrations/**'], floor: 'major' })
    assert.equal(added.headers.get('Location'), `/repos/${ORCHARD}/config?rules=added&rule=${rule.id}&tab=rules#rule-${rule.id}`)

    let html = await (await request(added.headers.get('Location')!, { cookie })).text()
    assert.match(html, /Règle ajoutée\./)
    assert.match(html, new RegExp(`<li id="rule-${rule.id}"[^>]*class="rule"><details open class="rule-details">`))
    assert.match(html, /<span class="tag tag-quiet mono">\*\*\/migrations\/\*\*<\/span><span class="tag tag-info">au moins P1<\/span>/)

    let saved = await request(`/rules/${rule.id}`, { cookie, form: { _csrf: csrf, repo: ORCHARD, version: '1', ...FK_RULE, title: 'Index des FK' } })
    assert.equal(saved.status, 303)
    assert.equal(rules.rows()[0]!.title, 'Index des FK')

    // A form from version 1 again: someone saved in between, nothing is written.
    let stale = await request(`/rules/${rule.id}`, { cookie, form: { _csrf: csrf, repo: ORCHARD, version: '1', ...FK_RULE, title: 'Autre' } })
    assert.match(stale.headers.get('Location')!, /rules=conflict/)
    assert.equal(rules.rows()[0]!.title, 'Index des FK')

    let disabled = await request(`/rules/${rule.id}/active`, { cookie, form: { _csrf: csrf, repo: ORCHARD, version: '2', active: 'false' } })
    assert.equal(disabled.status, 303)
    html = await (await request(disabled.headers.get('Location')!, { cookie })).text()
    assert.match(html, /Règle désactivée : elle ne part plus au modèle\./)
    assert.match(html, /<span class="tag tag-warn">désactivée par alex le 30 oct\. à 10:12<\/span>/)
    assert.match(html, />Réactiver<span class="visually-hidden"> la règle Index des FK<\/span>/)

    let removed = await request(`/rules/${rule.id}/remove?repo=${ORCHARD}`, { cookie, form: { _csrf: csrf } })
    assert.equal(removed.headers.get('Location'), `/repos/${ORCHARD}/config?rules=removed&tab=rules#rules`)
    assert.equal(rules.rows().length, 0)
  })

  it('sends a form with errors back with its values, and focuses its first field in error', async () => {
    let { request, signIn, rules } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request('/rules', { cookie, form: { _csrf: csrf, repo: ORCHARD, title: '  ', body: 'Texte', paths: '/abs\n**/ok/**', severityFloor: 'info' } })
    assert.equal(response.status, 422)
    let html = await response.text()
    assert.match(html, /Rien n’est enregistré<\/strong> : 3 champs à corriger/)
    assert.deepEqual(autofocused(html), ['repo-rule-new-title'])
    assert.match(html, /« \/abs » : un chemin commence sans « \/ »/)
    assert.match(html, />Texte<\/textarea>/)
    assert.equal(rules.rows().length, 0)
  })

  it('shows a member the rules without any form, and refuses a form of a member', async () => {
    let { request, signIn } = setup()
    let admin = await signIn()
    await request('/rules', { cookie: admin.cookie, form: { _csrf: admin.csrf, repo: ORCHARD, ...FK_RULE } })
    let member = await signIn(CAMILLE)
    assert.doesNotMatch(member.html, /action="\/rules/)
    assert.match(member.html, /<dd class="rule-body">Chaque clé étrangère a son index\.<\/dd>/)
    let refused = await request('/rules', { cookie: member.cookie, form: { _csrf: member.csrf, repo: ORCHARD, ...FK_RULE } })
    assert.equal(refused.status, 403)
  })

  it('writes no rule of a repository on a service without the Config screen, valid form or not', async () => {
    let { request, signIn, rules } = setup({ config: false })
    let { cookie, csrf } = await signIn()
    for (let form of [FK_RULE, { ...FK_RULE, title: '' }]) {
      let response = await request('/rules', { cookie, form: { _csrf: csrf, repo: ORCHARD, ...form } })
      assert.equal(response.status, 404)
    }
    assert.equal(rules.rows().length, 0)
  })

  it('counts the disabled rules in the limit, and says to remove one', async () => {
    let { request, signIn, rules } = setup()
    let { cookie, csrf } = await signIn()
    for (let i = 0; i < MAX_RULES; i++) await rules.store.create(ORG.id, ORCHARD, 'u', { title: `R${i}`, body: 'x', paths: [], severityFloor: null })
    let first = rules.rows()[0]!
    await rules.store.setActive(ORG.id, first.id, 'u', 1, false)
    let full = await request('/rules', { cookie, form: { _csrf: csrf, repo: ORCHARD, ...FK_RULE } })
    assert.match(full.headers.get('Location')!, /rules=full/)
    let html = await (await request(full.headers.get('Location')!, { cookie })).text()
    assert.match(html, /50 règles au plus ici, désactivées comprises : supprimez-en une d’abord\./)
    assert.doesNotMatch(html, /désactivez ou supprimez/)
  })

  it('counts an emoji for two in the limits of the form, and says so', async () => {
    let { request, signIn, rules } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request('/rules', { cookie, form: { _csrf: csrf, repo: ORCHARD, ...FK_RULE, title: '🙂'.repeat(150) } })
    assert.equal(response.status, 422)
    assert.match(await response.text(), /200 caractères au plus ; un emoji compte pour deux\./)
    assert.equal(rules.rows().length, 0)
  })

  it('shows a rule that no job sends, written outside the screens, with what to fix', async () => {
    let { request, signIn, rules } = setup()
    let { cookie } = await signIn()
    await rules.store.create(ORG.id, ORCHARD, 'u', { title: '🙂'.repeat(150), body: 'x', paths: [], severityFloor: null })
    await rules.store.create(ORG.id, ORCHARD, 'u', { title: 'Motifs', body: 'x', paths: ['x'.repeat(301)], severityFloor: null })
    await rules.store.create(ORG.id, ORCHARD, 'u', { title: 'Valide', body: 'x', paths: ['src/**'], severityFloor: null })
    let html = await (await request(`/repos/${ORCHARD}/config?tab=rules`, { cookie })).text()
    assert.equal([...html.matchAll(/<span class="tag tag-alert">jamais envoyée<\/span>/g)].length, 2)
    assert.match(html, /son titre dépasse 200 caractères ou son texte 4\s000 \(un emoji compte pour deux\)/)
    assert.match(html, /aucun de ses chemins n’est valide/)
  })

  it('never adds a rule to a repository of another org', async () => {
    let { request, signIn, rules } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request('/rules', { cookie, form: { _csrf: csrf, repo: ELSEWHERE, ...FK_RULE } })
    assert.equal(response.status, 404)
    assert.equal(rules.rows().length, 0)
  })

  it('writes the rules of the org in the settings, in their own section of the table of contents', async () => {
    let { request, signIn, rules } = setup()
    let { cookie, csrf } = await signIn()
    let added = await request('/rules', { cookie, form: { _csrf: csrf, repo: '', ...FK_RULE, paths: '' } })
    let rule = rules.rows()[0]!
    assert.equal(rule.repoId, null)
    assert.equal(added.headers.get('Location'), `/settings?rules=added&rule=${rule.id}#rule-${rule.id}`)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /<section id="regles"[^>]*class="card config-card"/)
    assert.match(html, /Règles d’org <span class="count">1<\/span>/)
    assert.match(html, /<span class="tag tag-quiet mono">tous les chemins<\/span>/)
    // The Config screen of a repository counts it.
    let config = await (await request(`/repos/${ORCHARD}/config?tab=rules`, { cookie })).text()
    assert.match(config, /<a href="\/settings#regles">1 règle d’org active<\/a>/)
  })
})
