import { randomBytes } from 'node:crypto'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { CAMILLE, cookieOf, fakeAuth, ALEX, ORG, OTHER_ORG } from '../auth/test-helpers.ts'
import { disabledWebhook } from '../github/test-helpers.ts'
import type { Probe, ProbeResult } from '../providers/probe.ts'
import { createSecretBox, providerAad } from '../providers/secrets.ts'
import type { ProvidersStore, ProviderView } from '../providers/store.ts'
import { createAppRouter } from '../router.ts'
import { hour } from './format.ts'
import { providerState } from './settings.tsx'

const COOKIE = '__Host-kento_session'
const ID = '7f1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f'
const NOW = new Date('2026-10-29T10:00:00Z')
const KEY = 'sk-ant-api03-the-key-of-the-screen-test-abcd'

/** REV-28. The fields that the page focuses at load: the `id` of each element with `autofocus`. */
function autofocused(html: string): string[] {
  return [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bautofocus\b[^>]*>/gi)].map((m) => /\bid="([^"]+)"/.exec(m[0])?.[1] ?? '?')
}

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: ID,
    orgId: ORG.id,
    kind: 'anthropic',
    label: 'Anthropic of Sakuga',
    baseUrl: null,
    keyLast4: 'abcd',
    keySetAt: NOW,
    runnerHeld: false,
    isDefault: true,
    models: {},
    lastOkAt: null,
    refusedAt: null,
    refusedStatus: null,
    refusedMessage: null,
    createdAt: NOW,
    ...overrides,
  }
}

/** A store in memory that keeps the keys encrypted, as the real one, and records each write. */
function fakeStore(initial: ProviderView[] = []) {
  let box = createSecretBox(randomBytes(32))
  let rows = new Map(initial.map((p) => [p.id, { view: p, ciphertext: p.runnerHeld ? null : box.encrypt(KEY, providerAad(p)) }]))
  let writes: string[] = []
  let store: ProvidersStore = {
    async list(orgId) {
      return [...rows.values()].map((r) => r.view).filter((p) => p.orgId === orgId)
    },
    async add(input) {
      let view = provider({ ...input, id: '8f1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f', keyLast4: input.apiKey?.slice(-4) ?? null, runnerHeld: input.apiKey === null, isDefault: rows.size === 0 })
      rows.set(view.id, { view, ciphertext: input.apiKey ? box.encrypt(input.apiKey, providerAad(view)) : null })
      writes.push(`add ${input.orgId} ${input.kind}`)
      return view
    },
    async replaceKey(orgId, id, apiKey) {
      writes.push(`key ${orgId} ${id}`)
      let row = rows.get(id)
      if (!row || row.view.orgId !== orgId) return null
      row.ciphertext = box.encrypt(apiKey, providerAad(row.view))
      row.view = { ...row.view, keyLast4: apiKey.slice(-4), refusedAt: null, refusedStatus: null }
      return row.view
    },
    async setDefault(orgId, id) {
      writes.push(`default ${orgId} ${id}`)
      let row = rows.get(id)
      return row && row.view.orgId === orgId ? row.view : null
    },
    async remove(orgId, id) {
      writes.push(`remove ${orgId} ${id}`)
      let row = rows.get(id)
      if (!row || row.view.orgId !== orgId) return null
      rows.delete(id)
      return row.view
    },
    async withKey(orgId, id) {
      let row = rows.get(id)
      if (!row || row.view.orgId !== orgId) return null
      return { provider: row.view, apiKey: row.ciphertext ? box.decrypt(row.ciphertext, providerAad(row.view)) : null }
    },
    async recordOk(id) {
      writes.push(`ok ${id}`)
    },
    async recordRefused(id, status) {
      writes.push(`refused ${id} ${status}`)
    },
  }
  return { store, writes, rows }
}

