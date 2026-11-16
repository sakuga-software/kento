import type { Handle } from 'remix/component'

import { KIND_LABELS } from '../providers/form.ts'
import { originText, providerLine, wrongIdAction, type EffectiveLevel } from '../repo-config/effective.ts'
import type { Source } from '../repo-config/model.ts'

/**
 * REV-27. « Next job: Anthropic of Sakuga · key on the runner · claude-haiku-4-5, fallback … · the
 * "Default" provider of Providers and keys ». The same words in Settings and in Config.
 */
export function EffectiveLine(handle: Handle<{ effective: EffectiveLevel; scope: 'org' | 'repo'; source: Source }>) {
  return () => {
    let { effective, scope, source } = handle.props
    return (
      <>
        <EffectiveFacts effective={effective} scope={scope} source={source} />
        {effective.wrongIds.length > 0 ? (
          <div class="field-error effective-wrong-id" role="alert">
            {effective.wrongIds.map(({ id, help }) => (
              <p>
                The id <span class="mono">{id}</span> is not in the form that {KIND_LABELS[effective.provider.kind]} expects. {help}
              </p>
            ))}
            <p>The next job of this level fails before it calls the provider. {wrongIdAction(effective, scope, source)}</p>
          </div>
        ) : null}
      </>
    )
  }
}

function EffectiveFacts(handle: Handle<{ effective: EffectiveLevel; scope: 'org' | 'repo'; source: Source }>) {
  return () => {
    let { effective, scope, source } = handle.props
    return (
      <p class="effective-line">
        <span class="effective-label">Next job</span> <strong>{providerLine(effective.provider)}</strong> ·{' '}
        {effective.model ? <span class="mono">{effective.model}</span> : <span class="field-error">no model for this level</span>}
        {effective.fallback ? (
          <>
            , fallback <span class="mono">{effective.fallback}</span>
          </>
        ) : effective.model ? (
          ', no fallback'
        ) : null}
        <span class="hint"> · {originText(effective, scope, source)}</span>
        {effective.configured ? (
          <span class="hint">
            {' '}
            (the config names <span class="mono">{effective.configured.model}</span>
            {effective.configured.fallback ? (
              <>
                , fallback <span class="mono">{effective.configured.fallback}</span>
              </>
            ) : null}
            )
          </span>
        ) : null}
      </p>
    )
  }
}
