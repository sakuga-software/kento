import type { ProviderKind } from '@sakuga-review/protocol'
import { SERVICE_PROVIDER } from './model.ts'

/** A provider that the Config screen offers for a level. */
export interface ProviderOption {
  /** What the config keeps: `openrouter`, or the id of a provider of the org (REV-11). */
  id: string
  /** The API of the provider: it decides the form of a model id. */
  kind: ProviderKind
  label: string
  /** One line under the name: where its key comes from, or its state. */
  hint: string
}

/** The providers that an org can choose on the Config screen of a repository. */
export interface ProviderCatalog {
  list(orgId: string): Promise<ProviderOption[]>
}

/**
 * Before the providers of the org (REV-11): OpenRouter only, with the key of the service for a trusted
 * runner, or the key of the runner itself.
 */
export const serviceProviders: ProviderCatalog = {
  async list() {
    return [{ id: SERVICE_PROVIDER, kind: 'openrouter', label: 'OpenRouter (clé du service)', hint: 'La clé du service pour un runner de confiance, ou la clé OpenRouter du runner.' }]
  },
}
