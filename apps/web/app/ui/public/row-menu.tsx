// KNT-163. The menu "…" of a row of the Repos screen (REV-91), on the menu and the popover of
// @remix-run/ui. The server renders a `<details>`: without JavaScript, its summary opens and
// closes it. In the browser the component hydrates that markup, then draws a menu button in its
// place: arrows, Home/End, typeahead, Escape, a click outside, one menu open at a time.
import { clientEntry, on, ref, type Handle } from 'remix/component'
import * as menu from '@remix-run/ui/menu'
import * as popover from '@remix-run/ui/popover'

import { pageRoutes } from '../../routes.ts'
import { ListChecksIcon, PowerOffIcon, SlidersIcon } from '../lucide.tsx'
import { ConfirmDetails, ConfirmDialog } from './confirm.tsx'
import { focusGuard, type FocusGuard } from './focus-guard.ts'

/**
 * The props of a row: the page writes them once more for the browser (25 rows, a budget of 110 KB
 * of HTML), so they are few, and the URLs are made here.
 */
export interface RowMenuProps {
  /** The id of the repository. */
  id: string
  /** Its full name. */
  name: string
  /** "Disable Kentō…": an admin, on an enabled repository. */
  disable?: boolean
  /** The query of the list, that the disable comes back to (`?page=2`). */
  back?: string
}

/** The findings of the repository: `findingsHref({ repoId })` of ../findings.tsx. */
export function repoFindingsHref(id: string): string {
  return `${pageRoutes.findings.href()}?${new URLSearchParams({ repo: id })}`
}

/** The form of the Repos screen that carries the CSRF token of every action of its rows (REV-36). */
const FORM = 'repo-actions'

/** What "Disable Kentō…" says. The icon only in the browser: see `RowMenu`. */
function DisableLabel(handle: Handle<{ name: string; icon?: boolean }>) {
  return () => (
    // The icon, then one flex item: the gap of .button would split the visible "Disable…".
    <>
      {handle.props.icon ? <PowerOffIcon /> : null}
      <span>
        Disable<span class="visually-hidden"> {handle.props.name}</span> Kentō…
      </span>
    </>
  )
}

function DisableText() {
  return () => <p>No new job starts, and the queued jobs are cancelled. The published reviews and the counter stay.</p>
}

