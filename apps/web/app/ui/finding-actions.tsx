import type { Handle } from 'remix/component'

import type { FindingDetail } from '../pulls/finding.ts'
import { pullRoutes } from '../routes.ts'
import { Confirm } from './confirm.tsx'
import { DismissDialog } from './dismiss-dialog.tsx'

/** What the detail of a finding says after a decision, from `?fait=` and `?github=`. */
export const FINDING_NOTICES = {
  dismissed: 'Finding marqué dismissed.',
  wontfix: 'Finding marqué wontfix.',
  open: 'Finding rouvert.',
  unchanged: 'Ce finding avait déjà ce statut : rien n’a changé.',
  fixed: 'Ce finding est fixed : un push l’a corrigé, il ne se met pas de côté.',
} as const
export type FindingNotice = keyof typeof FINDING_NOTICES

/** Where the reply of the bot went: posted in the thread, failed, or no thread to post in. */
export const GITHUB_NOTICES = {
  posted: 'La réponse est postée sur le fil GitHub.',
  failed: 'La réponse n’a pas pu être postée sur GitHub : le statut est changé dans Kentō, et le fil n’en dit rien.',
  none: 'Ce finding n’a pas de fil sur GitHub : rien n’y est posté.',
} as const
export type GithubNotice = keyof typeof GITHUB_NOTICES

export function FindingNoticeView(handle: Handle<{ notice: FindingNotice; github: GithubNotice | null }>) {
  return () => {
    let { notice, github } = handle.props
    return (
      <div class={`banner ${github === 'failed' ? 'banner-alert' : 'banner-ok'}`} role="status">
        <p>
          <strong>{FINDING_NOTICES[notice]}</strong>
          {github ? ` ${GITHUB_NOTICES[github]}` : ''}
        </p>
      </div>
    )
  }
}

/**
 * « Marquer dismissed… » (the dialog of REV-18, with its reasons), « Marquer wontfix… » (the one
 * confirmation of REV-33) and « Rouvrir ». A member of the org decides, as an admin does. Each button
 * posts the form of the page, which carries the CSRF token and the id of the finding, to its own action.
 */
export function FindingActions(handle: Handle<{ finding: FindingDetail; csrf: string }>) {
  return () => {
    let { finding, csrf } = handle.props
    let decided = finding.status === 'dismissed' || finding.status === 'wontfix'
    // A push fixed it: nothing to decide (REV-18 leaves a fixed finding as it is too).
    if (finding.status === 'fixed') return null
    let form = `finding-${finding.id}`
    let replies = finding.githubCommentId !== null
    return (
      <section class="finding-actions" aria-label="Décider">
        <form id={form} method="post" action={pullRoutes.findingDismiss.href({ id: finding.id })}>
          <input type="hidden" name="_csrf" value={csrf} />
          <input type="hidden" name="ids" value={finding.id} />
        </form>
        {decided ? (
          <form method="post" action={pullRoutes.findingReopen.href({ id: finding.id })}>
            <input type="hidden" name="_csrf" value={csrf} />
            <button class="button" type="submit">
              Rouvrir
            </button>
          </form>
        ) : (
          <>
            <DismissDialog
              id={form}
              form={form}
              action={pullRoutes.findingDismiss.href({ id: finding.id })}
              trigger="Marquer dismissed…"
              submit="Marquer dismissed"
            />
            <Confirm trigger="Marquer wontfix…" action={pullRoutes.findingWontfix.href({ id: finding.id })} csrf={csrf} form={form} submit="Marquer wontfix">
              <p>
                Le finding est juste, et le code reste tel quel. {replies ? 'Kentō le dit sur le fil GitHub. ' : ''}Il ne le signalera plus sur cette PR.
              </p>
            </Confirm>
          </>
        )}
      </section>
    )
  }
}
