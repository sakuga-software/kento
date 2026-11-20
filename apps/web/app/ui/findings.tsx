import type { Handle } from 'remix/component'

import { isOneOf, SEVERITIES, UUID, type Severity } from '@sakuga-review/protocol'

import {
  DAYS_MAX,
  FINDING_VIEWS,
  LOGIN,
  SEARCH_MAX,
  type FindingFacets,
  type FindingQuery,
  type FindingRow,
  type FindingScreenPage,
  type FindingView,
} from '../findings/screen.ts'
import { BULK_MAX, type BulkStatus } from '../findings/dismiss.ts'
import { decodeCursor, REASON_MAX } from '../findings/store.ts'
import { pageRoutes as routes } from '../routes.ts'
import { PRECISION_DAYS, PRECISION_MIN, reasonText, type PrecisionReport } from '../findings/precision.ts'
import { agoOrDate, count, plural } from './format.ts'
import { DismissDialog } from './dismiss-dialog.tsx'
import { AlertIcon, CheckIcon } from './icons.tsx'
import { statusClass } from './pull.tsx'
import { PrecisionSection, shortName } from './precision.tsx'
import { Shell, type PageFrame } from './shell.tsx'

/** REV-102. The value of `type` that keeps the findings to consider only. */
export const CONSIDERED = 'to-consider'

/** REV-102. What the screens say of a finding to consider (REV-100). */
export const CONSIDERED_LABEL = 'To consider'
export const CONSIDERED_HINT = 'An earlier review already read this code. This finding does not block the pull request.'

/** The filters, the search and the page of the list, as the query of the screen gives them. */
export interface FindingList extends FindingQuery {
  view: FindingView
  repoId: string | null
  severity: Severity | null
  ruleId: string | null
  reason: string | null
  search: string
  /** REV-22. The pull requests of one person: the link "See my N open findings" of their screen. */
  author: string | null
  days: number | null
  /** REV-102. The findings to consider only (`?type=to-consider`). */
  considered: boolean
  after: string | null
  before: string | null
  /** REV-91. The tab of the screen: the list, or the precision (`?view=precision`). */
  tab: 'list' | 'precision'
}

export interface FindingsPageProps {
  frame: PageFrame
  page: FindingScreenPage
  facets: FindingFacets
  list: FindingList
  /** REV-18. The precision of the org over 30 days. */
  precision: PrecisionReport
  /** `https://github.com`, or the GitHub Enterprise Server: the links to the pull requests. */
  githubUrl: string
  /** For the dates of the screen. */
  now: Date
  /** What the screen says after "Mark dismissed" or "Mark wontfix", from the query of the redirect. */
  notice?: FindingsNotice | null
}

/** The answer of a change of status: how many changed, and how many replies GitHub got. */
export type FindingsNotice =
  | { kind: 'done'; status: BulkStatus; changed: number; unchanged: number; fixed: number; missing: number; failed: number; replied: number; unreplied: number }
  | { kind: 'error'; error: 'none' | 'too_many' | 'status' | 'reason' | 'reason_long' }

const NOTICE_ERRORS: Record<Extract<FindingsNotice, { kind: 'error' }>['error'], string> = {
  none: 'Check at least one finding, then choose the action.',
  too_many: `At most ${BULK_MAX} findings at a time.`,
  status: 'Choose "Mark dismissed" or "Mark wontfix".',
  reason: 'Choose a reason, or write it in "Other".',
  reason_long: `The reason holds ${REASON_MAX} characters at most.`,
}

/** The notice that a query of the screen carries, after a form. */
export function readFindingsNotice(query: URLSearchParams): FindingsNotice | null {
  let done = query.get('done')
  let count = (name: string) => Math.max(0, Math.trunc(Number(query.get(name)) || 0))
  if (done === 'dismissed' || done === 'wontfix') {
    return {
      kind: 'done',
      status: done,
      changed: count('n'),
      unchanged: count('same'),
      fixed: count('fixed'),
      missing: count('missing'),
      failed: count('failed'),
      replied: count('replied'),
      unreplied: count('unreplied'),
    }
  }
  let error = query.get('error')
  if (error && error in NOTICE_ERRORS) return { kind: 'error', error: error as keyof typeof NOTICE_ERRORS }
  return null
}

