import { serviceOption, type ProviderCatalog, type ProviderOption } from '../repo-config/providers.ts'
import { providerState } from '../ui/settings.tsx'
import { KIND_LABELS } from './form.ts'
import type { ProvidersStore, ProviderView } from './store.ts'

/** The line under the name of a provider on the Config screen: where its key is, and its state. */
function hint(provider: ProviderView): string {
  let state = providerState(provider)
  let where = `${KIND_LABELS[provider.kind]}${provider.isDefault ? ', provider par défaut de l’organisation' : ''}`
  switch (state) {
    case 'runner':
      return `${where} · clé sur le runner`
    case 'refused':
      return `${where} · clé refusée (${provider.refusedStatus})`
    case 'valid':
      return `${where} · clé valide (••••${provider.keyLast4})`
    case 'unknown':
      return `${where} · jamais appelé (••••${provider.keyLast4})`
  }
}

/**
 * The providers that the Config screen of a repository (REV-12) offers: the key of the service, then
 * the providers of the org (REV-11). The config keeps the id: `service`, or the uuid of the row.
 */
export function createConfigProviders(store: ProvidersStore, options: { serviceKey: boolean }): ProviderCatalog {
  return {
    async list(orgId) {
      let own = (await store.list(orgId)).map(
        (provider): ProviderOption => ({
          id: provider.id,
          kind: provider.kind,
          label: provider.label,
          hint: hint(provider),
          isDefault: provider.isDefault,
          keyFrom: keyFrom(provider),
          serviceHoldsKey: !provider.runnerHeld,
          models: provider.models,
        }),
      )
      return [serviceOption(options.serviceKey), ...own]
    },
  }
}

/** « clé du runner », « serveur du runner » or « clé chiffrée par le service ». */
export function keyFrom(provider: Pick<ProviderView, 'runnerHeld' | 'kind'>): string {
  if (provider.kind === 'ollama') return 'serveur du runner'
  return provider.runnerHeld ? 'clé du runner' : 'clé chiffrée par le service'
}
