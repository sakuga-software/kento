import type { ProviderCatalog, ProviderOption } from '../repo-config/providers.ts'
import { SERVICE_PROVIDER } from '../repo-config/model.ts'
import { providerState } from '../ui/settings.tsx'
import { KIND_LABELS } from './form.ts'
import type { ProvidersStore, ProviderView } from './store.ts'

/** The line under the name of a provider on the Config screen: where its key is, and its state. */
function hint(provider: ProviderView): string {
  let state = providerState(provider)
  let where = `${KIND_LABELS[provider.kind]}${provider.isDefault ? ', provider par défaut de l’org' : ''}`
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
      let service: ProviderOption = {
        id: SERVICE_PROVIDER,
        label: 'OpenRouter (clé du service)',
        hint: options.serviceKey
          ? 'La clé du service pour un runner de confiance, ou la clé OpenRouter du runner.'
          : 'La clé OpenRouter du runner : le service n’en a pas.',
      }
      let own = (await store.list(orgId)).map((provider) => ({ id: provider.id, label: provider.label, hint: hint(provider) }))
      return [service, ...own]
    },
  }
}
