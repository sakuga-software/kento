import type { Handle, RemixNode } from 'remix/component'

import { DISMISS_REASONS, OTHER_REASON } from '../findings/dismiss.ts'
import { REASON_MAX } from '../findings/store.ts'

import { Button, Choice, Input, buttonClass } from './controls.tsx'

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
        <summary class={buttonClass()}>{trigger}</summary>
        <div class="confirm-body">
          <fieldset class="field dismiss-reasons">
            <legend class="label">Reason</legend>
            {DISMISS_REASONS.map((reason, n) => (
              <Choice type="radio" id={`${id}-reason-${n}`} name="reason" value={reason} form={form} label={reason} />
            ))}
            <Choice type="radio" id={`${id}-reason-other`} name="reason" value={OTHER_REASON} form={form} label="Other" />
            <label class="visually-hidden" for={`${id}-other`}>
              Other reason
            </label>
            <Input
              id={`${id}-other`}
              name="other"
              form={form}
              maxlength={REASON_MAX}
              placeholder="Other reason"
              autocomplete="off"
            />
            <p class="description">Kentō gives the reason in the GitHub thread of each finding, and counts it in "Dismissal reasons".</p>
          </fieldset>
          <div class="confirm-actions">
            <Button variant="primary" type="submit" form={form} name="status" value="dismissed" formaction={action}>
              {submit}
            </Button>
            <Button type="button" data-confirm-cancel hidden>
              Cancel
            </Button>
          </div>
        </div>
      </details>
    )
  }
}
