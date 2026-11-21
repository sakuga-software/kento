// KNT-165. The select of every screen, on the select of @remix-run/ui. The server renders a native
// `<select>` (`Select` of ../controls.tsx): without JavaScript, it is the control, and the form posts
// it. In the browser this component reads that `<select>` (its options, its value, its name), and
// draws a button and a list in its place. The native one is hidden and disabled; a hidden input of
// the same name carries the value.
import { clientEntry, on, ref, type Handle } from 'remix/component'
import * as popover from '@remix-run/ui/popover'
import * as select from '@remix-run/ui/select'

export interface CustomSelectProps {
  /** The id of the native `<select>` that the server rendered just before. */
  target: string
}

interface Choice {
  value: string
  label: string
  disabled: boolean
}

/** What the component took from the native `<select>`. */
interface Native {
  name: string
  value: string
  label: string
  disabled: boolean
  form: string | null
  describedBy: string | null
  invalid: string | null
  /** The classes of the native select (`select-input` and those of the screen, `mono`). */
  className: string
  /** The id of the label of the control, given one when it had none. */
  labelId: string | null
  options: Choice[]
}

/**
 * Takes over the native `<select>` `id`: its id moves to the button (the `<label for>` of the
 * server now names the button), and the select is hidden and disabled, so the form posts the hidden
 * input only. Null for a select this component does not handle (multiple, or not found).
 */
function adopt(id: string): Native | null {
  let element = document.getElementById(id)
  if (!(element instanceof HTMLSelectElement) || element.multiple) return null
  let label = element.labels?.[0] ?? null
  if (label && !label.id) label.id = `${id}-label`
  let selected = element.selectedOptions[0]
  let native: Native = {
    name: element.name,
    value: element.value,
    label: selected?.label ?? '',
    disabled: element.disabled,
    form: element.getAttribute('form'),
    describedBy: element.getAttribute('aria-describedby'),
    invalid: element.getAttribute('aria-invalid'),
    className: element.className,
    labelId: label?.id ?? null,
    options: [...element.options].map((option) => ({ value: option.value, label: option.label, disabled: option.disabled })),
  }
  element.id = `${id}-native`
  element.hidden = true
  element.disabled = true
  return native
}

/** The popover and its list. A child of `select.Context`, to close the list. */
function SelectPopover(handle: Handle<{ labelId: string | null; options: Choice[]; onTab: () => void; onClosed: () => void }>) {
  let context = handle.context.get(select.Context)
  // @remix-run/ui 0.13.1 turns Tab in the list into "go to the first option" (listbox.ts:273), and
  // the focus stays in the list. A native select lets Tab go on. This listener sees Tab before the
  // list: the button gets the focus back, the list closes, and the browser moves the focus from the
  // button to the next (or, with Shift, the previous) field.
  let leave = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !context.isOpen) return
    event.stopPropagation()
    handle.props.onTab()
    context.close()
  }
  return () => {
    let { labelId, options } = handle.props
    return (
      <div
        class="select-popover"
        mix={[
          select.popover(),
          on<HTMLElement, 'keydown'>('keydown', leave, true),
          // After every listener of the event, the one of the library included.
          on<HTMLElement, 'toggle'>('toggle', (event) => {
            if (event.newState === 'closed') setTimeout(handle.props.onClosed)
          }),
        ]}
      >
        {/* The list has the name of the field. */}
        <div class="select-list" aria-labelledby={labelId ?? undefined} mix={select.list()}>
          {options.map((option) => (
            <div key={option.value} class="select-option" data-value={option.value} mix={select.option({ label: option.label, value: option.value, disabled: option.disabled })}>
              {option.label}
            </div>
          ))}
        </div>
      </div>
    )
  }
}

/** The label of the value, in the button. */
function SelectValue(handle: Handle<{ id: string }>) {
  let context = handle.context.get(select.Context)
  return () => (
    <span id={handle.props.id} class="select-value">
      {context.displayedLabel}
    </span>
  )
}

export const CustomSelect = clientEntry(import.meta.url, function CustomSelect(handle: Handle<CustomSelectProps>) {
  // The server renders nothing here, and so does the first render in the browser: it hydrates.
  let native: Native | null = null
  let hidden: HTMLInputElement | null = null
  let button: HTMLButtonElement | null = null
  // True from a Tab in the open list until the list has closed. When the list closes, the popover of
  // @remix-run/ui gives the focus back to the button; after a Tab, the focus is already on the next
  // field, and stays there.
  let tabbedOut = false
  let tabOut = () => {
    if (!button) return
    HTMLElement.prototype.focus.call(button, { preventScroll: true })
    tabbedOut = true
  }
  let keepButton = (node: HTMLButtonElement) => {
    button = node
    node.focus = (options) => {
      if (!tabbedOut) HTMLElement.prototype.focus.call(node, options)
    }
  }
  handle.queueTask(async () => {
    let focused = document.activeElement?.id === handle.props.target
    native = adopt(handle.props.target)
    if (!native) return
    await handle.update()
    if (focused) document.getElementById(handle.props.target)?.focus({ preventScroll: true })
  })

  return () => {
    if (!native) return null
    let { target } = handle.props
    let { name, value, label, disabled, form, describedBy, invalid, className, labelId, options } = native
    let valueId = `${target}-value`
    return (
      <select.Context name={name} defaultValue={value} defaultLabel={label} disabled={disabled}>
        <button
          type="button"
          id={target}
          class={`${className} select-button`}
          aria-labelledby={labelId ? `${labelId} ${valueId}` : undefined}
          // The value is in the name of the button. Empty, not undefined: without it @remix-run/ui
          // describes the button with the chosen option, and screen readers read the value twice.
          aria-describedby={describedBy ?? ''}
          aria-invalid={invalid === 'true' ? 'true' : undefined}
          mix={[
            select.trigger(),
            ref(keepButton),
            // The scripts of the screens (the filters of Findings, the switch of org) listen to
            // `change`, as they did on the native select: the hidden input sends it, with its new value.
            select.onSelectChange(() => {
              hidden?.dispatchEvent(new Event('change', { bubbles: true }))
            }),
          ]}
        >
          <SelectValue id={valueId} />
        </button>
        <popover.Context>
          <SelectPopover labelId={labelId} options={options} onTab={tabOut} onClosed={() => (tabbedOut = false)} />
        </popover.Context>
        {/* Disabled with the select: the form does not post it, as a disabled native select (Kentō #117783). */}
        <input form={form ?? undefined} disabled={disabled || undefined} data-select="" mix={[select.hiddenInput(), ref((node) => (hidden = node))]} />
      </select.Context>
    )
  }
})