/** The id of the form of the selection: its checkboxes sit in the rows of the table. */
const BULK_FORM = 'findings-bulk'

const VIEW_LABELS: Record<FindingView, string> = {
  open: 'open',
  fixed: 'fixed',
  dismissed: 'dismissed',
  wontfix: 'wontfix',
  stale: 'stale',
  closed: 'closed',
  all: 'all',
}

/** The priority of a severity, as the comments of the bot write it (engine/render.ts). */
const PRIORITY: Record<Severity, { label: string; tag: string; name: string }> = {
  critical: { label: 'P0', tag: 'tag-alert', name: 'critical' },
  major: { label: 'P1', tag: 'tag-warn', name: 'major' },
  minor: { label: 'P2', tag: 'tag-quiet', name: 'minor' },
}

const CATEGORY_LABELS: Record<string, string> = {
  bug: 'Bug',
  security: 'Security',
  data: 'Data',
  contract: 'Contract',
  test: 'Test',
}

/** A cursor that does not decode is dropped at once: it leaves the URL of the list and of its links. */
function cursorOf(value: string | null): string | null {
  try {
    return decodeCursor(value) ? value : null
  } catch {
    return null
  }
}

/** The list that a query of the screen asks for. A value that the screen does not know is ignored. */
export function readFindingList(query: URLSearchParams): FindingList {
  let view = query.get('status')
  let after = cursorOf(query.get('after'))
  let severity = query.get('priority')
  let repo = query.get('repo')
  let rule = query.get('rule')
  let author = query.get('author')
  let days = query.get('days')
  return {
    view: isOneOf(FINDING_VIEWS, view) ? view : 'open',
    repoId: repo && UUID.test(repo) ? repo : null,
    severity: isOneOf(SEVERITIES, severity) ? severity : null,
    ruleId: rule && UUID.test(rule) ? rule : null,
    reason: reasonText(query.get('reason') ?? '') || null,
    search: (query.get('q') ?? '').trim().slice(0, SEARCH_MAX),
    author: author && LOGIN.test(author) ? author : null,
    days: days !== null && /^\d{1,3}$/.test(days) && Number(days) >= 1 && Number(days) <= DAYS_MAX ? Number(days) : null,
    considered: query.get('type') === CONSIDERED,
    after,
    before: after ? null : cursorOf(query.get('before')),
    tab: query.get('view') === 'precision' ? 'precision' : 'list',
  }
}

/** The query of a list: what `readFindingList` reads back. Empty for the first page of the open findings. */
export function findingListQuery(list: Partial<FindingList>): URLSearchParams {
  let query = new URLSearchParams()
  if (list.view && list.view !== 'open') query.set('status', list.view)
  if (list.repoId) query.set('repo', list.repoId)
  if (list.severity) query.set('priority', list.severity)
  if (list.ruleId) query.set('rule', list.ruleId)
  if (list.reason) query.set('reason', list.reason)
  if (list.search) query.set('q', list.search)
  if (list.author) query.set('author', list.author)
  if (list.days) query.set('days', String(list.days))
  if (list.considered) query.set('type', CONSIDERED)
  if (list.after) query.set('after', list.after)
  else if (list.before) query.set('before', list.before)
  if (list.tab === 'precision') query.set('view', 'precision')
  return query
}

/** `/findings`, with the query of a list when it has one. */
export function findingsHref(list: Partial<FindingList>): string {
  let query = findingListQuery(list).toString()
  return query ? `${routes.findings.href()}?${query}` : routes.findings.href()
}

/** The filters of a list without its page: a new filter or tab starts at the first page. */
function filtersOf(list: FindingList): Partial<FindingList> {
  return {
    view: list.view,
    repoId: list.repoId,
    severity: list.severity,
    ruleId: list.ruleId,
    reason: list.reason,
    search: list.search,
    author: list.author,
    days: list.days,
    considered: list.considered,
  }
}

function hasFilters(list: FindingList): boolean {
  return Boolean(list.repoId || list.severity || list.ruleId || list.reason || list.search || list.author || list.days || list.considered)
}

/**
 * The Findings screen (REV-18): every finding of the org, filtered by repository, status, priority,
 * rule and a search, a page of 50 at a time.
 */
