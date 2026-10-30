import { defaultModels } from '@sakuga-review/engine/levels'
import { UUID, type Level } from '@sakuga-review/protocol'

import { SERVICE_PROVIDER, type LevelModels, type Resolved } from './model.ts'
import type { ProviderOption } from './providers.ts'

// REV-27. The provider and the models that the next job of a level uses, in the words of the screen.
// One rule for Réglages and Config, the same as the claim of a job (runner/store.ts, `pick`) and as
// the models that the runner API sends (runner/controller.ts):
//
// - the config of the repository or of the org names a provider of the org: that provider, with
//   the models of the config;
// - it names « service »: OpenRouter with the key of the service, with the models of the config;
// - it names a provider that the org no longer has: OpenRouter with the key of the service, with the
//   models of Kentō (the runner gets no models without their provider);
// - nothing chose (the values of Kentō): the provider « Par défaut » of the org, with its own models
//   for the level (else those of its type); without a provider, OpenRouter with the models of Kentō.
//
// test/db/effective-provider.test.ts checks this rule against the claim of the service.


/** Why the level runs on this provider. */
export type EffectiveOrigin =
  /** The config of the repository or of the org chose it for the level. */
  | 'chosen'
  /** The config chose a provider that the org no longer has: the key of the service. */
  | 'missing'
  /** Nothing chose: the provider « Par défaut » of the org. */
  | 'default'
  /** Nothing chose, and the org has no provider: the key of the service. */
  | 'service'

export interface EffectiveLevel {
  /** The provider of the next job: an option of the catalog, `service` included. */
  provider: ProviderOption
  origin: EffectiveOrigin
  /** The first model; null: the provider has no model for the level (the job fails until one is named). */
  model: string | null
  fallback: string | null
  /** `missing` only: the model and fallback that the config names, which the next job does not run. */
  configured?: { model: string; fallback: string | null }
}

export function effectiveLevel(level: Level, resolved: Resolved<LevelModels>, providers: readonly ProviderOption[]): EffectiveLevel {
  let service = providers.find((p) => p.id === SERVICE_PROVIDER)!
  let { provider: id, model, fallback } = resolved.value
  if (resolved.source !== 'kento') {
    let chosen = UUID.test(id) ? providers.find((p) => p.id === id && p.id !== SERVICE_PROVIDER) : undefined
    if (chosen) return { provider: chosen, origin: 'chosen', model, fallback }
    if (id === SERVICE_PROVIDER) return { provider: service, origin: 'chosen', model, fallback }
    // The job does not carry the provider of its models: the runner runs the models of Kentō.
    let kento = defaultModels('openrouter', level)
    return { provider: service, origin: 'missing', model: kento[0] ?? null, fallback: kento[1] ?? null, configured: { model, fallback } }
  }
  let byDefault = providers.find((p) => p.isDefault)
  if (!byDefault) return { provider: service, origin: 'service', model, fallback }
  let models = byDefault.models[level] ?? defaultModels(byDefault.kind, level)
  return { provider: byDefault, origin: 'default', model: models[0] ?? null, fallback: models[1] ?? null }
}

/** « Anthropic de Sakuga · clé du runner ». The label of the OpenRouter of the service already says its key. */
export function providerLine(provider: ProviderOption): string {
  return provider.id === SERVICE_PROVIDER ? provider.label : `${provider.label} · ${provider.keyFrom}`
}

/** Where the choice comes from, after the provider line. */
export function originText(effective: EffectiveLevel, scope: 'org' | 'repo', source: Resolved<LevelModels>['source']): string {
  switch (effective.origin) {
    case 'default':
      return 'le provider « Par défaut » de Providers et clés'
    case 'service':
      return 'aucun provider dans l’organisation, donc la clé OpenRouter'
    case 'missing':
      return 'le provider choisi n’existe plus, et la clé OpenRouter le remplace'
    case 'chosen':
      if (scope === 'repo') return source === 'repo' ? 'choisi pour ce repo' : 'choisi pour l’organisation'
      return 'choisi pour l’organisation, ne suit pas le provider « Par défaut »'
  }
}
