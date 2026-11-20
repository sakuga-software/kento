// KNT-143. The form controls of every screen: native elements (button, input, select, textarea), with
// the classes that public/assets/kento.css draws in the tokens of the two themes. No framework: the
// guideline is in apps/web/CLAUDE.md, "UI components". Every other attribute (`name`, `id`, `form`,
// `formaction`, `aria-*`, `data-*`…) goes to the element as is.
import type { Handle, Props, RemixNode } from 'remix/component'

/**
 * The variants that the screens use, named as their classes: `outline` is the default button of
 * Kentō (the class `button` alone), `danger` opens the confirmation of a destructive action and
 * `danger-solid` acts.
 */
export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'danger-solid'
export type ButtonSize = 'sm' | 'md' | 'lg'

function classes(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ')
}

const VARIANT_CLASS: Record<ButtonVariant, string | null> = {
  primary: 'button-primary',
  outline: null,
  ghost: 'button-ghost',
  danger: 'button-danger',
  'danger-solid': 'button-danger-solid',
}
const SIZE_CLASS: Record<ButtonSize, string | null> = { sm: 'button-small', md: null, lg: 'button-large' }

/**
 * The class of a button, for a `<button>` and for what looks like one: a link, the `<summary>` of a
 * `<details>`, a disabled page link. `extra` is a class of the screen (its layout in kento.css).
 */
export function buttonClass(variant: ButtonVariant = 'outline', size: ButtonSize = 'md', extra?: string): string {
  return classes('button', VARIANT_CLASS[variant], SIZE_CLASS[size], extra)
}

export type ButtonProps = Props<'button'> & { variant?: ButtonVariant; size?: ButtonSize }

/** A `<button>`. `type` stays explicit at each call, as before. */
export function Button(handle: Handle<ButtonProps>) {
  return () => {
    let { variant, size, class: extra, children, ...rest } = handle.props
    return (
      <button {...rest} class={buttonClass(variant, size, extra as string | undefined)}>
        {children}
      </button>
    )
  }
}

/** A text `<input>` (text, search, url, number…). Not for a hidden field, a checkbox or a radio button. */
export function Input(handle: Handle<Props<'input'>>) {
  return () => {
    let { class: extra, ...rest } = handle.props
    return <input {...rest} class={classes('input', extra as string | undefined)} />
  }
}

/** A `<textarea>`. */
export function Textarea(handle: Handle<Props<'textarea'>>) {
  return () => {
    let { class: extra, children, ...rest } = handle.props
    return (
      <textarea {...rest} class={classes('textarea', extra as string | undefined)}>
        {children}
      </textarea>
    )
  }
}

/**
 * A native `<select>`. The box around it draws the chevron in CSS (no SVG: the Findings screen has
 * four selects in its filters). `class` goes to the `<select>`; `wrapperClass` goes to the box, for
 * the layout of a screen.
 */
export function Select(handle: Handle<Props<'select'> & { wrapperClass?: string }>) {
  return () => {
    let { class: extra, wrapperClass, children, ...rest } = handle.props
    return (
      <span class={classes('select-box', wrapperClass)}>
        <select {...rest} class={classes('select-input', extra as string | undefined)}>
          {children}
        </select>
      </span>
    )
  }
}

export type ChoiceProps = Omit<Props<'input'>, 'type' | 'role'> & {
  type: 'checkbox' | 'radio'
  /** The text next to the box. */
  label: RemixNode
  /** A class of the screen on the `<label>`. */
  wrapperClass?: string
}

/** A checkbox or a radio button with its text, in one `<label>`: the native input, drawn by `.check`. */
export function Choice(handle: Handle<ChoiceProps>) {
  return () => {
    let { type, label, wrapperClass, class: extra, ...rest } = handle.props
    return (
      <label class={classes('choice', wrapperClass)}>
        <input type={type} {...rest} class={classes('check', extra as string | undefined)} />
        <span>{label}</span>
      </label>
    )
  }
}

/**
 * A checkbox with no text of its own, for a list that repeats it on every row (the selection of
 * the Findings screen): the native input alone, drawn by `.check`. It needs an `aria-label`.
 */
export function Check(handle: Handle<Omit<Props<'input'>, 'type' | 'role'>>) {
  return () => {
    let { class: extra, ...rest } = handle.props
    return <input type="checkbox" {...rest} class={classes('check', extra as string | undefined)} />
  }
}

/**
 * A field: its label, its control, then its error or its hint (`FieldMessage`). The control gets
 * `aria-describedby={describedBy(id, error, hint)}` from the screen.
 */
export function Field(handle: Handle<{ id: string; label: RemixNode; class?: string; children?: RemixNode; message?: RemixNode }>) {
  return () => {
    let { id, label, class: extra, children, message } = handle.props
    return (
      <div class={classes('field', extra)}>
        <label class="field-label" for={id}>
          {label}
        </label>
        {children}
        {message}
      </div>
    )
  }
}