/** "Precision over 30 d: 78% (n = 40)", or "n = 5 of 10" under the minimum, for the lead of the screen. */
export function precisionLead(report: PrecisionReport): string {
  let org = report.org
  let value = org.rate === null ? `n = ${org.closed} of ${PRECISION_MIN}` : `${Math.round(org.rate * 100)}% (n = ${org.closed})`
  return `Each finding of the reviews of Kentō, and what became of it. Precision over ${PRECISION_DAYS} d: ${value}.`
}

export function FindingsPage(handle: Handle<FindingsPageProps>) {
  return () => {
    let { frame, page, facets, list, precision, githubUrl, now, notice } = handle.props
    let org = frame.viewer!.org.name
    // REV-18: an admin sets findings aside; a member reads.
    let admin = frame.viewer!.role === 'admin'
    let none = page.counts.all === 0 && !hasFilters(list)
    let tabs = (
      <nav class="tabs" aria-label="Views of the findings">
        <a href={findingsHref({ ...filtersOf(list), tab: 'list' })} aria-current={list.tab === 'list' ? 'page' : undefined}>
          List
        </a>
        {/* The filters ride along, unused by the precision: "List" gives them back. */}
        <a href={findingsHref({ ...filtersOf(list), tab: 'precision' })} aria-current={list.tab === 'precision' ? 'page' : undefined}>
          Precision
        </a>
      </nav>
    )
    return (
      <Shell frame={frame} section="findings" title="Findings" lead={precisionLead(precision)} tabs={tabs}>
        {notice ? <Notice notice={notice} /> : null}
        {list.tab === 'precision' ? (
          <PrecisionSection report={precision} org={org} />
        ) : none ? (
          <section class="empty" aria-labelledby="empty-title">
            <h2 id="empty-title">No finding yet</h2>
            <p>
              Each finding of a review that Kentō publishes will show here, with its status: open, fixed when a push fixes it,
              dismissed or wontfix when a person sets it aside. <a href={routes.repos.href()}>See the repos</a>
            </p>
          </section>
        ) : (
          <>
            <FilterForm list={list} facets={facets} org={org} />
            {list.reason ? (
              <p class="findings-reason">
                Reason "{list.reason}" · <a href={findingsHref({ ...filtersOf(list), reason: null })}>Remove this filter</a>
              </p>
            ) : null}
            {list.author || list.days ? (
              <p class="findings-reason">
                {list.author ? `Pull requests of @${list.author}` : 'All pull requests'}
                {list.days ? ` · last ${list.days} days` : ''} ·{' '}
                <a href={findingsHref({ ...filtersOf(list), author: null, days: null })}>Remove this filter</a>
              </p>
            ) : null}
            <nav class="segmented-links findings-views" aria-label="Status of the findings">
              {FINDING_VIEWS.map((view) => (
                <a href={findingsHref({ ...filtersOf(list), view })} aria-current={view === list.view ? 'page' : undefined}>
                  {VIEW_LABELS[view]} <span class="list-filter-count">{count(page.counts[view])}</span>
                </a>
              ))}
            </nav>
            {page.rows.length === 0 ? (
              <Empty page={page} list={list} />
            ) : (
              <div class="table-wrap findings-wrap">
                <table class="table findings-table">
                  <caption class="visually-hidden">
                    {VIEW_LABELS[list.view]} findings of {org}, from the most recent to the oldest
                  </caption>
                  <thead>
                    <tr>
                      {admin ? (
                        <th scope="col" class="finding-check">
                          {/* public/assets/findings.js shows it: without JavaScript, each row is checked by hand. */}
                          <input type="checkbox" id="findings-all" data-select-all hidden aria-label="Select all the findings of the page" />
                        </th>
                      ) : null}
                      <th scope="col">Finding</th>
                      <th scope="col">Status</th>
                      <th scope="col">Found again</th>
                      <th scope="col">Pull request</th>
                      <th scope="col">Source</th>
                      <th scope="col" class="num">
                        Confidence
                      </th>
                      <th scope="col" class="num">
                        Since
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((row) => (
                      <FindingTableRow row={row} org={org} githubUrl={githubUrl} now={now} select={admin} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pager page={page} list={list} />
            {admin && page.rows.length > 0 ? <BulkBar csrf={frame.csrfToken} back={findingListQuery(list).toString()} /> : null}
            {/* One load for every person: the filters apply on change; the selection, when the bar is there. */}
            <script src={`/assets/findings.js?v=${encodeURIComponent(frame.assetVersion)}`} defer></script>
          </>
        )}
      </Shell>
    )
  }
}

/** The search, and the filters of the list. A GET form: no JavaScript, and the URL keeps them. */
function FilterForm(handle: Handle<{ list: FindingList; facets: FindingFacets; org: string }>) {
  return () => {
    let { list, facets, org } = handle.props
    return (
      <form class="findings-filters" method="get" action={routes.findings.href()} role="search" aria-label="Filter the findings">
        {list.view !== 'open' ? <input type="hidden" name="status" value={list.view} /> : null}
        {list.reason ? <input type="hidden" name="reason" value={list.reason} /> : null}
        {list.author ? <input type="hidden" name="author" value={list.author} /> : null}
        {list.days ? <input type="hidden" name="days" value={String(list.days)} /> : null}
        <div class="findings-filter findings-filter-search">
          <label class="field-label" for="findings-q">
            Search
          </label>
          <input
            class="input"
            id="findings-q"
            type="search"
            name="q"
            value={list.search}
            maxlength={SEARCH_MAX}
            placeholder="Title or path"
            autocomplete="off"
          />
        </div>
        <div class="findings-filter">
          <label class="field-label" for="findings-repo">
            Repo
          </label>
          <select class="input" id="findings-repo" name="repo">
            <option value="" selected={!list.repoId}>
              All repos
            </option>
            {facets.repos.map((repo) => (
              <option value={repo.id} selected={repo.id === list.repoId}>
                {shortName(repo.fullName, org)}
              </option>
            ))}
          </select>
        </div>
        <div class="findings-filter">
          <label class="field-label" for="findings-priority">
            Priority
          </label>
          <select class="input" id="findings-priority" name="priority">
            <option value="" selected={!list.severity}>
              All
            </option>
            {SEVERITIES.map((severity) => (
              <option value={severity} selected={severity === list.severity}>
                {PRIORITY[severity].label} · {PRIORITY[severity].name}
              </option>
            ))}
          </select>
        </div>
        <div class="findings-filter">
          <label class="field-label" for="findings-rule">
            Source
          </label>
          {/* With no rule, "Review and rules" is the only choice: the list says so and stays still. */}
          {/* A disabled select is not sent: a rule of the URL that the org no longer has stays in the list. */}
          {facets.rules.length === 0 && list.ruleId ? <input type="hidden" name="rule" value={list.ruleId} /> : null}
          <select class="input" id="findings-rule" name="rule" disabled={facets.rules.length === 0}>
            <option value="" selected={!list.ruleId}>
              Review and rules
            </option>
            {facets.rules.map((rule) => (
              <option value={rule.id} selected={rule.id === list.ruleId}>
                {rule.repo ? `${shortName(rule.repo, org)} · ${rule.title}` : `Org · ${rule.title}`}
              </option>
            ))}
          </select>
        </div>
        <div class="findings-filter">
          <label class="field-label" for="findings-type">
            Type
          </label>
          {/* REV-102: the findings that the last review lists under "To consider (code already reviewed)". */}
          <select class="input" id="findings-type" name="type">
            <option value="" selected={!list.considered}>
              All findings
            </option>
            <option value={CONSIDERED} selected={list.considered}>
              To consider (code already reviewed)
            </option>
          </select>
        </div>
        <div class="findings-filter-actions">
          {/* REV-91: with JavaScript a filter applies on change (findings.js); "Filter" serves a browser without it. */}
          <button class="button findings-submit" type="submit">
            Filter
          </button>
          {hasFilters(list) ? (
            <a class="button button-ghost" href={findingsHref({ view: list.view })}>
              Clear the filters
            </a>
          ) : null}
        </div>
      </form>
    )
  }
}

/** No row in the tab: say which filters, and where the findings are. */
function Empty(handle: Handle<{ page: FindingScreenPage; list: FindingList }>) {
  return () => {
    let { page, list } = handle.props
    let filtered = hasFilters(list)
    let label = VIEW_LABELS[list.view].toLowerCase()
    let closed = page.counts.closed
    return (
      <section class="empty" aria-labelledby="empty-title">
        <h2 id="empty-title">
          {list.view === 'all'
            ? 'No finding for these filters'
            : list.view === 'closed'
              ? `No closed finding${filtered ? ' for these filters' : ''}`
              : `No ${label} finding${filtered ? ' for these filters' : ''}`}
        </h2>
        <p>
          {list.view === 'open' && closed > 0 ? (
            <>
              <a href={findingsHref({ ...filtersOf(list), view: 'closed' })}>
                See {closed > 1 ? `the ${count(closed)} closed findings` : 'the closed finding'}
              </a>
              {filtered ? ' · ' : null}
            </>
          ) : list.view !== 'all' && page.counts.all > 0 ? (
            <>
              <a href={findingsHref({ ...filtersOf(list), view: 'all' })}>
                See {page.counts.all > 1 ? `the ${count(page.counts.all)} findings` : 'the finding'} of all statuses
              </a>
              {filtered ? ' · ' : null}
            </>
          ) : null}
          {filtered ? <a href={findingsHref({ view: list.view })}>Clear the filters</a> : null}
        </p>
      </section>
    )
  }
}

function FindingTableRow(handle: Handle<{ row: FindingRow; org: string; githubUrl: string; now: Date; select: boolean }>) {
  return () => {
    let { row, org, githubUrl, now, select } = handle.props
    let priority = PRIORITY[row.severity]
    let pullUrl = `${githubUrl}/${row.repo}/pull/${row.prNumber}`
    let seenAgain = row.lastSeenSha !== row.firstSeenSha
    return (
      <tr id={`finding-${row.id}`}>
        {select ? (
          <td class="finding-check">
            {row.status !== 'fixed' ? (
              <input
                type="checkbox"
                name="ids"
                value={row.id}
                form={BULK_FORM}
                id={`select-${row.id}`}
                aria-label={`Select "${row.title}"`}
              />
            ) : null}
          </td>
        ) : null}
        <th scope="row">
          <span class="finding-cell">
            <span class={`pri pri-${row.severity}`} title={`Priority ${priority.name}`}>
              {priority.label}
            </span>
            <span class="finding-text">
              {row.githubCommentId !== null ? (
                <a class="finding-title" href={`${pullUrl}#discussion_r${row.githubCommentId}`} rel="noreferrer">
                  {row.title}
                </a>
              ) : (
                <span class="finding-title">{row.title}</span>
              )}
              <span class="mono finding-path">
                {row.path}:{row.line}
                {row.considered ? (
                  <>
                    {' '}
                    <span class="tag tag-info" title={CONSIDERED_HINT}>
                      {CONSIDERED_LABEL}
                    </span>
                  </>
                ) : null}
              </span>
            </span>
          </span>
        </th>
        <td data-label="Status">
          <span class="stack">
            <span class={`status status-mono ${statusClass(row.status)}`}>{row.status}</span>
            {row.statusReason ? <span class="hint">{row.statusReason}</span> : null}
          </span>
        </td>
        <td data-label="Found again">
          {seenAgain ? (
            <span class="stack">
              <span>yes</span>
              <span class="hint mono">{row.lastSeenSha.slice(0, 7)}</span>
            </span>
          ) : (
            <>
              <span aria-hidden="true">–</span>
              <span class="visually-hidden">no</span>
            </>
          )}
        </td>
        <td data-label="Pull request">
          <span class="stack">
            <a href={pullUrl} rel="noreferrer">
              #{row.prNumber}
            </a>
            <span class="hint">{shortName(row.repo, org)}</span>
          </span>
        </td>
        <td data-label="Source">
          {row.ruleTitle ? (
            <span class="stack">
              <span>Rule</span>
              <span class="hint">{row.ruleTitle}</span>
            </span>
          ) : (
            <span class="stack">
              <span>Review</span>
              <span class="hint">{(CATEGORY_LABELS[row.category] ?? row.category).toLowerCase()}</span>
            </span>
          )}
        </td>
        <td data-label="Confidence" class="num mono">
          {row.confidence}%
        </td>
        <td data-label="Since" class="num mono">
          <time datetime={row.createdAt.toISOString()}>{agoOrDate(row.createdAt, now)}</time>
        </td>
      </tr>
    )
  }
}

/** "1 to 50 of 1,234 findings", and the links to the pages around. Shown when the tab has more than a page. */
function Pager(handle: Handle<{ page: FindingScreenPage; list: FindingList }>) {
  return () => {
    let { page, list } = handle.props
    if (page.rows.length === 0 || (page.next === null && page.previous === null)) return null
    let from = page.offset + 1
    let to = page.offset + page.rows.length
    let filters = filtersOf(list)
    return (
      <nav class="pager findings-pager" aria-label="Pages of the list">
        <p class="pager-range">
          {count(from)} to {count(to)} of {count(page.matching)} {plural(page.matching, 'finding')}
        </p>
        <span class="pager-links">
          {page.previous ? (
            <a class="button button-small" href={findingsHref({ ...filters, before: page.previous })} rel="prev">
              Previous
            </a>
          ) : (
            <span class="button button-small" aria-disabled="true">
              Previous
            </span>
          )}
          {page.next ? (
            <a class="button button-small" href={findingsHref({ ...filters, after: page.next })} rel="next">
              Next
            </a>
          ) : (
            <span class="button button-small" aria-disabled="true">
              Next
            </span>
          )}
        </span>
      </nav>
    )
  }
}

/**
 * REV-18. The actions on the findings checked in the table: "Mark dismissed…" with the dialog of
 * the reason (shared with the screen of a pull request), and "Mark wontfix". Each finding
 * changed gets a reply in its thread on GitHub. REV-91: a bar that floats at the foot of the screen;
 * with JavaScript it shows once a finding is checked, with "Deselect".
 */
function BulkBar(handle: Handle<{ csrf: string | null; back: string }>) {
  return () => {
    let { csrf, back } = handle.props
    return (
      <>
        <form id={BULK_FORM} method="post" action={routes.findingsStatus.href()} hidden>
          {csrf ? <input type="hidden" name="_csrf" value={csrf} /> : null}
          <input type="hidden" name="back" value={back} />
        </form>
        <div class="findings-bulk" role="group" aria-label="Actions on the checked findings" data-bulk>
          <p class="findings-selected" data-selected aria-live="polite">
            Check findings to mark them.
          </p>
          <DismissDialog id="bulk" form={BULK_FORM} trigger="Mark dismissed…" submit="Mark dismissed" />
          <button class="button" type="submit" form={BULK_FORM} name="status" value="wontfix">
            Mark wontfix
          </button>
          <button class="button button-ghost findings-clear" type="button" data-select-none hidden>
            Deselect
          </button>
        </div>
      </>
    )
  }
}

function Notice(handle: Handle<{ notice: FindingsNotice }>) {
  return () => {
    let { notice } = handle.props
    if (notice.kind === 'error') {
      return (
        <div class="banner banner-alert" role="alert">
          <AlertIcon />
          <p>
            <strong>Nothing changed.</strong> {NOTICE_ERRORS[notice.error]}
          </p>
        </div>
      )
    }
    let { status, changed, unchanged, fixed, missing, failed, replied, unreplied } = notice
    let alert = unreplied > 0 || failed > 0 || missing > 0
    return (
      <div class={alert ? 'banner banner-alert' : 'banner banner-ok'} role="status">
        {alert ? <AlertIcon /> : <CheckIcon />}
        <p>
          <strong>
            {changed} {plural(changed, 'finding')} marked {status}.
          </strong>{' '}
          {replied > 0 ? `${replied} ${plural(replied, 'reply', 'replies')} posted in the GitHub threads. ` : ''}
          {unreplied > 0
            ? `${unreplied} ${plural(unreplied, 'thread', 'threads')} got no reply. GitHub refused or did not answer. Kentō saved the status all the same. `
            : ''}
          {unchanged > 0 ? `${unchanged} already had this status and this reason. ` : ''}
          {fixed > 0 ? `${fixed} fixed ${plural(fixed, 'finding stays', 'findings stay')} as is. A push fixed ${plural(fixed, 'it', 'them')}. ` : ''}
          {missing > 0
            ? `${missing} ${plural(missing, 'finding no longer exists', 'findings no longer exist')} in this organization, for example because someone removed the repo after the page loaded. The list below is up to date. `
            : ''}
          {failed > 0 ? `Kentō could not save ${failed} ${plural(failed, 'finding')}. Try again.` : ''}
        </p>
      </div>
    )
  }
}
