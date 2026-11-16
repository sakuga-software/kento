import type { Handle, RemixNode } from 'remix/component'

export interface ConfirmProps {
  /** The text of the button that opens the confirmation: "Revoke…". */
  trigger: RemixNode
  /** What the action does and what stays, in a sentence or two. */
  children?: RemixNode
  /** The URL that the confirmation posts to. */
  action: string
  csrf: string | null
  /** The text of the button that acts: "Revoke runner-1". It names what goes. */
  submit: RemixNode
  /**
   * The id of a form of the page that carries the CSRF token (REV-36): the button posts it to
   * `action`, and the confirmation has no form of its own. A long list writes the token once.
   */
  form?: string
}

/**
 * The one confirmation of a destructive action (REV-33): Disable a repo, Revoke a runner,
 * Cancel a token, Remove a provider. It opens in place, under its trigger. The trigger and the
 * button that acts have the destructive style, never the primary one.
 *
 * Without JavaScript, the trigger opens and closes it (a `<details>`). With /assets/confirm.js,
 * "Cancel" and Escape close it too, and give the focus back to the trigger.
 */
export function Confirm(handle: Handle<ConfirmProps>) {
  return () => {
    let { trigger, children, action, csrf, submit, form } = handle.props
    return (
      <details class="confirm" data-confirm>
        <summary class="button button-danger">{trigger}</summary>
        <div class="confirm-body">
          {children}
          <div class="confirm-actions">
            {form ? (
              <button class="button button-danger-solid" type="submit" form={form} formaction={action}>
                {submit}
              </button>
            ) : (
              <form method="post" action={action}>
                {csrf ? <input type="hidden" name="_csrf" value={csrf} /> : null}
                <button class="button button-danger-solid" type="submit">
                  {submit}
                </button>
              </form>
            )}
            <button class="button" type="button" data-confirm-cancel hidden>
              Cancel
            </button>
          </div>
        </div>
      </details>
    )
  }
}
