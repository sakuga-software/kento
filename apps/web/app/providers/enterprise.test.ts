import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { presetById } from '@kento-review/engine/presets'

import { checkBaseUrl, readProviderForm } from './form.ts'
import { choiceById, choiceOf, choiceValues } from './presets.ts'
import { createProbe, probeUrl } from './probe.ts'

// KNT-206. The presets of Azure OpenAI and of Claude on Amazon Bedrock, on the form and in "Test".

const KEY = 'the-key-of-the-test-0123456789'

function form(values: Record<string, string>) {
  let data = new FormData()
  for (let [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

describe('the presets of the clouds on the form "Add a provider"', () => {
  it('fills the URL with its placeholder, and refuses it until the admin replaces it', () => {
    let values = choiceValues(choiceById('azure-openai')!, false)
    assert.equal(values.kind, 'openai_compatible')
    assert.equal(values.baseUrl, 'https://{resource}.openai.azure.com/openai/v1')
    assert.equal(checkBaseUrl('openai_compatible', values.baseUrl), 'Replace {resource} in the URL.')
    assert.equal(checkBaseUrl('anthropic', 'https://bedrock-runtime.{region}.amazonaws.com/anthropic'), 'Replace {region} in the URL.')
    let read = readProviderForm(form({ kind: values.kind, label: values.label, baseUrl: values.baseUrl, apiKey: KEY, models_lite: values.models.lite, models_balanced: values.models.balanced, models_heavy: values.models.heavy }))
    assert.equal(read.input, null)
    assert.equal(read.errors.baseUrl, 'Replace {resource} in the URL.')
    // After the error, the picker still shows Azure.
    assert.equal(choiceOf(read.values).id, 'azure-openai')
  })

  it('refuses the placeholder for a key that stays on the runner too: the form is the only way to store a URL', () => {
    for (let [kind, baseUrl, placeholder] of [
      ['openai_compatible', 'https://{resource}.openai.azure.com/openai/v1', '{resource}'],
      ['anthropic', 'https://bedrock-runtime.{region}.amazonaws.com/anthropic', '{region}'],
    ] as const) {
      let read = readProviderForm(form({ kind, label: 'Cloud', baseUrl, runnerHeld: 'on', models_lite: 'm', models_balanced: 'm', models_heavy: 'm' }))
      assert.equal(read.input, null, kind)
      assert.equal(read.errors.baseUrl, `Replace ${placeholder} in the URL.`)
    }
  })

  it('takes the URL of a resource, and the picker names Azure for it', () => {
    let values = choiceValues(choiceById('azure-openai')!, false)
    let read = readProviderForm(
      form({ kind: values.kind, label: values.label, baseUrl: 'https://contoso-ai.openai.azure.com/openai/v1', apiKey: KEY, models_lite: values.models.lite, models_balanced: values.models.balanced, models_heavy: values.models.heavy }),
    )
    assert.deepEqual(read.errors, {})
    assert.equal(read.input?.baseUrl, 'https://contoso-ai.openai.azure.com/openai/v1')
    assert.deepEqual(read.input?.models, { lite: ['gpt-6-luna'], balanced: ['gpt-6.1-terra', 'gpt-6-luna'], heavy: ['gpt-6-sol', 'gpt-6.1-terra'] })
    assert.equal(choiceOf(read.values).id, 'azure-openai')
  })

  it('makes Claude on Bedrock a provider of the kind Anthropic, with the Bedrock ids of the models', () => {
    let values = choiceValues(choiceById('bedrock-claude')!, false)
    assert.equal(values.kind, 'anthropic')
    let read = readProviderForm(
      form({ kind: values.kind, label: values.label, baseUrl: 'https://bedrock-runtime.eu-west-3.amazonaws.com/anthropic', apiKey: KEY, models_lite: values.models.lite, models_balanced: values.models.balanced, models_heavy: values.models.heavy }),
    )
    assert.deepEqual(read.errors, {})
    assert.deepEqual(read.input?.models, { lite: ['global.anthropic.claude-haiku-5-5'], balanced: ['global.anthropic.claude-sonnet-5-5'], heavy: ['global.anthropic.claude-opus-5-5'] })
    assert.equal(choiceOf(read.values).id, 'bedrock-claude')
  })
})

describe('"Test" a provider of a cloud', () => {
  const publicHost = async () => ['104.18.0.1']

  it('reads the models of an Azure resource on its v1 path, the key in Bearer', async () => {
    let calls: { url: string; headers: Record<string, string> }[] = []
    let fetch = (async (url: URL | string, init: RequestInit = {}) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> })
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch
    let result = await createProbe({ fetch, resolve: publicHost })({ kind: 'openai_compatible', baseUrl: 'https://contoso-ai.openai.azure.com/openai/v1', apiKey: KEY })
    assert.deepEqual(result, { outcome: 'ok' })
    assert.equal(calls[0]!.url, 'https://contoso-ai.openai.azure.com/openai/v1/models')
    assert.equal(calls[0]!.headers.Authorization, `Bearer ${KEY}`)
  })

  it('makes no call for Bedrock, and says that the first review tests the key', async () => {
    let fetch = (async () => {
      throw new Error('no call')
    }) as typeof globalThis.fetch
    let baseUrl = 'https://bedrock-runtime.us-east-1.amazonaws.com/anthropic'
    assert.equal(probeUrl('anthropic', baseUrl), null)
    let result = await createProbe({ fetch, resolve: publicHost })({ kind: 'anthropic', baseUrl, apiKey: KEY })
    assert.deepEqual(result, { outcome: 'failed', message: presetById('bedrock-claude')!.testNote! })
    // Anthropic itself keeps its test.
    assert.equal(probeUrl('anthropic', null), 'https://api.anthropic.com/v1/models')
  })
})
