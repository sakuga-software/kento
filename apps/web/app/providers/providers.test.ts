import { randomBytes } from 'node:crypto'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { PROVIDER_PRESETS, RESERVED_PRESET_IDS } from '@kento-review/engine/presets'

import { checkBaseUrl, readKeyForm, readProviderForm } from './form.ts'
import { choiceById, choiceOf, choiceValues, PROVIDER_CHOICES, presetName } from './presets.ts'
import { createProbe, privateAddress, probeUrl, readHead } from './probe.ts'
import { createSecretBox, masterKeyId, providerAad, readMasterKeys, SecretsError } from './secrets.ts'
import { refusalMessage, type ProvidersStore } from './store.ts'
import { createConfigProviders } from './catalog.ts'

const KEY = 'sk-ant-api03-the-key-of-the-test-0123456789'
const ROW = { id: '7f1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f', orgId: '0b9c4a52-3f1e-4c55-9a43-2f1a3f0f6b11' }

describe('the encryption of the keys', () => {
  it('gives the key back with the master key and the row, and holds no part of it', () => {
    let box = createSecretBox(randomBytes(32))
    let ciphertext = box.encrypt(KEY, providerAad(ROW))
    assert.match(ciphertext, /^v1:[0-9a-f]{16}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)
    assert.ok(!ciphertext.includes(KEY.slice(-12)))
    assert.equal(box.decrypt(ciphertext, providerAad(ROW)), KEY)
    // A fresh IV each time: two encryptions of one key differ.
    assert.notEqual(box.encrypt(KEY, providerAad(ROW)), ciphertext)
  })

  it('refuses a ciphertext copied to another row or another org, or changed by one byte', () => {
    let box = createSecretBox(randomBytes(32))
    let ciphertext = box.encrypt(KEY, providerAad(ROW))
    assert.throws(() => box.decrypt(ciphertext, providerAad({ ...ROW, orgId: '11111111-1111-4111-8111-111111111111' })), SecretsError)
    assert.throws(() => box.decrypt(ciphertext, providerAad({ ...ROW, id: '22222222-2222-4222-8222-222222222222' })), SecretsError)
    let parts = ciphertext.split(':')
    let body = Buffer.from(parts[3]!, 'base64url')
    body[0] = body[0]! ^ 1
    parts[3] = body.toString('base64url')
    assert.throws(() => box.decrypt(parts.join(':'), providerAad(ROW)), SecretsError)
    assert.throws(() => box.decrypt('plain-text-key', providerAad(ROW)), SecretsError)
  })

  it('reads a key of an earlier master key during a rotation, and says it is stale', () => {
    let old = randomBytes(32)
    let current = randomBytes(32)
    let before = createSecretBox(old).encrypt(KEY, providerAad(ROW))
    let box = createSecretBox(current, [old])
    assert.equal(box.decrypt(before, providerAad(ROW)), KEY)
    assert.ok(box.isStale(before))
    assert.ok(!box.isStale(box.encrypt(KEY, providerAad(ROW))))
    // Without the old key, the error names the key id, never a value.
    let error = (() => {
      try {
        createSecretBox(current).decrypt(before, providerAad(ROW))
      } catch (e) {
        return e as Error
      }
    })()!
    assert.match(error.message, new RegExp(`master key ${masterKeyId(old)} is not configured`))
    assert.ok(!error.message.includes(KEY))
  })

  it('reads the master keys of the environment, and names a wrong variable without its value', () => {
    assert.equal(readMasterKeys({}), null)
    let current = randomBytes(32).toString('base64')
    let previous = randomBytes(32).toString('base64')
    let keys = readMasterKeys({ KENTO_SECRETS_KEY: current, KENTO_SECRETS_PREVIOUS_KEYS: ` ${previous} ,` })!
    assert.equal(keys.current.length, 32)
    assert.equal(keys.previous.length, 1)
    for (let env of [{ KENTO_SECRETS_KEY: 'too-short-secret' }, { KENTO_SECRETS_KEY: current, KENTO_SECRETS_PREVIOUS_KEYS: 'nope-not-a-key' }]) {
      let error = (() => {
        try {
          readMasterKeys(env)
        } catch (e) {
          return e as Error
        }
      })()!
      assert.ok(error instanceof SecretsError)
      assert.ok(!error.message.includes('too-short-secret') && !error.message.includes('nope-not-a-key'))
    }
  })
})

