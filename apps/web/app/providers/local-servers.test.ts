import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { LOCAL_SERVERS } from '@kento-review/engine/presets'

import { keyFrom } from './catalog.ts'
import { checkBaseUrl, readProviderForm } from './form.ts'
import { choiceById, choiceOf, choiceValues, PROVIDER_CHOICES } from './presets.ts'
import { createProbe, probeUrl } from './probe.ts'

const KEY = 'sk-local-the-key-of-the-test-0123456789'

function form(values: Record<string, string>) {
  let data = new FormData()
  for (let [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

describe('KNT-205. the local servers (LM Studio, vLLM, llama.cpp)', () => {
  it('are choices of the picker after Ollama, each one an OpenAI-compatible server', () => {
    let ids = PROVIDER_CHOICES.map((choice) => choice.id)
    let ollama = ids.indexOf('ollama')
    assert.deepEqual(
      ids.slice(ollama + 1, ollama + 1 + LOCAL_SERVERS.length),
      LOCAL_SERVERS.map((server) => server.id),
    )
    for (let server of LOCAL_SERVERS) {
      let choice = choiceById(server.id)!
      assert.equal(choice.kind, 'openai_compatible')
      assert.equal(choice.local, server)
      assert.equal(choice.label, `${server.name}, on a server of a runner`)
    }
  })

  it('fill the name and the default URL, and the runner holds them, even when the service could keep a key', () => {
    let lmStudio = choiceById('lm-studio')!
    let values = choiceValues(lmStudio, false)
    assert.deepEqual(values, {
      kind: 'openai_compatible',
      label: 'LM Studio',
      baseUrl: 'http://localhost:1234/v1',
      runnerHeld: true,
      models: { lite: '', balanced: '', heavy: '' },
    })
    // After a form with an error, the picker finds the server again by its default URL.
    assert.equal(choiceOf(values).id, 'lm-studio')
    assert.equal(choiceOf({ kind: 'openai_compatible', baseUrl: 'http://gpu.lan:1234/v1' }).id, 'other')
  })

  it('take HTTP only for a server that the runner holds', () => {
    assert.equal(checkBaseUrl('openai_compatible', 'http://gpu.lan:8000/v1', true), null)
    assert.match(checkBaseUrl('openai_compatible', 'http://gpu.lan:8000/v1')!, /The key stays on the runner/)
    assert.match(checkBaseUrl('anthropic', 'http://proxy.lan', true)!, /https/)
    let models = { models_lite: 'qwen3-coder-30b', models_balanced: 'qwen3-coder-30b', models_heavy: 'qwen3-coder-30b' }
    let held = readProviderForm(form({ kind: 'openai_compatible', label: 'vLLM', baseUrl: 'http://gpu.lan:8000/v1', runnerHeld: 'on', ...models }))
    assert.deepEqual(held.errors, {})
    assert.equal(held.input?.apiKey, null)
    assert.equal(held.input?.baseUrl, 'http://gpu.lan:8000/v1')
    // With a key for the service: the service never keeps a key for an HTTP URL.
    let kept = readProviderForm(form({ kind: 'openai_compatible', label: 'vLLM', baseUrl: 'http://gpu.lan:8000/v1', apiKey: KEY, ...models }))
    assert.equal(kept.input, null)
    assert.match(kept.errors.baseUrl!, /HTTP only for a server on the network of a runner/)
  })

  it('are never called by the service: "Test" refuses HTTP and a private address, before any call', async () => {
    let calls = 0
    let fetch = (async () => {
      calls++
      return new Response('{}')
    }) as typeof globalThis.fetch
    let probe = createProbe({ fetch, resolve: async () => ['127.0.0.1'] })
    for (let server of LOCAL_SERVERS) {
      let result = await probe({ kind: 'openai_compatible', baseUrl: server.baseUrl, apiKey: KEY })
      assert.equal(result.outcome, 'failed', server.id)
      if (result.outcome === 'failed') assert.match(result.message, /only over HTTPS/)
    }
    // The same server behind TLS on a private network: refused too.
    let tls = await probe({ kind: 'openai_compatible', baseUrl: 'https://gpu.lan:8000/v1', apiKey: KEY })
    assert.equal(tls.outcome, 'failed')
    if (tls.outcome === 'failed') assert.match(tls.message, /private network/)
    assert.equal(calls, 0)
    assert.equal(probeUrl('openai_compatible', 'http://localhost:1234/v1'), 'http://localhost:1234/v1/models')
  })

  it('show on the Config screen as a server of the runner', () => {
    assert.equal(keyFrom({ kind: 'openai_compatible', runnerHeld: true, baseUrl: 'http://gpu.lan:8000/v1' }), 'server of the runner')
    assert.equal(keyFrom({ kind: 'openai_compatible', runnerHeld: true, baseUrl: 'https://llm.example.com/v1' }), 'key on the runner')
    assert.equal(keyFrom({ kind: 'ollama', runnerHeld: true, baseUrl: null }), 'server of the runner')
  })
})
