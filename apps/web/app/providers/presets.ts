import {
  LOCAL_SERVERS,
  localServerById,
  localServerOf,
  presetById,
  presetOf,
  PROVIDER_PRESETS,
  type LocalServer,
  type ProviderPreset,
} from '@kento-review/engine/presets'
import { LEVELS, type Level, type ProviderKind } from '@kento-review/protocol'

import type { ProviderFormValues } from './form.ts'

/**
 * KNT-204. A choice of the picker of "Add a provider": a preset of the registry, a type of provider
 * with its own API (Anthropic, OpenRouter, Ollama), a server on the network of a runner (KNT-205:
 * LM Studio, vLLM, llama.cpp), or "Other OpenAI-compatible server", which is the form with no preset.
 */
export type ProviderChoice = { id: string; label: string; kind: ProviderKind; preset: ProviderPreset | null; local?: LocalServer }

const OTHER = 'other'

/** The presets in the order of the registry, then the types and the local servers, then "Other". */
export const PROVIDER_CHOICES: readonly ProviderChoice[] = [
  ...PROVIDER_PRESETS.map((preset) => ({ id: preset.id, label: preset.name, kind: preset.kind, preset })),
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', preset: null },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openrouter', preset: null },
  { id: 'ollama', label: 'Ollama, on a server of a runner', kind: 'ollama', preset: null },
  ...LOCAL_SERVERS.map((local) => ({ id: local.id, label: `${local.name}, on a server of a runner`, kind: 'openai_compatible' as const, preset: null, local })),
  { id: OTHER, label: 'Other OpenAI-compatible server', kind: 'openai_compatible', preset: null },
]

/** The choice of this id (from `?preset=`), or null for an id that the picker does not offer. */
export function choiceById(id: string | null): ProviderChoice | null {
  if (id === null) return null
  return PROVIDER_CHOICES.find((choice) => choice.id === id) ?? null
}

/** The choice that the values of the form match: their preset, else their type, else "Other". */
export function choiceOf(values: Pick<ProviderFormValues, 'kind' | 'baseUrl'>): ProviderChoice {
  let preset = presetOf(values.kind, values.baseUrl)
  if (preset) return choiceById(preset.id)!
  // KNT-205. A local server on its default URL. On another URL, it is "Other".
  let local = localServerOf(values.kind, values.baseUrl)
  if (local) return choiceById(local.id)!
  return choiceById(values.kind === 'openai_compatible' ? OTHER : values.kind) ?? choiceById(OTHER)!
}

/**
 * The form after a choice. A preset fills the name, the URL and the models; a type fills its name
 * only, and keeps the URL and the models of the type by default. A local server (KNT-205) fills its
 * name and its default URL, and the runner holds it. Everything stays editable.
 */
export function choiceValues(choice: ProviderChoice, runnerHeld: boolean): ProviderFormValues {
  let preset = choice.preset ?? presetById(choice.id)
  let local = choice.local ?? localServerById(choice.id)
  let models = Object.fromEntries(LEVELS.map((level) => [level, preset ? preset.models[level].join(', ') : ''])) as Record<Level, string>
  return {
    kind: choice.kind,
    label: choice.id === OTHER ? '' : (preset?.name ?? local?.name ?? choice.label.split(',')[0]!),
    baseUrl: preset?.baseUrl ?? local?.baseUrl ?? '',
    runnerHeld: choice.kind === 'ollama' || local !== null || runnerHeld,
    models,
  }
}

/**
 * The name of the provider of a row, as the list and the Config screen show it: its preset, found
 * by its base URL, or null. A provider added before KNT-204 with the URL of a preset gets it too.
 */
export function presetName(provider: { kind: ProviderKind; baseUrl: string | null }): string | null {
  return presetOf(provider.kind, provider.baseUrl)?.name ?? null
}