describe('the form "Add a provider"', () => {
  function form(values: Record<string, string>) {
    let data = new FormData()
    for (let [key, value] of Object.entries(values)) data.set(key, value)
    return data
  }

  it('reads an Anthropic provider with its key and the default models', () => {
    let read = readProviderForm(form({ kind: 'anthropic', label: 'Anthropic of Sakuga', apiKey: KEY, models_lite: '', models_balanced: '', models_heavy: '' }))
    assert.deepEqual(read.errors, {})
    assert.deepEqual(read.input, { kind: 'anthropic', label: 'Anthropic of Sakuga', baseUrl: null, apiKey: KEY, models: {} })
  })

  it('needs a URL and the models of each level for a server of the OpenAI API', () => {
    let read = readProviderForm(form({ kind: 'openai_compatible', label: 'vLLM', apiKey: KEY, models_lite: 'qwen3' }))
    assert.equal(read.input, null)
    assert.ok(read.errors.baseUrl)
    assert.match(read.errors.models!, /Name at least one model for each level/)
    let ok = readProviderForm(
      form({ kind: 'openai_compatible', label: 'vLLM', baseUrl: 'https://llm.example.com/v1', apiKey: KEY, models_lite: 'qwen3, qwen3', models_balanced: 'a', models_heavy: 'b,c' }),
    )
    assert.deepEqual(ok.input?.models, { lite: ['qwen3'], balanced: ['a'], heavy: ['b', 'c'] })
  })

  it('takes no key for Ollama, nor for a key that stays on the runner', () => {
    let ollama = readProviderForm(form({ kind: 'ollama', label: 'GPU', baseUrl: 'http://gpu.lan:11434', models_lite: 'q', models_balanced: 'q', models_heavy: 'q', apiKey: KEY }))
    assert.equal(ollama.input?.apiKey, null)
    let held = readProviderForm(form({ kind: 'anthropic', label: 'A', runnerHeld: 'on' }))
    assert.equal(held.input?.apiKey, null)
    assert.ok(readProviderForm(form({ kind: 'anthropic', label: 'A', apiKey: 'short' })).errors.apiKey)
    assert.ok(readProviderForm(form({ kind: 'anthropic', label: 'A', apiKey: 'has a space inside' })).errors.apiKey)
  })

  it('refuses a model id of the wrong form for the kind, with what the kind expects (REV-66)', () => {
    let wrong = readProviderForm(form({ kind: 'anthropic', label: 'A', apiKey: KEY, models_heavy: 'claude-opus-5-5, anthropic/claude-opus-5.5' }))
    assert.equal(wrong.input, null)
    assert.equal(
      wrong.errors.models,
      'heavy: "anthropic/claude-opus-5.5". Anthropic expects its own id, without "anthropic/", for example claude-sonnet-5-5.',
    )
    let openrouter = readProviderForm(form({ kind: 'openrouter', label: 'O', apiKey: KEY, models_lite: 'claude-haiku-5-5' }))
    assert.match(openrouter.errors.models!, /^lite: "claude-haiku-5-5"\. OpenRouter expects the vendor before the model/)

    let right = readProviderForm(form({ kind: 'anthropic', label: 'A', apiKey: KEY, models_heavy: 'claude-opus-5-5' }))
    assert.deepEqual(right.errors, {})
    assert.deepEqual(right.input?.models, { heavy: ['claude-opus-5-5'] })
    // The kinds whose ids have no fixed form take both.
    let compatible = readProviderForm(
      form({ kind: 'openai_compatible', label: 'vLLM', baseUrl: 'https://llm.example.com/v1', apiKey: KEY, models_lite: 'meta-llama/Llama-4', models_balanced: 'qwen3', models_heavy: 'q' }),
    )
    assert.deepEqual(compatible.errors, {})
  })

  it('never sends the key back in the values of the form', () => {
    let read = readProviderForm(form({ kind: 'anthropic', label: '', apiKey: KEY }))
    assert.ok(!JSON.stringify(read.values).includes(KEY))
  })

  it('refuses a base URL with credentials, a query, or HTTP for a provider with a key', () => {
    assert.match(checkBaseUrl('anthropic', 'http://proxy.example.com')!, /https/)
    assert.equal(checkBaseUrl('ollama', 'http://gpu.lan:11434'), null)
    assert.ok(checkBaseUrl('openai_compatible', 'https://user:pass@llm.example.com'))
    assert.ok(checkBaseUrl('openai_compatible', 'https://llm.example.com/v1?key=x'))
    assert.ok(checkBaseUrl('openai_compatible', 'not a url'))
    assert.ok(readProviderForm(form({ kind: 'anthropic', label: 'A', apiKey: KEY, models_lite: '--help' })).errors.models)
  })

  it('reads the form "Replace the key"', () => {
    assert.equal(readKeyForm(form({ apiKey: ` ${KEY} ` })).apiKey, KEY)
    assert.ok(readKeyForm(form({ apiKey: '' })).error)
  })
})

