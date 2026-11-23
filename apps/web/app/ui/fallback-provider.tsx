// KNT-161. The fallback provider of a level and its model, in the form of a level of Config (a
// repository) and of Settings (the org): the provider that takes over when the provider of the
// level refuses the call on its usage limit.
import type { Handle } from 'remix/component'

import type { ProviderOption } from '../repo-config/providers.ts'
import { Input, Select } from './controls.tsx'
import { focusIf } from './form-errors.tsx'
import { describedBy, FieldMessage } from './form-fields.tsx'

export interface FallbackProviderProps {
  /** The prefix of the ids of the fields: `level-lite`. */
  id: string
  providers: readonly ProviderOption[]
  /** The fields of the form, as sent: `fallbackProvider` and `fallbackProviderModel`. */
  values: Record<string, string>
  errors: Record<string, string>
  /** The first field in error, which takes the focus. */
  first: string | null
}

/** The fields `fallbackProvider` (none, or a provider of the org) and `fallbackProviderModel`. */
export function FallbackProviderFields(handle: Handle<FallbackProviderProps>) {
  return () => {
    let { id, providers, values, errors, first } = handle.props
    let providerId = `${id}-fallback-provider`
    let modelId = `${id}-fallback-provider-model`
    let selected = values.fallbackProvider ?? ''
    return (
      <>
        <div class="field">
          <label class="field-label" for={providerId}>
            Fallback provider on a usage limit
          </label>
          <Select
            id={providerId}
            name="fallbackProvider"
            {...focusIf(first, 'fallbackProvider')}
            aria-invalid={errors.fallbackProvider ? 'true' : undefined}
            aria-describedby={describedBy(providerId, errors.fallbackProvider, true)}
          >
            <option value="" selected={selected === ''}>
              None
            </option>
            {providers.map((p) => (
              <option value={p.id} selected={p.id === selected}>
                {p.label}
              </option>
            ))}
            {selected && !providers.some((p) => p.id === selected) ? (
              <option value={selected} selected>
                {selected} (not available)
              </option>
            ) : null}
          </Select>
          <FieldMessage
            id={providerId}
            error={errors.fallbackProvider}
            hint="Another provider of the organization. It answers when the provider above refuses the call on its usage limit."
          />
        </div>
        <div class="field">
          <label class="field-label" for={modelId}>
            Model of the fallback provider
          </label>
          <Input
            class="mono"
            id={modelId}
            name="fallbackProviderModel"
            value={values.fallbackProviderModel ?? ''}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            {...focusIf(first, 'fallbackProviderModel')}
            aria-invalid={errors.fallbackProviderModel ? 'true' : undefined}
            aria-describedby={describedBy(modelId, errors.fallbackProviderModel, true)}
          />
          <FieldMessage id={modelId} error={errors.fallbackProviderModel} hint="Leave it empty with no fallback provider." />
        </div>
      </>
    )
  }
}
