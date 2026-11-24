import { serviceOption, type ProviderCatalog, type ProviderOption } from '../repo-config/providers.ts'
import { providerState } from '../ui/settings.tsx'
import { KIND_LABELS } from './form.ts'
import { presetName } from './presets.ts'
import type { ProvidersStore, ProviderView } from './store.ts'

/** The line under the name of a provider on the Config screen: where its key is, and its state. */
function hint(provider: ProviderView): string {
  let state = providerState(provider)
  // KNT-204. A provider on the URL of a preset shows its name: "Mistral", not "OpenAI-compatible".
  let where = `${presetName(provider) ?? KIND_LABELS[provider.kind]}${provider.isDefault ? ', default provider of the organization' : ''}`
  switch (state) {
    case 'runner':
      return `${where} · key on the runner`
    case 'refused':
      return `${where} · key refused (${provider.refusedStatus})`
    case 'valid':
      return `${where} · key valid (••••${provider.keyLast4})`
    case 'unknown':
      return `${where} · never called (••••${provider.keyLast4})`
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

/** "key on the runner", "server of the runner" or "key encrypted by the service". */
export function keyFrom(provider: Pick<ProviderView, 'runnerHeld' | 'kind'>): string {
  if (provider.kind === 'ollama') return 'server of the runner'
  return provider.runnerHeld ? 'key on the runner' : 'key encrypted by the service'
}
