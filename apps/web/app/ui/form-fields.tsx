// REV-48. The pieces that the versioned forms of the Config screen (REV-12) and of the settings of the
// org (REV-13) share: the hidden fields of a form, the message under a field, the form that removes a
// value, and the line of the version.
import type { Handle, RemixNode } from 'remix/component'

import { when } from './format.ts'

/** The hidden fields of a versioned form: the CSRF token, the version that the page showed, the field. */
export function VersionFields(handle: Handle<{ csrf: string | null; version: number; field: string }>) {
  return () => {
    let { csrf, version, field } = handle.props
    return (
      <>
        {csrf ? <input type="hidden" name="_csrf" value={csrf} /> : null}
        <input type="hidden" name="version" value={String(version)} />
        <input type="hidden" name="field" value={field} />
      </>
    )
  }
}

/** The error of a field, or else its hint. `describedBy` gives the id that the field points to. */
export function FieldMessage(handle: Handle<{ id: string; error?: string; hint?: RemixNode }>) {
  return () => {
    let { id, error, hint } = handle.props
    if (error) {
      return (
        <p class="field-error" id={`${id}-error`}>
          {error}
        </p>
      )
    }
    return hint ? (
      <p class="field-hint" id={`${id}-hint`}>
        {hint}
      </p>
    ) : null
  }
}

/** The `aria-describedby` of a field: its error, or else its hint. */
export function describedBy(id: string, error: string | undefined, hint: boolean): string | undefined {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined
}

/**
 * « Back to the org value » or « Back to the Kentō value »: a form of its own that removes the value of `field`,
 * shown only for a value that the page sets.
 */
export function ResetForm(handle: Handle<{ action: string; csrf: string | null; version: number; field: string; to: string; label: RemixNode }>) {
  return () => {
    let { action, csrf, version, field, to, label } = handle.props
    return (
      <form method="post" action={action}>
        <VersionFields csrf={csrf} version={version} field={field} />
        <button class="button" type="submit">
          Back to the {to} value<span class="visually-hidden"> for {label}</span>
        </button>
      </form>
    )
  }
}

/**
 * The line of the version of a versioned form: « config v7, changed by alex on 27 Oct at 18:02 ».
 * `empty` is the line of version 0, before any change.
 */
export function versionLine(
  words: { name: string; changed: string; empty: string },
  view: { version: number; updatedBy: string | null; updatedAt: Date | null },
): string {
  if (view.version === 0) return words.empty
  let by = view.updatedBy ? ` by ${view.updatedBy}` : ''
  let at = view.updatedAt ? ` ${when(view.updatedAt)}` : ''
  return `${words.name} v${view.version}, ${words.changed}${by}${at}`
}