function setup(initial: ProviderView[] = [], options: { probe?: ProbeResult; secretsConfigured?: boolean; serviceKey?: boolean } = {}) {
  let auth = fakeAuth({ orgs: [ORG, OTHER_ORG] })
  auth.setRole(ORG, ALEX, 'admin')
  auth.setRole(ORG, CAMILLE, 'member')
  let fake = fakeStore(initial)
  let probed: { kind: string; apiKey: string }[] = []
  let probe: Probe = async (target) => {
    probed.push(target)
    return options.probe ?? { outcome: 'ok' }
  }
  let router = createAppRouter({
    checkDatabase: async () => ({ status: 'ok', latencyMs: 1, migrations: 1 }),
    version: '1.2.3',
    commit: null,
    webhook: disabledWebhook,
    auth: { ...auth.deps, now: () => NOW.getTime() },
    providers: { store: fake.store, probe, secretsConfigured: options.secretsConfigured ?? true, serviceKey: options.serviceKey ?? true },
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

  return { ...fake, probed, request, signIn }
}

describe('the section "Providers and keys"', () => {
  it('shows the last 4 characters of a key, never the key, and the forms to an admin', async () => {
    let { request, signIn } = setup([provider({ lastOkAt: new Date(NOW.getTime() - 5 * 60_000) })])
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /Providers and keys/)
    assert.match(html, /Anthropic of Sakuga/)
    assert.match(html, /••••abcd/)
    assert.ok(!html.includes(KEY), 'the page never holds the key')
    assert.match(html, /Valid · last call/)
    assert.match(html, /5 min ago/)
    assert.doesNotMatch(html, / — /, 'no em dash between two parts of a sentence (REV-43)')
    assert.doesNotMatch(html, /of the org\b(?!anization)/, '"organization" in a sentence (REV-43)')
    assert.match(html, /claude-haiku-5-5/)
    assert.match(html, /Default/)
    assert.match(html, /action="\/settings\/providers\/7f1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f\/test"/)
    assert.match(html, /Replace the key/)
    assert.match(html, /Add the provider/)
    assert.match(html, /type="password"/)
  })

  it('shows a refused key with its status, its hour and a banner', async () => {
    let refusedAt = new Date('2026-10-29T08:40:00Z')
    let { request, signIn } = setup([provider({ refusedAt, refusedStatus: 401, refusedMessage: '401 invalid x-api-key' })])
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/settings', { cookie })).text()
    assert.equal(hour(refusedAt), '09:40')
    assert.match(html, /The key of (&quot;|")Anthropic of Sakuga(&quot;|") is refused \(401\) since <time[^>]*>09:40<\/time>/)
    assert.match(html, /Refused · 401 since/)
    assert.match(html, /The jobs of the organization fail/)
    assert.match(html, /Last answer: 401 invalid x-api-key/)
  })

  it('shows a provider that the runner holds as "Key on the runner", neutral, with no test', async () => {
    let { request, signIn } = setup([provider({ kind: 'ollama', runnerHeld: true, keyLast4: null, models: { lite: ['qwen3'], balanced: ['qwen3'], heavy: ['qwen3'] } })])
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /class="status status-neutral">Server of the runner/, 'a normal state is not amber (REV-31)')
    assert.match(html, /none, server of the runner/)
    assert.doesNotMatch(html, /\/test"/)
    assert.equal(providerState({ runnerHeld: true, refusedAt: null, lastOkAt: null }), 'runner')
  })

  it('shows the refusal that a runner got for a runner-held key, with its date and what to do (REV-31)', async () => {
    let refusedAt = new Date('2026-10-29T08:00:00Z')
    let { request, signIn } = setup([
      provider({
        kind: 'openai_compatible',
        label: 'Internal vLLM',
        baseUrl: 'https://llm.internal.example/v1',
        runnerHeld: true,
        keyLast4: null,
        keySetAt: null,
        models: { lite: ['qwen3'], balanced: ['qwen3'], heavy: ['qwen3'] },
        refusedAt,
        refusedStatus: 401,
        refusedMessage: '401 Invalid API key',
      }),
    ])
    assert.equal(providerState({ runnerHeld: true, refusedAt, lastOkAt: null }), 'refused')
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /role="alert"[^>]*><p><strong>The runner got 401 for the key of (&quot;|")Internal vLLM(&quot;|") since <time datetime="2026-10-29T08:00:00.000Z">09:00<\/time>/)
    assert.match(html, /class="status status-alert">Refused on the runner · 401 since/)
    assert.match(html, /Last answer: 401 Invalid API key/)
    assert.match(html, /Replace <span class="mono">PROVIDER_API_KEY<\/span> on the runners of the organization/)
    assert.doesNotMatch(html, /Replace the key/, 'the service has no key to replace')
  })

  it('marks a model without a price as a warning that says its effect on the limit (REV-31)', async () => {
    let { request, signIn } = setup([
      provider({ kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', models: { lite: ['qwen3'], balanced: ['qwen3'], heavy: ['qwen3'] } }),
    ])
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /<span class="tag tag-warn">no price: not counted in the cap<\/span>/)
  })

  it('shows a member the providers and no form', async () => {
    let { request, signIn } = setup([provider()])
    let { cookie } = await signIn(CAMILLE)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /••••abcd/)
    assert.doesNotMatch(html, /Add the provider/)
    assert.doesNotMatch(html, /\/settings\/providers\//)
  })

  it('refuses every form to a member, and writes nothing', async () => {
    let { request, signIn, writes } = setup([provider()])
    let { cookie, csrf } = await signIn(CAMILLE)
    for (let path of ['/settings/providers', `/settings/providers/${ID}/key`, `/settings/providers/${ID}/default`, `/settings/providers/${ID}/remove`, `/settings/providers/${ID}/test`]) {
      let response = await request(path, { cookie, form: { _csrf: csrf, kind: 'anthropic', label: 'x', apiKey: KEY } })
      assert.equal(response.status, 403, path)
    }
    assert.deepEqual(writes, [])
  })

  it('refuses a form without the CSRF token of the session', async () => {
    let { request, signIn, writes } = setup([provider()])
    let { cookie } = await signIn(ALEX)
    let response = await request(`/settings/providers/${ID}/remove`, { cookie, form: {} })
    assert.equal(response.status, 403)
    assert.deepEqual(writes, [])
  })

  it('adds a provider, and never writes the key in the redirect', async () => {
    let { request, signIn, writes } = setup([])
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request('/settings/providers', { cookie, form: { _csrf: csrf, kind: 'anthropic', label: 'Anthropic', apiKey: KEY } })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/settings?notice=added#provider-8f1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f')
    assert.deepEqual(writes, [`add ${ORG.id} anthropic`])
  })

  it('asks to test only a provider that "Test" can test: not a key on the runner, not Ollama (REV-51)', async () => {
    let { request, signIn } = setup([])
    let { cookie, csrf } = await signIn(ALEX)
    let held = await request('/settings/providers', { cookie, form: { _csrf: csrf, kind: 'anthropic', label: 'Anthropic', runnerHeld: 'on' } })
    assert.match(held.headers.get('Location') ?? '', /^\/settings\?notice=added_runner#provider-/)
    let ollama = await request('/settings/providers', {
      cookie,
      form: { _csrf: csrf, kind: 'ollama', label: 'GPU', baseUrl: 'http://gpu.lan:11434', models_lite: 'qwen3', models_balanced: 'qwen3', models_heavy: 'qwen3' },
    })
    assert.match(ollama.headers.get('Location') ?? '', /^\/settings\?notice=added_ollama#provider-/)
    for (let notice of ['added_runner', 'added_ollama']) {
      let html = await (await request(`/settings?notice=${notice}`, { cookie })).text()
      assert.match(html, /Provider added\./, notice)
      assert.doesNotMatch(html, /Test it/, notice)
    }
  })

  it('folds "Add a provider" behind a button, and opens it on an error (REV-29)', async () => {
    let { request, signIn } = setup([])
    let { cookie, csrf } = await signIn(ALEX)
    let page = await (await request('/settings', { cookie })).text()
    let toggle = /<section [^>]*id="new-provider"[^>]*>(<details[^>]*>)<summary class="button">/.exec(page)?.[1]
    assert.equal(toggle, '<details class="new-provider-toggle">', 'folded')
    // REV-91: no tab for the form; the button of the section opens it, and so does a link to #new-provider.
    assert.doesNotMatch(page, /<a href="#new-provider">/)
    assert.match(page, /src="\/assets\/settings\.js\?v=/)
    let response = await request('/settings/providers', { cookie, form: { _csrf: csrf, kind: 'anthropic', label: '', apiKey: KEY } })
    let open = /<section [^>]*id="new-provider"[^>]*>(<details[^>]*>)/.exec(await response.text())?.[1] ?? ''
    assert.match(open, /\bopen\b/)
  })

  it('gives a form with an error back without the key it held', async () => {
    let { request, signIn } = setup([])
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request('/settings/providers', { cookie, form: { _csrf: csrf, kind: 'anthropic', label: '', apiKey: KEY } })
    assert.equal(response.status, 422)
    let html = await response.text()
    assert.match(html, /A name of 1 to 60 characters/)
    assert.ok(!html.includes(KEY))
  })

  it('focuses the first field in error of "Add a provider", and announces that nothing was saved (REV-28)', async () => {
    let { request, signIn } = setup([])
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request('/settings/providers', { cookie, form: { _csrf: csrf, kind: 'openai_compatible', label: 'x', baseUrl: 'http://llm.example.com', apiKey: '' } })
    assert.equal(response.status, 422)
    let html = await response.text()
    assert.deepEqual(autofocused(html), ['provider-baseUrl'], 'the URL comes before the key in the form')
    assert.match(html, /role="alert"[^>]*><p><strong>Nothing is saved\.<\/strong> 3 fields to fix/)
    let page = await (await request('/settings', { cookie })).text()
    assert.deepEqual(autofocused(page), [], 'a page without error moves no focus')
    assert.doesNotMatch(page, /Nothing is saved/)
  })

  it('focuses the key of "Replace the key" after an error (REV-28)', async () => {
    let { request, signIn } = setup([provider()])
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request(`/settings/providers/${ID}/key`, { cookie, form: { _csrf: csrf, apiKey: 'short' } })
    assert.equal(response.status, 422)
    assert.deepEqual(autofocused(await response.text()), [`key-${ID}`])
  })

  it('says under "Type" what each type needs, not only Ollama (REV-28)', async () => {
    let { request, signIn } = setup([])
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/settings', { cookie })).text()
    for (let kind of ['Anthropic', 'OpenRouter', 'OpenAI-compatible', 'Ollama']) assert.match(html, new RegExp(`<li><strong>${kind}</strong>: `))
    assert.match(html, /aria-describedby="provider-kind-hint"/)
  })

  it('refuses a key when the service has no master key', async () => {
    let { request, signIn, writes } = setup([], { secretsConfigured: false })
    let { cookie, csrf } = await signIn(ALEX)
    let html = await (await request('/settings', { cookie })).text()
    assert.match(html, /KENTO_SECRETS_KEY/)
    let response = await request('/settings/providers', { cookie, form: { _csrf: csrf, kind: 'anthropic', label: 'A', apiKey: KEY } })
    assert.equal(response.status, 422)
    assert.deepEqual(writes, [])
    let held = await request('/settings/providers', { cookie, form: { _csrf: csrf, kind: 'anthropic', label: 'A', runnerHeld: 'on' } })
    assert.equal(held.status, 303)
  })

  it('tests a provider with its key, and records the answer', async () => {
    let ok = setup([provider()])
    let admin = await ok.signIn(ALEX)
    let response = await ok.request(`/settings/providers/${ID}/test`, { cookie: admin.cookie, form: { _csrf: admin.csrf } })
    assert.equal(response.headers.get('Location'), `/settings?notice=tested_ok#provider-${ID}`)
    assert.deepEqual(ok.probed, [{ kind: 'anthropic', baseUrl: null, apiKey: KEY }])
    assert.deepEqual(ok.writes, [`ok ${ID}`])

    let refused = setup([provider()], { probe: { outcome: 'refused', status: 401, message: '401 invalid x-api-key' } })
    let second = await refused.signIn(ALEX)
    await refused.request(`/settings/providers/${ID}/test`, { cookie: second.cookie, form: { _csrf: second.csrf } })
    assert.deepEqual(refused.writes, [`refused ${ID} 401`])

    let failed = setup([provider()], { probe: { outcome: 'failed', message: 'llm.example.com is on a private network, and the service does not call it.' } })
    let third = await failed.signIn(ALEX)
    let page = await failed.request(`/settings/providers/${ID}/test`, { cookie: third.cookie, form: { _csrf: third.csrf } })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /private network/)
    assert.deepEqual(failed.writes, [], 'a failed test changes nothing')
  })

  it('replaces a key, and a provider of another org is "missing"', async () => {
    let { request, signIn, writes } = setup([provider(), provider({ id: '9f1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f', orgId: OTHER_ORG.id })])
    let { cookie, csrf } = await signIn(ALEX)
    let response = await request(`/settings/providers/${ID}/key`, { cookie, form: { _csrf: csrf, apiKey: 'sk-ant-new-key-0123456789-wxyz' } })
    assert.equal(response.headers.get('Location'), `/settings?notice=replaced#provider-${ID}`)
    let other = await request('/settings/providers/9f1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f/key', { cookie, form: { _csrf: csrf, apiKey: 'sk-ant-new-key-0123456789-wxyz' } })
    assert.equal(other.headers.get('Location'), '/settings?notice=missing')
    assert.deepEqual(writes, [`key ${ORG.id} ${ID}`, `key ${ORG.id} 9f1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f`])
    let html = await (await request('/settings?notice=replaced', { cookie })).text()
    assert.match(html, /••••wxyz/)
  })

  it('says nothing that the URL writes, only a known notice', async () => {
    let { request, signIn } = setup([provider()])
    let { cookie } = await signIn(ALEX)
    let html = await (await request('/settings?notice=<script>&detail=Pirate', { cookie })).text()
    // The URL is only in the escaped `returnTo` of the theme form; no banner says it.
    assert.doesNotMatch(html, /role="status"/)
    assert.doesNotMatch(html, /<script>/)
  })
})
