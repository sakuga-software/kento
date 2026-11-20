// KNT-163. The confirmation of a destructive action (REV-33), on the popover of @remix-run/ui.
// The server renders a `<details>`: without JavaScript, its trigger opens and closes it. In the
// browser the component hydrates that markup, then draws a button and a popover in its place.
import { clientEntry, on, ref, type Handle, type RemixNode } from 'remix/component'
import * as popover from '@remix-run/ui/popover'

import { Button, buttonClass } from '../controls.tsx'

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

/** The button that acts: it posts the form of the page, or a form of its own. */
export function ConfirmSubmit(handle: Handle<{ action: string; csrf: string | null; form?: string; children?: RemixNode }>) {
  return () => {
    let { action, csrf, form, children } = handle.props
    if (form) {
      return (
        <Button variant="danger" type="submit" form={form} formaction={action}>
          {children}
        </Button>
      )
    }
    return (
      <form method="post" action={action}>
        {csrf ? <input type="hidden" name="_csrf" value={csrf} /> : null}
        <Button variant="danger" type="submit">
          {children}
        </Button>
      </form>
    )
  }
}

/** Without JavaScript: a `<details>` that opens in place, under its trigger. */
export function ConfirmDetails(handle: Handle<ConfirmProps & { onDetails?: (node: HTMLDetailsElement) => void }>) {
  return () => {
    let { trigger, children, action, csrf, submit, form, onDetails } = handle.props
    return (
      <details class="confirm" mix={onDetails ? ref(onDetails) : undefined}>
        <summary class={buttonClass('danger-soft')}>{trigger}</summary>
        <div class="confirm-body">
          {children}
          <div class="confirm-actions">
            <ConfirmSubmit action={action} csrf={csrf} form={form}>
              {submit}
            </ConfirmSubmit>
          </div>
        </div>
      </details>
    )
  }
}

export type ConfirmDialogProps = Omit<ConfirmProps, 'trigger'> & {
  open: boolean
  /** The id of the element that names the dialog: its trigger. */
  labelledBy: string
  /** Closes it. `focus`: the focus goes back to the trigger (Escape, "Cancel"). */
  onClose: (focus: boolean) => void
}

/**
 * With JavaScript: the popover of a confirmation, anchored to the `popover.anchor()` of its
 * `popover.Context`. "Cancel" has the focus when it opens. Escape and "Cancel" close it and give
 * the focus back; a click outside closes it and leaves the focus where the person put it.
 */
export function ConfirmDialog(handle: Handle<ConfirmDialogProps>) {
  return () => {
    let { open, labelledBy, onClose, children, action, csrf, submit, form } = handle.props
    return (
      <div
        class="confirm-body confirm-popover"
        role="dialog"
        aria-labelledby={labelledBy}
        mix={popover.surface({
          open,
          restoreFocusOnHide: false,
          onHide: (request) => onClose(request?.reason === 'escape-key'),
        })}
      >
        {children}
        <div class="confirm-actions">
          <ConfirmSubmit action={action} csrf={csrf} form={form}>
            {submit}
          </ConfirmSubmit>
          <Button type="button" mix={[popover.focusOnShow(), on('click', () => onClose(true))]}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }
}

/**
 * The one confirmation of a destructive action (REV-33): Disable a repo, Revoke a runner, Cancel a
 * token, Remove a provider. The trigger and the button that acts have the destructive style, never
 * the primary one. The server renders `ConfirmDetails`; in the browser the component hydrates it,
 * then draws its trigger and `ConfirmDialog` in its place.
 */
export const Confirm = clientEntry(import.meta.url, function Confirm(handle: Handle<ConfirmProps>) {
  // The first render in the browser hydrates the HTML of the server; the popover comes after it.
  let enhanced = false
  let open = false
  let trigger: HTMLButtonElement | null = null
  let details: HTMLDetailsElement | null = null
  handle.queueTask(() => {
    enhanced = true
    // Opened before the component hydrated: it stays open, as a popover.
    open = details?.open ?? false
    void handle.update()
  })

  let close = async (focus: boolean) => {
    open = false
    await handle.update()
    if (focus) trigger?.focus()
  }

  return () => {
    let { trigger: label, ...rest } = handle.props
    if (!enhanced) return <ConfirmDetails {...handle.props} onDetails={(node) => (details = node)} />
    let id = `${handle.id}-trigger`
    return (
      <popover.Context>
        <span class="confirm">
          <button
            type="button"
            id={id}
            class={buttonClass('danger-soft')}
            aria-haspopup="dialog"
            aria-expanded={open ? 'true' : 'false'}
            mix={[
              ref((node) => (trigger = node)),
              popover.anchor({ placement: 'bottom-start', offset: 8 }),
              on('click', () => {
                open = true
                void handle.update()
              }),
              // The focus moves to "Cancel" once the popover shows: an Escape before that lands here.
              on('keydown', (event) => {
                if (event.key !== 'Escape' || !open) return
                event.preventDefault()
                void close(true)
              }),
            ]}
          >
            {label}
          </button>
        </span>
        <ConfirmDialog {...rest} open={open} labelledBy={id} onClose={(focus) => void close(focus)} />
      </popover.Context>
    )
  }
})
