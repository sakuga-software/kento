// KNT-143. The form controls of every screen, in the look of HeroUI v3 (public/assets/heroui.css,
// built from styles/heroui.css). HeroUI's React components need React, and this app has none: the
// helpers write native elements with the BEM classes of @heroui/styles. Every other attribute
// (`name`, `id`, `form`, `formaction`, `aria-*`, `data-*`…) goes to the element as is.
import type { Handle, Props, RemixNode } from 'remix/component'

/** The variants of HeroUI that the screens use. `outline` is the default button of Kentō. */
export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger' | 'danger-soft'
export type ButtonSize = 'sm' | 'md' | 'lg'

function classes(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ')
}

/**
 * The class of a button, for a `<button>` and for what looks like one: a link, the `<summary>` of a
 * `<details>`, a disabled page link. `extra` is a class of the screen (its layout in kento.css).
 */
export function buttonClass(variant: ButtonVariant = 'outline', size: ButtonSize = 'md', extra?: string): string {
  return classes('button', `button--${variant}`, size !== 'md' && `button--${size}`, extra)
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
 * A native `<select>` in the trigger of HeroUI. The box around it draws the chevron in CSS (no SVG:
 * the Findings screen has four selects in its filters). `class` goes to the `<select>`;
 * `wrapperClass` goes to the box, for the layout of a screen.
 */
export function Select(handle: Handle<Props<'select'> & { wrapperClass?: string }>) {
  return () => {
    let { class: extra, wrapperClass, children, ...rest } = handle.props
    return (
      <span class={classes('select', 'select--native', wrapperClass)}>
        <select {...rest} class={classes('select__trigger', extra as string | undefined)}>
          {children}
        </select>
      </span>
    )
  }
}

export type ChoiceProps = Omit<Props<'input'>, 'type' | 'role'> & {
  type: 'checkbox' | 'radio'
  /** The text next to the box. Without it, the input needs an `aria-label`. */
  label?: RemixNode
  /** A class of the screen on the `<label>`. */
  wrapperClass?: string
}

/**
 * A checkbox or a radio button of HeroUI around the native input. The input covers the box,
 * transparent: the click, the keyboard and the form use it.
 */
export function Choice(handle: Handle<ChoiceProps>) {
  return () => {
    let { type, label, wrapperClass, ...rest } = handle.props
    return (
      <label class={classes(type, 'choice', wrapperClass)}>
        <span class={`${type}__content`}>
          <span class={`${type}__control`}>
            <input type={type} {...rest} />
            {type === 'checkbox' ? (
              <span class="checkbox__indicator" aria-hidden="true">
                <svg data-slot="checkbox-default-indicator--checkmark" viewBox="0 0 17 18" fill="none" focusable="false">
                  <polyline points="1 9 7 14 15 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg data-slot="checkbox-default-indicator--indeterminate" viewBox="0 0 12 12" fill="none" focusable="false">
                  <path d="M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                </svg>
              </span>
            ) : (
              <span class="radio__indicator" aria-hidden="true"></span>
            )}
          </span>
          {label === undefined ? null : <span data-slot="label">{label}</span>}
        </span>
      </label>
    )
  }
}

/**
 * A checkbox of a list that repeats it on every row (the selection of the Findings screen): the
 * native input alone, drawn as the box of HeroUI by `.check` in styles/heroui.css. The markup of
 * `Choice` on each of 50 rows would weigh about 28 KB of HTML. It needs an `aria-label`.
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
        <label class="label" for={id}>
          {label}
        </label>
        {children}
        {message}
      </div>
    )
  }
}
