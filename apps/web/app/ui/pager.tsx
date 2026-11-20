import type { Handle } from 'remix/component'

import { buttonClass } from './controls.tsx'
import { ChevronLeftIcon, ChevronRightIcon } from './lucide.tsx'

/**
 * The numbers that the pager shows: the first and the last page, and the pages around the current
 * one. `null` is a gap. Seven places at most, so that the pager keeps its width from page to page.
 */
export function pageNumbers(page: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1)
  if (page <= 4) return [1, 2, 3, 4, 5, null, pages]
  if (page >= pages - 3) return [1, null, pages - 4, pages - 3, pages - 2, pages - 1, pages]
  return [1, null, page - 1, page, page + 1, null, pages]
}

export interface PagerProps {
  /** The page on screen, from 1. */
  page: number
  /** The pages of the list, 1 or more. */
  pages: number
  /** The rows before the page on screen. */
  offset: number
  /** The rows on screen. */
  shown: number
  /** The rows of the whole list (the filter and the search). */
  matching: number
  /** The link to a page of the same list: the filters and the search stay. */
  href: (page: number) => string
  /** The name of the `<nav>` for a screen reader. */
  label: string
}

/**
 * "26 to 50 of 122", Previous, the numbers of the pages, Next (KNT-146). Links only: no
 * JavaScript. Shown when the list has more than one page.
 */
export function Pager(handle: Handle<PagerProps>) {
  return () => {
    let { page, pages, offset, shown, matching, href, label } = handle.props
    if (pages <= 1 || shown === 0) return null
    return (
      <nav class="pager pager-numbered" aria-label={label}>
        <p class="pager-range">
          {offset + 1} to {offset + shown} of {matching}
        </p>
        <div class="pager-links">
          {page > 1 ? (
            <a class={buttonClass('outline', 'sm')} href={href(page - 1)} rel="prev">
              <ChevronLeftIcon />
              <span class="pager-step">Previous</span>
            </a>
          ) : (
            // Not a link and not focusable: its text says that there is no page before.
            <span class={buttonClass('outline', 'sm')} aria-disabled="true">
              <ChevronLeftIcon />
              <span class="pager-step">Previous</span>
              <span class="visually-hidden"> (no previous page)</span>
            </span>
          )}
          <ul class="pager-pages">
            {pageNumbers(page, pages).map((number) =>
              number === null ? (
                <li class="pager-gap" aria-hidden="true">
                  …
                </li>
              ) : (
                <li>
                  <a
                    class={buttonClass('outline', 'sm', 'pager-page')}
                    href={href(number)}
                    aria-current={number === page ? 'page' : undefined}
                  >
                    <span class="visually-hidden">Page </span>
                    {number}
                  </a>
                </li>
              ),
            )}
          </ul>
          {page < pages ? (
            <a class={buttonClass('outline', 'sm')} href={href(page + 1)} rel="next">
              <span class="pager-step">Next</span>
              <ChevronRightIcon />
            </a>
          ) : (
            <span class={buttonClass('outline', 'sm')} aria-disabled="true">
              <span class="pager-step">Next</span>
              <span class="visually-hidden"> (no next page)</span>
              <ChevronRightIcon />
            </span>
          )}
        </div>
      </nav>
    )
  }
}
