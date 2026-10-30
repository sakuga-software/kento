import { defaultModels } from '@sakuga-review/engine/levels'
import { isProviderKind, LEVELS, MODEL_ID, type Level, type ProviderKind } from '@sakuga-review/protocol'

import type { ProviderModels } from '../db/schema.ts'

export const KIND_LABELS: Record<ProviderKind, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai_compatible: 'Compatible OpenAI',
  ollama: 'Ollama',
}

/** A key: printable, no space, 8 to 500 characters (the protocol carries up to 500). */
const KEY = /^[\x21-\x7e]{8,500}$/

export type ProviderField = 'kind' | 'label' | 'baseUrl' | 'apiKey' | 'models'

/** The form « Ajouter un provider », as typed. The key is never sent back to the browser. */
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
    return 'Une URL complète, par exemple https://llm.example.com/v1.'
  }
  let schemes = kind === 'ollama' ? ['https:', 'http:'] : ['https:']
  if (!schemes.includes(url.protocol)) return kind === 'ollama' ? 'Une URL en http:// ou https://.' : 'Une URL en https:// : la clé passe dans un en-tête.'
  if (url.username || url.password) return 'Sans identifiant ni mot de passe dans l’URL : la clé va dans son champ.'
  if (url.search || url.hash) return 'Sans paramètre ni fragment.'
  if (value.length > 300) return '300 caractères au plus.'
  return null
}

function readModels(text: string): string[] | null {
  let models = [...new Set(text.split(/[\s,]+/).filter(Boolean))]
  if (models.length > 5 || models.some((model) => !MODEL_ID.test(model))) return null
  return models
}

/** Checks the form « Ajouter un provider ». Returns the input, or a message per field. */
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

  if (kindValue !== kind) errors.kind = 'Choisissez le type de provider.'
  if (label.length < 1 || label.length > 60) errors.label = 'Un nom de 1 à 60 caractères.'
  if (baseUrl) {
    let problem = checkBaseUrl(kind, baseUrl)
    if (problem) errors.baseUrl = problem
  } else if (kind === 'openai_compatible') {
    errors.baseUrl = 'Un serveur compatible OpenAI a besoin de son URL.'
  }
  if (!runnerHeld && !KEY.test(apiKey)) errors.apiKey = 'La clé : 8 à 500 caractères, sans espace.'

  let models: ProviderModels = {}
  for (let level of LEVELS) {
    let list = readModels(modelsText[level])
    if (list === null) {
      errors.models = 'Au plus 5 modèles par niveau, séparés par des virgules, en lettres, chiffres et . _ : / @ -.'
      continue
    }
    if (list.length > 0) models[level] = list
  }
  if (!errors.models && LEVELS.some((level) => !models[level] && defaultModels(kind, level).length === 0)) {
    errors.models = `${KIND_LABELS[kind]} n’a pas de modèle par défaut : nommez au moins un modèle pour chaque niveau.`
  }

  let values = { kind, label, baseUrl, runnerHeld, models: modelsText }
  let ok = Object.keys(errors).length === 0
  return {
    values,
    input: ok ? { kind, label, baseUrl: baseUrl || null, apiKey: runnerHeld ? null : apiKey, models } : null,
    errors,
  }
}

/** The form « Remplacer la clé ». */
export function readKeyForm(form: FormData | undefined): { apiKey: string | null; error: string | null } {
  let apiKey = String(form?.get('apiKey') ?? '').trim()
  return KEY.test(apiKey) ? { apiKey, error: null } : { apiKey: null, error: 'La clé : 8 à 500 caractères, sans espace.' }
}
