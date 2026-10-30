import type { Level, ProviderKind } from '@sakuga-review/protocol'
import { SERVICE_PROVIDER } from './model.ts'

/** A provider that the Config screen offers for a level. */
export interface ProviderOption {
  /** What the config keeps: `service`, or the id of a provider of the org (REV-11). */
  id: string
  /** The API of the provider: it decides the form of a model id. */
  kind: ProviderKind
  label: string
  /** One line under the name: where its key comes from, or its state. */
  hint: string
  /** REV-27. The provider « Par défaut » of the org: a level without a choice runs on it. */
  isDefault: boolean
  /** REV-27. Where the key of a call comes from, in words: « clé du runner », « clé du service »… */
  keyFrom: string
  /** The service holds the key of a call: the OpenRouter key of the service, or a key that it keeps encrypted. */
  serviceHoldsKey: boolean
  /** REV-27. The models of the provider by level; a level without models takes those of its type. */
  models: Partial<Record<Level, string[]>>
}

/** The providers that an org can choose on the Config screen of a repository. */
export interface ProviderCatalog {
  list(orgId: string): Promise<ProviderOption[]>
}

/**
 * The OpenRouter provider of the service. With KENTO_PROVIDER_API_KEY, a trusted runner gets the key
 * of the service, and an untrusted one uses its own; without it, only a runner with its own OpenRouter
 * key runs the job. The label says which, so that it never contradicts its hint (REV-27).
 */
export function serviceOption(serviceKey: boolean): ProviderOption {
  return serviceKey
    ? {
        id: SERVICE_PROVIDER,
        kind: 'openrouter',
        label: 'OpenRouter · clé du service',
        hint: 'La clé OpenRouter du service, pour un runner de confiance ; un autre runner utilise la sienne.',
        isDefault: false,
        keyFrom: 'clé du service',
        serviceHoldsKey: true,
        models: {},
      }
    : {
        id: SERVICE_PROVIDER,
        kind: 'openrouter',
        label: 'OpenRouter · clé du runner',
        hint: 'La clé OpenRouter du runner. Le service n’en a pas.',
        isDefault: false,
        keyFrom: 'clé du runner',
        serviceHoldsKey: false,
        models: {},
      }
}

/** Before the providers of the org (REV-11): OpenRouter only, with the key of the service. */
export const serviceProviders: ProviderCatalog = {
  async list() {
    return [serviceOption(true)]
  },
}
