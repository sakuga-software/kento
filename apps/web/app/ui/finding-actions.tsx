import type { Handle } from 'remix/component'

import type { FindingDetail } from '../pulls/finding.ts'
import { pullRoutes } from '../routes.ts'
import { Confirm } from './confirm.tsx'
import { Button } from './controls.tsx'
import { DismissDialog } from './dismiss-dialog.tsx'

/** What the detail of a finding says after a decision, from `?done=` and `?github=`. */
export const FINDING_NOTICES = {
  dismissed: 'Finding marked dismissed.',
  wontfix: 'Finding marked wontfix.',
  open: 'Finding reopened.',
  unchanged: 'This finding already had this status. Nothing changed.',
  fixed: 'This finding is fixed: a later review did not find it again after a push changed its file. It cannot be set aside.',
} as const
export type FindingNotice = keyof typeof FINDING_NOTICES

/** Where the reply of the bot went: posted in the thread, failed, or no thread to post in. */
export const GITHUB_NOTICES = {
  posted: 'Kentō posted the reply in the GitHub thread.',
  failed: 'Kentō could not post the reply on GitHub. The status changed in Kentō, and the thread says nothing about it.',
  none: 'This finding has no thread on GitHub, so Kentō posts nothing there.',
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
 * "Mark dismissed…" (the dialog of REV-18, with its reasons), "Mark wontfix…" (the one
 * confirmation of REV-33) and "Reopen". A member of the org decides, as an admin does. Each button
 * posts the form of the page, which carries the CSRF token and the id of the finding, to its own action.
 */
export function FindingActions(handle: Handle<{ finding: FindingDetail; csrf: string }>) {
  return () => {
    let { finding, csrf } = handle.props
    let decided = finding.status === 'dismissed' || finding.status === 'wontfix'
    // Not found again after a push changed its file: nothing to decide (REV-18 leaves a fixed finding as it is too).
    if (finding.status === 'fixed') return null
    let form = `finding-${finding.id}`
    let replies = finding.githubCommentId !== null
    return (
      <section class="finding-actions" aria-label="Decide">
        <form id={form} method="post" action={pullRoutes.findingDismiss.href({ id: finding.id })}>
          <input type="hidden" name="_csrf" value={csrf} />
          <input type="hidden" name="ids" value={finding.id} />
        </form>
        {decided ? (
          <form method="post" action={pullRoutes.findingReopen.href({ id: finding.id })}>
            <input type="hidden" name="_csrf" value={csrf} />
            <Button type="submit">
              Reopen
            </Button>
          </form>
        ) : (
          <>
            <DismissDialog
              id={form}
              form={form}
              action={pullRoutes.findingDismiss.href({ id: finding.id })}
              trigger="Mark dismissed…"
              submit="Mark dismissed"
            />
            <Confirm trigger="Mark wontfix…" action={pullRoutes.findingWontfix.href({ id: finding.id })} csrf={csrf} form={form} submit="Mark wontfix">
              <p>
                The finding is right, and the code stays as is. {replies ? 'Kentō says so in the GitHub thread. ' : ''}Kentō will not report it again on this pull request.
              </p>
            </Confirm>
          </>
        )}
      </section>
    )
  }
}
