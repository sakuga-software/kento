import type { Handle, RemixNode } from 'remix/component'

import { CheckIcon, CloseIcon } from './icons.tsx'

/**
 * KNT-184. The message of an action that went well, after the redirect of its form: a toast in a
 * corner of the window, in place of a banner at the top of the page. It goes away by itself after a
 * few seconds (kento.css, paused while the pointer or the focus is on it), and with its close link.
 *
 * It is rendered in a live region of the page (`role="status"`, `.toast-region`), not as a region of
 * its own: a script that changes the page in place fills that region, and a screen reader reads the
 * change. An error stays a banner: it must not go away before it is read.
 *
 * Without JavaScript the close link loads `dismiss`, the URL of the page without the message. With
 * it, public/assets/toast.js removes the toast, and takes `params` out of the URL at the load, so that
 * a reload does not show the message again.
 */
export interface ToastProps {
  /** The URL of the page without the parameters of the message. */
  dismiss: string
  /** The parameters of the query that carry the message, separated by spaces (`done repo`). */
  params: string
  children?: RemixNode
}

export function Toast(handle: Handle<ToastProps>) {
  return () => {
    let { dismiss, params, children } = handle.props
    return (
      <div class="toast" data-toast={params}>
        <CheckIcon />
        <div class="toast-text">{children}</div>
        <a class="toast-close" href={dismiss} aria-label="Close the message" title="Close" data-toast-close="">
          <CloseIcon />
        </a>
      </div>
    )
  }
}