describe('"Test" a provider', () => {
  function fetchAnswering(status: number, body = '{}') {
    let calls: { url: string; headers: Record<string, string>; redirect?: string }[] = []
    let fetch = (async (url: URL | string, init: RequestInit = {}) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string>, redirect: init.redirect })
      return new Response(body, { status })
    }) as typeof globalThis.fetch
    return { fetch, calls }
  }
  const publicHost = async () => ['104.18.0.1']

  it('reads the models of Anthropic with the key, without following a redirect', async () => {
    let { fetch, calls } = fetchAnswering(200)
    let result = await createProbe({ fetch, resolve: publicHost })({ kind: 'anthropic', baseUrl: null, apiKey: KEY })
    assert.deepEqual(result, { outcome: 'ok' })
    assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/models')
    assert.equal(calls[0]!.headers['x-api-key'], KEY)
    assert.equal(calls[0]!.redirect, 'manual')
  })

  it('tells a refused key, with the message of the provider and never the key', async () => {
    let { fetch } = fetchAnswering(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }))
    let result = await createProbe({ fetch, resolve: publicHost })({ kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', apiKey: KEY })
    assert.equal(result.outcome, 'refused')
    if (result.outcome !== 'refused') return
    assert.equal(result.status, 401)
    assert.ok(!refusalMessage(result.message).includes(KEY.slice(4)), 'the screen never shows the key that the provider quotes')
  })

  it('shows the message of a long JSON error, as the API of OpenAI writes it', async () => {
    let body = JSON.stringify(
      {
        error: {
          message: 'Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com/account/api-keys.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_api_key',
          request_id: 'req_0123456789abcdef0123456789abcdef',
          documentation_url: 'https://platform.openai.com/docs/guides/error-codes/api-errors',
        },
      },
      null,
      4,
    )
    assert.ok(body.length > 300, `${body.length} characters: the cut at 300 broke this JSON`)
    let { fetch } = fetchAnswering(401, body)
    let result = await createProbe({ fetch, resolve: publicHost })({ kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', apiKey: KEY })
    assert.equal(result.outcome, 'refused')
    if (result.outcome === 'refused') assert.match(result.message, /^401 Incorrect API key provided/)
  })

  it('never sends a key to a private, loopback or link-local address', async () => {
    let { fetch, calls } = fetchAnswering(200)
    for (let host of [['127.0.0.1'], ['10.0.0.5'], ['169.254.169.254'], ['192.168.1.2'], ['::1'], ['fd00::1'], ['::ffff:127.0.0.1'], ['104.18.0.1', '10.0.0.1']]) {
      let result = await createProbe({ fetch, resolve: async () => host })({ kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', apiKey: KEY })
      assert.equal(result.outcome, 'failed', host.join(','))
    }
    assert.equal(calls.length, 0)
    // An IPv6 address that carries an IPv4 one, in any written form, is judged by that IPv4.
    for (let address of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:0001', '::7f00:1', '64:ff9b::a9fe:a9fe', 'fe80::1', 'ff02::1', 'not-an-ip']) {
      assert.ok(privateAddress(address), address)
    }
    assert.ok(!privateAddress('::ffff:6812:1'), '104.18.0.1, mapped')
    let viaUrl = await createProbe({ fetch, resolve: publicHost })({ kind: 'openai_compatible', baseUrl: 'https://[::ffff:7f00:1]/v1', apiKey: KEY })
    assert.equal(viaUrl.outcome, 'failed')
    assert.equal(calls.length, 0)
    assert.ok(!privateAddress('104.18.0.1'))
    assert.ok(!privateAddress('2606:4700::1'))
  })

  it('judges the IPv6 forms that carry an IPv4 by that IPv4, and refuses NAT64 local and Teredo (REV-130)', () => {
    for (let address of ['::ffff:0:7f00:1', '::ffff:0:a00:1', '2002:7f00:1::', '2002:a9fe:a9fe::', '64:ff9b:1::7f00:1', '64:ff9b:1::6812:1', '2001:0:4136:e378::1']) {
      assert.ok(privateAddress(address), address)
    }
    assert.ok(!privateAddress('2002:6812:1::'), '6to4 of 104.18.0.1')
    assert.ok(!privateAddress('2001:4860:4860::8888'), 'a global address in 2001::/16, out of Teredo')
  })

  it('refuses 192.0.0.0/24, the protocol assignments of the IETF, in each form (REV-130)', () => {
    for (let address of ['192.0.0.1', '192.0.0.170', '192.0.0.255', '::ffff:192.0.0.9', '::ffff:c000:9', '2002:c000:9::', '64:ff9b::c000:9']) {
      assert.ok(privateAddress(address), address)
    }
    // Its neighbours stay public: 192.0.1.0/24 is routed.
    assert.ok(!privateAddress('192.0.1.1'))
    assert.ok(!privateAddress('192.1.0.1'))
  })

  it('reads at most the head of the body of an answer, and cancels the rest', async () => {
    let pulled = 0
    let endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024).fill(120))
      },
    })
    let text = await readHead(new Response(endless, { status: 401 }), 4096)
    assert.equal(text.length, 4096)
    assert.ok(pulled <= 6, `read ${pulled} chunks of an endless body`)
    let fetch = (async () => new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(1024).fill(120)) }), { status: 401 })) as typeof globalThis.fetch
    let result = await createProbe({ fetch, resolve: async () => ['104.18.0.1'] })({ kind: 'anthropic', baseUrl: null, apiKey: KEY })
    assert.equal(result.outcome, 'refused', 'an endless body ends the probe')
  })

  it('answers "ok" from the status alone, without reading the body of the answer', async () => {
    // A body that gives one byte a second: reading 4 KB of it would take over an hour.
    // The probe cancels the body: the cancel stops the timer, else it writes to a closed stream.
    let timer: ReturnType<typeof setTimeout> | undefined
    let fetch = (async () =>
      new Response(
        new ReadableStream({
          pull: (c) => new Promise<void>((r) => (timer = setTimeout(() => (c.enqueue(new Uint8Array(1)), r()), 1000))),
          cancel: () => clearTimeout(timer),
        }),
        { status: 200 },
      )) as typeof globalThis.fetch
    let started = Date.now()
    let result = await createProbe({ fetch, resolve: async () => ['104.18.0.1'] })({ kind: 'anthropic', baseUrl: null, apiKey: KEY })
    assert.deepEqual(result, { outcome: 'ok' })
    assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms on a slow body`)
  })

  it('cannot test Ollama from the service: its server is on the network of a runner', async () => {
    assert.equal(probeUrl('ollama', 'http://gpu.lan:11434'), null)
    assert.equal(probeUrl('openrouter', null), 'https://openrouter.ai/api/v1/key')
  })
})

describe('the presets of "Add a provider" (KNT-204)', () => {
  function form(values: Record<string, string>) {
    let data = new FormData()
    for (let [key, value] of Object.entries(values)) data.set(key, value)
    return data
  }

  it('offers each preset, then the types with their own API and the local servers, then "Other OpenAI-compatible server"', () => {
    let ids = PROVIDER_CHOICES.map((choice) => choice.id)
    assert.deepEqual(ids.slice(0, PROVIDER_PRESETS.length), PROVIDER_PRESETS.map((preset) => preset.id))
    // KNT-205: LM Studio, vLLM and llama.cpp after Ollama.
    assert.deepEqual(ids.slice(PROVIDER_PRESETS.length), ['anthropic', 'openrouter', 'ollama', 'lm-studio', 'vllm', 'llama-cpp', 'other'])
    assert.equal(new Set(ids).size, ids.length)
    for (let preset of PROVIDER_PRESETS) assert.ok(!(RESERVED_PRESET_IDS as readonly string[]).includes(preset.id), preset.id)
    assert.equal(choiceById('constructor'), null)
    assert.equal(choiceById(null), null)
  })

  it('fills the form from a preset, and the form reads it back as a valid OpenAI-compatible provider', () => {
    for (let preset of PROVIDER_PRESETS) {
      let values = choiceValues(choiceById(preset.id)!, false)
      assert.equal(values.kind, 'openai_compatible')
      assert.equal(values.label, preset.name)
      assert.equal(values.baseUrl, preset.baseUrl)
      assert.equal(values.models.heavy, preset.models.heavy.join(', '))
      let read = readProviderForm(
        form({ kind: values.kind, label: values.label, baseUrl: values.baseUrl, apiKey: KEY, models_lite: values.models.lite, models_balanced: values.models.balanced, models_heavy: values.models.heavy }),
      )
      assert.deepEqual(read.errors, {}, preset.id)
      assert.deepEqual(read.input?.models, { lite: [...preset.models.lite], balanced: [...preset.models.balanced], heavy: [...preset.models.heavy] })
      // The picker finds the preset again from the values, after an error too.
      assert.equal(choiceOf(values).id, preset.id)
    }
  })

  it('fills only the type and its name for Anthropic, OpenRouter and Ollama, and nothing for "Other"', () => {
    let anthropic = choiceValues(choiceById('anthropic')!, false)
    assert.deepEqual({ kind: anthropic.kind, label: anthropic.label, baseUrl: anthropic.baseUrl, lite: anthropic.models.lite }, { kind: 'anthropic', label: 'Anthropic', baseUrl: '', lite: '' })
    let ollama = choiceValues(choiceById('ollama')!, false)
    assert.equal(ollama.label, 'Ollama')
    assert.equal(ollama.runnerHeld, true, 'Ollama needs no key')
    let other = choiceValues(choiceById('other')!, true)
    assert.deepEqual({ kind: other.kind, label: other.label, baseUrl: other.baseUrl, runnerHeld: other.runnerHeld }, { kind: 'openai_compatible', label: '', baseUrl: '', runnerHeld: true })
    assert.equal(choiceOf({ kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1' }).id, 'other')
    assert.equal(choiceOf({ kind: 'openrouter', baseUrl: '' }).id, 'openrouter')
  })

  it('names the preset of a provider by its base URL, also one added before the presets', () => {
    let [first] = PROVIDER_PRESETS
    assert.equal(presetName({ kind: 'openai_compatible', baseUrl: `${first!.baseUrl}/` }), first!.name)
    assert.equal(presetName({ kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1' }), null)
    assert.equal(presetName({ kind: 'anthropic', baseUrl: null }), null)
  })

  it('names the preset on the Config screen of a repository', async () => {
    let [first] = PROVIDER_PRESETS
    let row = { id: ROW.id, orgId: ROW.orgId, label: 'Ours', keyLast4: 'abcd', keySetAt: null, runnerHeld: false, isDefault: true, models: {}, lastOkAt: null, refusedAt: null, refusedStatus: null, refusedMessage: null, createdAt: new Date() }
    let store = { list: async () => [{ ...row, kind: 'openai_compatible' as const, baseUrl: first!.baseUrl }, { ...row, id: 'x', isDefault: false, kind: 'openai_compatible' as const, baseUrl: 'https://llm.example.com/v1' }] } as unknown as ProvidersStore
    let options = await createConfigProviders(store, { serviceKey: true }).list(ROW.orgId)
    assert.match(options[1]!.hint, new RegExp(`^${first!.name}, default provider of the organization · `))
    assert.match(options[2]!.hint, /^OpenAI-compatible · /)
  })

  it('tests a preset on the path of its list of models', () => {
    for (let preset of PROVIDER_PRESETS) assert.equal(probeUrl('openai_compatible', `${preset.baseUrl}/`), `${preset.baseUrl}${preset.modelsPath}`)
    assert.equal(probeUrl('openai_compatible', 'https://llm.example.com/v1/'), 'https://llm.example.com/v1/models')
  })
})
