import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { MAX_ASSIGNMENT_RULES, type AssignmentValues } from '../assignment/model.ts'
import type { AssignmentOutcome, AssignmentStore, AssignmentView } from '../assignment/store.ts'
import { CAMILLE, cookieOf, cookiesOf, fakeAuth, OCTOCAT, ORG, OTHER_ORG, SESSION_COOKIE } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import { serviceProviders } from '../repo-config/providers.ts'
import type { RepoConfigStore, RepoConfigView } from '../repo-config/store.ts'
import { createAppRouter } from '../router.ts'

const COOKIE = SESSION_COOKIE
const ORCHARD = '00000000-0000-4000-8000-000000000001'
const ELSEWHERE = '00000000-0000-4000-8000-000000000009'

function autofocused(html: string): string[] {
  return [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bautofocus\b[^>]*>/gi)].map((m) => /\bid="([^"]+)"/.exec(m[0])?.[1] ?? '?')
}

/** The assignment rules in memory, with the contract of app/assignment/store.ts. */
function memoryAssignment(repoOrg: Record<string, string>) {
  let rows: (AssignmentView & { repoId: string })[] = []
  let next = 1
  let ofRepo = (repoId: string) => rows.filter((r) => r.repoId === repoId).sort((a, b) => a.position - b.position)
  let store: AssignmentStore = {
    async list(orgId, repoId) {
      if (repoOrg[repoId] !== orgId) return []
      return ofRepo(repoId).map((row) => ({ ...row }))
    },
    async create(orgId, repoId, _userId, values: AssignmentValues): Promise<AssignmentOutcome> {
      if (repoOrg[repoId] !== orgId) return { kind: 'not_found' }
      let position = ofRepo(repoId).length + 1
      if (position > MAX_ASSIGNMENT_RULES) return { kind: 'full' }
      let id = `20000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
      rows.push({ id, repoId, position, ...values, createdBy: 'octocat' })
      return { kind: 'saved', id, position }
    },
    async move(orgId, repoId, ruleId, direction) {
      if (repoOrg[repoId] !== orgId) return { kind: 'not_found' }
      let rule = rows.find((r) => r.id === ruleId && r.repoId === repoId)
      if (!rule) return { kind: 'not_found' }
      let other = ofRepo(repoId).find((r) => r.position === rule.position + (direction === 'up' ? -1 : 1))
      if (other) [other.position, rule.position] = [rule.position, other.position]
      return { kind: 'saved', id: ruleId, position: rule.position }
    },
    async remove(orgId, repoId, ruleId) {
      if (repoOrg[repoId] !== orgId) return { kind: 'not_found' }
      let rule = rows.find((r) => r.id === ruleId && r.repoId === repoId)
      if (!rule) return { kind: 'not_found' }
      rows = rows.filter((r) => r !== rule)
      for (let r of rows) if (r.repoId === repoId && r.position > rule.position) r.position -= 1
      return { kind: 'removed', position: rule.position }
    },
  }
  return { store, rows: () => ofRepo(ORCHARD) }
}

function setup(options: { assignment?: boolean } = {}) {
  let auth = fakeAuth({ orgs: [ORG, OTHER_ORG] })
  auth.setRole(ORG, OCTOCAT, 'admin')
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
  let assignment = memoryAssignment({ [ORCHARD]: ORG.id, [ELSEWHERE]: OTHER_ORG.id })
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: auth.deps,
    repoConfig: { store: config, providers: serviceProviders },
    assignment: options.assignment === false ? null : assignment.store,
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

  async function signIn(profile = OCTOCAT) {
    auth.as(profile)
    let start = await request('/login/github')
    let state = new URL(start.headers.get('Location')!).searchParams.get('state')!
    let callback = await request(`/auth/github/callback?code=good&state=${state}`, { cookie: cookiesOf(start) })
    let cookie = cookieOf(callback, COOKIE)!
    let html = await (await request(`/repos/${ORCHARD}/config?tab=assignment`, { cookie })).text()
    let csrf = /name="_csrf" value="([0-9a-f]+)"/.exec(html)?.[1] ?? ''
    return { cookie, csrf, html }
  }

  return { request, signIn, rows: assignment.rows }
}

const AGENT = { authors: 'sakuga-agent[bot]', paths: '', labels: '', outcome: 'balanced', mention: '' }
const MIGRATIONS = { authors: '', paths: '**/migrations/**', labels: '', outcome: 'heavy', mention: 'octocat' }

describe('the tab Assignment of the Config screen (REV-21)', () => {
  it('opens the tab, with the default level of the repository as its last line and the form of a first rule', async () => {
    let { html } = await setup().signIn()
    assert.match(html, /<a href="\/repos\/[^"]+\/config\?tab=assignment" aria-current="page">Assignment<\/a>/)
    assert.doesNotMatch(html, /config-tab-soon">Assignment/)
    assert.match(html, /Assignment <span class="count">0<\/span>/)
    assert.match(html, /<p class="assignment-when">Else<\/p><p class="assignment-then">the preferences of the author if they have some, then the default level of the repo, <strong class="mono">lite<\/strong>/)
    assert.match(html, /<details id="assignment-new" open class="rule-new">/)
  })

  it('adds two rules, moves the second one up, then removes it: the order follows', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn()
    let added = await request(`/repos/${ORCHARD}/assignment`, { cookie, form: { _csrf: csrf, ...AGENT } })
    assert.equal(added.status, 303)
    let first = rows()[0]!
    assert.equal(added.headers.get('Location'), `/repos/${ORCHARD}/config?tab=assignment&assign=added&rule=${first.id}#assignment-${first.id}`)
    await request(`/repos/${ORCHARD}/assignment`, { cookie, form: { _csrf: csrf, ...MIGRATIONS } })
    let second = rows()[1]!
    assert.deepEqual({ level: second.level, mention: second.mention, paths: second.paths }, { level: 'heavy', mention: 'octocat', paths: ['**/migrations/**'] })

    let html = await (await request(added.headers.get('Location')!, { cookie })).text()
    assert.match(html, /Rule added last\./)
    assert.match(html, /If the author is sakuga-agent\[bot\]<\/p><p class="assignment-then">then <strong class="mono">balanced<\/strong>\.<\/p>/)
    assert.match(html, /If the PR changes \*\*\/migrations\/\*\*<\/p><p class="assignment-then">then <strong class="mono">heavy<\/strong>, and the review mentions <span class="mono">@octocat<\/span>\./)
    // The first rule cannot go up, the last one cannot go down.
    assert.match(html, /<button type="submit" disabled class="button button--outline">Move up<span class="visually-hidden"> rule 1<\/span>/)
    assert.match(html, /<button type="submit" disabled class="button button--outline">Move down<span class="visually-hidden"> rule 2<\/span>/)

    let moved = await request(`/repos/${ORCHARD}/assignment/${second.id}/move`, { cookie, form: { _csrf: csrf, direction: 'up' } })
    assert.equal(moved.status, 303)
    assert.deepEqual(rows().map((r) => r.id), [second.id, first.id])
    assert.match(await (await request(moved.headers.get('Location')!, { cookie })).text(), /Order saved\./)

    let removed = await request(`/repos/${ORCHARD}/assignment/${second.id}/remove`, { cookie, form: { _csrf: csrf } })
    assert.equal(removed.headers.get('Location'), `/repos/${ORCHARD}/config?tab=assignment&assign=removed#assignment`)
    assert.deepEqual(rows().map((r) => [r.id, r.position]), [[first.id, 1]])
  })

  it('sends a form with errors back with its values, and focuses its first field in error', async () => {
    let { request, signIn, rows } = setup()
    let { cookie, csrf } = await signIn()
    let response = await request(`/repos/${ORCHARD}/assignment`, { cookie, form: { _csrf: csrf, authors: '', paths: '/abs', labels: '', outcome: 'heavy', mention: '' } })
    assert.equal(response.status, 422)
    let html = await response.text()
    assert.deepEqual(autofocused(html), ['assignment-new-paths'])
    assert.match(html, /\/abs.{1,12}: a path starts without .{1,6}\/.{1,6}, from the root of the repo/)
    assert.match(html, />\/abs<\/textarea>/)
    assert.equal(rows().length, 0)
  })

  it('shows a member the rules without any form, and refuses a form of a member (403)', async () => {
    let { request, signIn, rows } = setup()
    let admin = await signIn()
    await request(`/repos/${ORCHARD}/assignment`, { cookie: admin.cookie, form: { _csrf: admin.csrf, ...AGENT } })
    let member = await signIn(CAMILLE)
    assert.match(member.html, /If the author is sakuga-agent\[bot\]/)
    assert.doesNotMatch(member.html, /New rule|Move up|Delete…/)
    let refused = await request(`/repos/${ORCHARD}/assignment`, { cookie: member.cookie, form: { _csrf: member.csrf, ...MIGRATIONS } })
    assert.equal(refused.status, 403)
    assert.equal(rows().length, 1)
  })

  it('refuses a rule for the repository of another org, and a form without CSRF', async () => {
    let { request, signIn } = setup()
    let { cookie, csrf } = await signIn()
    assert.equal((await request(`/repos/${ELSEWHERE}/assignment`, { cookie, form: { _csrf: csrf, ...AGENT } })).status, 404)
    assert.equal((await request(`/repos/${ORCHARD}/assignment`, { cookie, form: { ...AGENT } })).status, 403)
  })

  it('says "Soon" on a service without the assignment rules', async () => {
    let { request, signIn } = setup({ assignment: false })
    let { cookie, html } = await signIn()
    assert.match(html, /The assignment rules \(who triggers what, at which level\) come soon\./)
    let models = await (await request(`/repos/${ORCHARD}/config`, { cookie })).text()
    assert.match(models, /<span class="config-tab-soon">Assignment<span class="tag tag-quiet">Soon<\/span>/)
  })
})
