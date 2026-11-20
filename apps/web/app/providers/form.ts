import { defaultModels } from '@kento-review/engine/levels'
import { isProviderKind, LEVELS, MODEL_ID, type Level, type ProviderKind } from '@kento-review/protocol'

import type { ProviderModels } from '../db/schema.ts'
import { idFormHelp } from '../repo-config/model.ts'

export const KIND_LABELS: Record<ProviderKind, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai_compatible: 'OpenAI-compatible',
  ollama: 'Ollama',
}

/** A key: printable, no space, 8 to 500 characters (the protocol carries up to 500). */
const KEY = /^[\x21-\x7e]{8,500}$/

export type ProviderField = 'kind' | 'label' | 'baseUrl' | 'apiKey' | 'models'

/** The form "Add a provider", as typed. The key is never sent back to the browser. */
export interface ProviderFormValues {
  kind: ProviderKind
  label: string
  baseUrl: string
  runnerHeld: boolean
  models: Record<Level, string>
}

export interface ProviderInput {
  kind: ProviderKind
  label: string
  baseUrl: string | null
  /** Null: the runner holds it. */
  apiKey: string | null
  models: ProviderModels
}

/**
 * A base URL that the service or a runner may call: HTTPS with a host, no user or password in it,
 * no query, no fragment. Ollama may be HTTP: it runs on the network of a runner.
 */
export function checkBaseUrl(kind: ProviderKind, value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'A full URL, for example https://llm.example.com/v1.'
  }
  let schemes = kind === 'ollama' ? ['https:', 'http:'] : ['https:']
  if (!schemes.includes(url.protocol)) return kind === 'ollama' ? 'A URL with http:// or https://.' : 'A URL with https://. The key goes in a header.'
  if (url.username || url.password) return 'No user name or password in the URL. The key goes in its own field.'
  if (url.search || url.hash) return 'No query string and no fragment.'
  if (value.length > 300) return '300 characters at most.'
  return null
}

function readModels(text: string): string[] | null {
  let models = [...new Set(text.split(/[\s,]+/).filter(Boolean))]
  if (models.length > 5 || models.some((model) => !MODEL_ID.test(model))) return null
  return models
}

/** Checks the form "Add a provider". Returns the input, or a message per field. */
export function readProviderForm(form: FormData | undefined): {
  values: ProviderFormValues
  input: ProviderInput | null
  errors: Partial<Record<ProviderField, string>>
} {
  let kindValue = String(form?.get('kind') ?? '')
  let kind: ProviderKind = isProviderKind(kindValue) ? kindValue : 'anthropic'
  let label = String(form?.get('label') ?? '').trim()
  let baseUrl = String(form?.get('baseUrl') ?? '').trim()
  let apiKey = String(form?.get('apiKey') ?? '').trim()
  // Ollama needs no key: its server is on the network of a runner.
  let runnerHeld = kind === 'ollama' || form?.get('runnerHeld') === 'on'
  let modelsText = Object.fromEntries(LEVELS.map((level) => [level, String(form?.get(`models_${level}`) ?? '').trim()])) as Record<Level, string>
  let errors: Partial<Record<ProviderField, string>> = {}

  if (kindValue !== kind) errors.kind = 'Choose the type of provider.'
  if (label.length < 1 || label.length > 60) errors.label = 'A name of 1 to 60 characters.'
  if (baseUrl) {
    let problem = checkBaseUrl(kind, baseUrl)
    if (problem) errors.baseUrl = problem
  } else if (kind === 'openai_compatible') {
    errors.baseUrl = 'An OpenAI-compatible server needs its URL.'
  }
  if (!runnerHeld && !KEY.test(apiKey)) errors.apiKey = 'The key: 8 to 500 characters, with no space.'

  let models: ProviderModels = {}
  for (let level of LEVELS) {
    let list = readModels(modelsText[level])
    if (list === null) {
      errors.models = 'At most 5 models per level, separated by commas, with letters, digits and . _ : / @ -.'
      continue
    }
    // REV-66. The rule of the forms of the levels (#66): an id that this kind answers 404 to.
    let wrong = list.find((model) => idFormHelp(kind, model) !== null)
    if (wrong !== undefined && !errors.models) errors.models = `${level}: "${wrong}". ${idFormHelp(kind, wrong)}`
    if (list.length > 0) models[level] = list
  }
  if (!errors.models && LEVELS.some((level) => !models[level] && defaultModels(kind, level).length === 0)) {
    errors.models = `${KIND_LABELS[kind]} has no default model. Name at least one model for each level.`
  }

  let values = { kind, label, baseUrl, runnerHeld, models: modelsText }
  let ok = Object.keys(errors).length === 0
  return {
    values,
    input: ok ? { kind, label, baseUrl: baseUrl || null, apiKey: runnerHeld ? null : apiKey, models } : null,
    errors,
  }
}

/** The form "Replace the key". */
export function readKeyForm(form: FormData | undefined): { apiKey: string | null; error: string | null } {
  let apiKey = String(form?.get('apiKey') ?? '').trim()
  return KEY.test(apiKey) ? { apiKey, error: null } : { apiKey: null, error: 'The key: 8 to 500 characters, with no space.' }
}
