import type { Handle } from 'remix/component'

// REV-28. A form sent back with its errors (422) is a new page at the top of the document. Without
// help, its errors stay out of view, sometimes 2800 px lower. The page gives the first field in
// error the `autofocus` attribute: the browser focuses it and scrolls it into view at load, without
// JavaScript. A summary with role="alert" at the top of the form tells a screen reader that nothing
// was saved. The summary is not focused: the field is.
//
// Do not add a fragment to the URL of such a page: a document with a target element ignores
// `autofocus`.

/** The first key of `order` that has an error, or null. */
export function firstInvalid<K extends string>(errors: Partial<Record<K, string | undefined>>, order: readonly K[]): K | null {
  return order.find((key) => Boolean(errors[key])) ?? null
}

/** `autofocus` for the field `key` when it is the first in error. */
export function focusIf(first: string | null, key: string): { autoFocus?: true } {
  return first === key ? { autoFocus: true } : {}
}

/** « Nothing is saved. 2 fields to fix. » at the top of a form with errors. */
export function FormErrors(handle: Handle<{ errors: Record<string, string | undefined> }>) {
  return () => {
    let count = Object.values(handle.props.errors).filter(Boolean).length
    if (count === 0) return null
    return (
      <div class="banner banner-alert form-errors" role="alert">
        <p>
          <strong>Nothing is saved.</strong> {count === 1 ? 'One field to fix' : `${count} fields to fix`}.
        </p>
      </div>
    )
  }
}

/** The radio button that takes the focus in a group with an error: the checked one, else the first. */
export function radioFocus<V extends string>(selected: string, values: readonly V[]): V | undefined {
  return values.find((value) => value === selected) ?? values[0]
}
