import type { Handle, RemixNode } from 'remix/component'

import { DISMISS_REASONS, OTHER_REASON } from '../findings/dismiss.ts'
import { REASON_MAX } from '../findings/store.ts'

export interface DismissDialogProps {
  /** The text of the button that opens the dialog: "Mark dismissed…". */
  trigger: RemixNode
  /** The text of the button that acts: "Mark dismissed". */
  submit: RemixNode
  /** The id of the form that the fields and the button belong to (it holds the ids and the CSRF token). */
  form: string
  /** The URL that the button posts the form to; the action of the form by default. */
  action?: string
  /** Unique on the page: the ids of the fields start with it. */
  id: string
}

/**
 * REV-18. The dialog of the reason of a dismissal, shared by the Findings screen (several findings)
 * and the screen of a pull request (REV-17, one finding). The reasons of DISMISS_REASONS, or
 * "Other" with a reason of the person. It opens in place, under its trigger (a `<details>`, with no
 * JavaScript), as the confirmation of a destructive action does (confirm.tsx).
 *
 * The fields belong to `form`: the server reads them with `readStatusForm` (findings/dismiss.ts).
 */
export function DismissDialog(handle: Handle<DismissDialogProps>) {
  return () => {
    let { trigger, submit, form, action, id } = handle.props
    return (
      <details class="confirm dismiss-dialog" data-confirm>
        <summary class="button">{trigger}</summary>
        <div class="confirm-body">
          <fieldset class="field dismiss-reasons">
            <legend class="field-label">Reason</legend>
            {DISMISS_REASONS.map((reason, n) => (
              <label class="choice" for={`${id}-reason-${n}`}>
                <input type="radio" id={`${id}-reason-${n}`} name="reason" value={reason} form={form} />
                <span>{reason}</span>
              </label>
            ))}
            <label class="choice" for={`${id}-reason-other`}>
              <input type="radio" id={`${id}-reason-other`} name="reason" value={OTHER_REASON} form={form} />
              <span>Other</span>
            </label>
            <label class="visually-hidden" for={`${id}-other`}>
              Other reason
            </label>
            <input
              class="input"
              id={`${id}-other`}
              name="other"
              form={form}
              maxlength={REASON_MAX}
              placeholder="Other reason"
              autocomplete="off"
            />
            <p class="field-hint">Kentō gives the reason in the GitHub thread of each finding, and counts it in "Dismissal reasons".</p>
          </fieldset>
          <div class="confirm-actions">
            <button class="button button-primary" type="submit" form={form} name="status" value="dismissed" formaction={action}>
              {submit}
            </button>
            <button class="button" type="button" data-confirm-cancel hidden>
              Cancel
            </button>
          </div>
        </div>
      </details>
    )
  }
}
