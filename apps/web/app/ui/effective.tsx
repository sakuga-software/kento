import type { Handle } from 'remix/component'

import { originText, providerLine, type EffectiveLevel } from '../repo-config/effective.ts'
import type { Source } from '../repo-config/model.ts'

/**
 * REV-27. « Prochain job : Anthropic de Sakuga · clé du runner · claude-haiku-4-5, repli … · le
 * provider « Par défaut » de Providers et clés ». The same words in Réglages and in Config.
 */
export function EffectiveLine(handle: Handle<{ effective: EffectiveLevel; scope: 'org' | 'repo'; source: Source }>) {
  return () => {
    let { effective, scope, source } = handle.props
    return (
      <p class="effective-line">
        <span class="effective-label">Prochain job</span> <strong>{providerLine(effective.provider)}</strong> ·{' '}
        {effective.model ? <span class="mono">{effective.model}</span> : <span class="field-error">aucun modèle pour ce niveau</span>}
        {effective.fallback ? (
          <>
            , repli <span class="mono">{effective.fallback}</span>
          </>
        ) : effective.model ? (
          ', sans repli'
        ) : null}
        <span class="hint"> · {originText(effective, scope, source)}</span>
        {effective.configured ? (
          <span class="hint">
            {' '}
            (la config nomme <span class="mono">{effective.configured.model}</span>
            {effective.configured.fallback ? (
              <>
                , repli <span class="mono">{effective.configured.fallback}</span>
              </>
            ) : null}
            )
          </span>
        ) : null}
      </p>
    )
  }
}