export const RowMenu = clientEntry(import.meta.url, function RowMenu(handle: Handle<RowMenuProps>) {
  // The first render in the browser hydrates the HTML of the server; the menu comes after it.
  let enhanced = false
  let confirming = false
  let trigger: HTMLButtonElement | null = null
  /**
   * What the chosen item does once the menu has closed and given the focus back to its button: the
   * page comes back from the back/forward cache with its menu closed, and the confirmation gets the
   * focus after the menu took it back.
   */
  let afterClose: (() => void) | null = null
  let details: HTMLDetailsElement | null = null
  let box: HTMLElement | null = null
  /**
   * A click outside closes the menu, and the menu then gives the focus back to "…", a frame or two
   * later: it would take it from the field, or the other menu, that the person just clicked (Kentō
   * CI, repos.spec "Search shows at the keyboard"). That one call to `focus()` of "…" is dropped:
   * the focus stays where the click put it. The guard arms on the `click` that closes the menu (the
   * menu closes on `click`, not on `pointerdown`: a long press must not outlast it), and the next
   * action of the person disarms it: a later Escape or choice gives the focus back as before.
   */
  let guard: FocusGuard | null = null
  let focusTrigger = () => trigger && HTMLElement.prototype.focus.call(trigger, { preventScroll: true })
  handle.queueTask(async () => {
    // Registered before the menu renders, so before its own `click` listener on the document.
    guard = focusGuard(
      document,
      (event) => !(event.target instanceof Node && box?.contains(event.target)) && trigger?.getAttribute('aria-expanded') === 'true',
      handle.signal,
    )
    enhanced = true
    // The focus was in the `<details>` (a row that repo-toggle.js swapped focuses its "…"): it goes to the new button.
    let focused = details?.contains(document.activeElement) ?? false
    await handle.update()
    if (focused) focusTrigger()
  })

  let closeConfirm = async (focus: boolean) => {
    confirming = false
    await handle.update()
    if (focus) focusTrigger()
  }

  // A link of the menu: a plain click goes through the menu (it closes, then the page changes); a
  // click with a modifier keeps its native meaning (a new tab, a new window).
  let link = on<HTMLAnchorElement, 'click'>('click', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) event.stopImmediatePropagation()
    else event.preventDefault()
  })

  return () => {
    let { id: repoId, name, back } = handle.props
    let config = pageRoutes.repoConfig.href({ id: repoId })
    let findings = repoFindingsHref(repoId)
    let disable = handle.props.disable ? pageRoutes.repoDisable.href({ id: repoId }) + (back ?? '') : null
    if (!enhanced) {
      return (
        <details class="row-menu" mix={ref((node) => (details = node))}>
          {/* No class: kento.css styles `.row-menu > summary` and `> div`, the page holds 25 of them (budget of 110 KB). */}
          <summary aria-label={`Actions of ${name}`}>…</summary>
          {/*
           * No icon here: the page holds 25 of these menus, and the three icons weigh 0.9 KB a row. The
           * menu draws them once it hydrates, in the browser, where they cost no HTML.
           */}
          <div>
            <a href={config}>Open the config</a>
            <a href={findings}>See the findings</a>
            {disable ? (
              <ConfirmDetails trigger={<DisableLabel name={name} />} action={disable} csrf={null} form={FORM} submit={`Disable ${name}`}>
                <DisableText />
              </ConfirmDetails>
            ) : null}
          </div>
        </details>
      )
    }
    let id = `${handle.id}-trigger`
    return (
      <popover.Context>
        <span class="row-menu-box" mix={[ref((node) => (box = node)), popover.anchor({ placement: 'bottom-end', offset: 4 })]}>
          <menu.Context label={`Actions of ${name}`}>
            <button
              type="button"
              id={id}
              class="row-menu-trigger"
              aria-label={`Actions of ${name}`}
              mix={[
                ref((node) => {
                  trigger = node
                  let focus = node.focus.bind(node)
                  node.focus = (options?: FocusOptions) => {
                    if (!guard?.take()) focus(options)
                  }
                }),
                menu.trigger({ placement: 'bottom-end', offset: 4 }),
                on('focus', () => {
                  let next = afterClose
                  afterClose = null
                  next?.()
                }),
              ]}
            >
              …
            </button>
            <div class="row-menu-popover" mix={menu.popover()}>
              <div
                class="row-menu-list"
                mix={[
                  menu.list(),
                  menu.onMenuSelect((event) => {
                    let { name: item, value } = event.item
                    afterClose =
                      item === 'disable'
                        ? () => {
                            confirming = true
                            void handle.update()
                          }
                        : () => value && window.location.assign(value)
                  }),
                ]}
              >
                <a href={config} mix={[link, menu.item({ name: 'config', value: config })]}>
                  <SlidersIcon />
                  Open the config
                </a>
                <a href={findings} mix={[link, menu.item({ name: 'findings', value: findings })]}>
                  <ListChecksIcon />
                  See the findings
                </a>
                {disable ? (
                  <div id={`${handle.id}-disable`} class="row-menu-danger" mix={menu.item({ name: 'disable', label: 'Disable Kentō…' })}>
                    <DisableLabel name={name} icon />
                  </div>
                ) : null}
              </div>
            </div>
          </menu.Context>
        </span>
        {disable ? (
          <ConfirmDialog
            open={confirming}
            labelledBy={`${handle.id}-disable`}
            onClose={(focus) => void closeConfirm(focus)}
            action={disable}
            csrf={null}
            form={FORM}
            submit={`Disable ${name}`}
          >
            <DisableText />
          </ConfirmDialog>
        ) : null}
      </popover.Context>
    )
  }
})
