import { defaultModels } from '@sakuga-review/engine/levels'
import { UUID, type Level } from '@sakuga-review/protocol'

import { idFormHelp, SERVICE_PROVIDER, type LevelModels, type Resolved } from './model.ts'
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
  /**
   * REV-62. The ids of the next job that its provider refuses for their form, with what it expects.
   * The form refuses them (#66); an id already in the database shows here, and its job fails at the
   * claim, before any call.
   */
  wrongIds: { id: string; help: string }[]
}

export function effectiveLevel(level: Level, resolved: Resolved<LevelModels>, providers: readonly ProviderOption[]): EffectiveLevel {
  let effective = nextJob(level, resolved, providers)
  let wrongIds = [effective.model, effective.fallback].flatMap((id) => {
    let help = id ? idFormHelp(effective.provider.kind, id) : null
    return id && help ? [{ id, help }] : []
  })
  return { ...effective, wrongIds }
}

function nextJob(level: Level, resolved: Resolved<LevelModels>, providers: readonly ProviderOption[]): Omit<EffectiveLevel, 'wrongIds'> {
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

/**
 * REV-62. Where an admin corrects an id of the wrong form: the form of the level on this screen, the
 * Réglages of the org for a repository that follows them, or the provider in Providers et clés.
 */
export function wrongIdAction(effective: EffectiveLevel, scope: 'org' | 'repo', source: Resolved<LevelModels>['source']): string {
  if (effective.origin === 'default') {
    return scope === 'repo'
      ? 'Pour le corriger : les modèles de ce provider dans Providers et clés, ou un modèle pour ce repo dans le formulaire ci-dessous.'
      : 'Pour le corriger : les modèles de ce provider dans Providers et clés, ou un modèle pour ce niveau dans le formulaire ci-dessous.'
  }
  if (scope === 'repo' && source === 'org') {
    return 'Pour le corriger : le modèle de ce niveau dans les Réglages de l’organisation, ou un modèle pour ce repo dans le formulaire ci-dessous.'
  }
  return 'Pour le corriger : le modèle de ce niveau dans le formulaire ci-dessous.'
}
