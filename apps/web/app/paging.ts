// KNT-146. The numbered pages of a list (`?page=n`): the reading of the query and the page that a
// count of rows allows. The screens (Repos, Findings) and their stores share these rules.

/** The highest `?page=` that a list reads: past it the number is noise, and the list shows its last page. */
export const PAGE_MAX = 100_000

/**
 * The number of the page in the query of a list: `?page=n`, from 1. A whole number in decimal
 * digits, with no sign and no leading zero, is a page: over `PAGE_MAX` it reads as `PAGE_MAX`, and
 * the store shows the last page. Anything else (missing, `0`, `-1`, `2.5`, `1e3`, `abc`) gives 1.
 */
export function readPageNumber(query: URLSearchParams): number {
  let value = query.get('page') ?? ''
  if (!/^[1-9][0-9]*$/.test(value)) return 1
  return Math.min(Number(value), PAGE_MAX)
}

/** The page that a list shows, from the page asked for and the rows that match. */
export interface PageWindow {
  /** The page on screen, from 1: the one asked for, or the last one. */
  page: number
  /** The pages of the list: 1 when nothing matches. */
  pages: number
  /** The rows before the page: the first row on screen is number `offset + 1`. */
  offset: number
}

/**
 * The page on screen and its offset. A page after the last one gives the last one, so that a list
 * that got shorter (a repository disabled in "Enabled", a finding dismissed) still shows rows. A page
 * that is not a whole number of 1 or more gives the first one. The offset stays under `matching`.
 */
export function pageWindow(asked: number | undefined, matching: number, limit: number): PageWindow {
  let pages = Math.max(1, Math.ceil(matching / limit))
  let wanted = asked !== undefined && Number.isSafeInteger(asked) && asked > 1 ? asked : 1
  let page = Math.min(wanted, pages)
  return { page, pages, offset: (page - 1) * limit }
}
