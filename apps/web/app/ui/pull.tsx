import { isOneOf, LEVELS, type Level } from '@kento/protocol'
import type { Handle } from 'remix/component'

import { assignmentLine } from '../assignment/model.ts'
import { FINDING_STATUSES, type FindingStatus } from '../findings/store.ts'
import type { PullHeader } from '../pulls/github.ts'
import { CELL_LABELS, STATUS_LABELS, type Cell } from '../pulls/sheet.ts'
import type { PullActiveJob, PullFinding, PullReview, PullSheet, PullSummary } from '../pulls/store.ts'
import { pageRoutes, pullRoutes } from '../routes.ts'
import { Button, buttonClass } from './controls.tsx'
import { agoOrDate, clock, duration, plural, usdPrecise } from './format.ts'
import { ExternalIcon } from './icons.tsx'
import { Shell, type PageFrame } from './shell.tsx'

/** What the screen says after "Run again", from `?rerun=`. */
export const RERUN_NOTICES = {
  queued: 'Review started again. It is queued. A new push cancels it.',
  already: 'A review of this level is already queued or in progress on this commit.',
  stale: 'GitHub has a more recent commit than the last review. Kentō reviews its push, and nothing starts again.',
  closed: 'The pull request is closed on GitHub, so nothing starts again.',
  capped: 'The organization reached its cost cap, so nothing starts again. An admin changes it in Settings.',
  github_failed: 'GitHub did not answer, and nothing starts again. Try again in a moment.',
  missing: 'Nothing starts again. The repo is no longer enabled, or the installation is suspended.',
} as const
export type RerunNotice = keyof typeof RERUN_NOTICES

/** The badge of a severity, as the comments of the bot write it on GitHub. */
export const SEVERITY_BADGES: Record<PullFinding['severity'], string> = { critical: 'P0', major: 'P1', minor: 'P2' }

/** The query of the screen: the status filter and the two cursors. */
export interface PullQuery {
  statuses: FindingStatus[]
  /** The cursor of the older reviews (`?before=`). */
  reviews: string | null
  /** The cursor of the next findings (`?after=`). */
  rows: string | null
}

/** Reads `?status=open&status=fixed&before=…&after=…`. An unknown status is left out. */
export function readPullQuery(query: URLSearchParams): PullQuery {
  let statuses = query.getAll('status').filter((s): s is FindingStatus => isOneOf(FINDING_STATUSES, s))
  return { statuses: [...new Set(statuses)], reviews: query.get('before') || null, rows: query.get('after') || null }
}

/** The address of the screen with this query. */
export function pullHref(repoId: string, prNumber: number, query: Partial<PullQuery> = {}): string {
  let params = new URLSearchParams()
  for (let s of query.statuses ?? []) params.append('status', s)
  if (query.reviews) params.set('before', query.reviews)
  if (query.rows) params.set('after', query.rows)
  let search = params.toString()
  return `${pullRoutes.pull.href({ id: repoId, number: String(prNumber) })}${search ? `?${search}` : ''}`
}

export function pullUrl(githubUrl: string, fullName: string, prNumber: number): string {
  let [owner, name] = fullName.split('/')
  return `${githubUrl}/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/pull/${prNumber}`
}

const short = (sha: string) => sha.slice(0, 7)

/** "4/5, +1 since R3": the last score and how it moved since the review before. */
export function scoreProgress(summary: Pick<PullSummary, 'lastScores' | 'reviews'>): { value: string; change: string | null } {
  let [last, previous] = summary.lastScores
  if (last === undefined) return { value: '—', change: null }
  if (previous === undefined) return { value: `${last}/5`, change: null }
  let delta = last - previous
  let since = `since R${summary.reviews - 1}`
  return { value: `${last}/5`, change: delta === 0 ? `unchanged ${since}` : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} ${since}` }
}

export interface PullPageProps {
  frame: PageFrame
  summary: PullSummary
  /** Null when GitHub did not answer, or without the GitHub App: the screen shows what Kentō holds. */
  header: PullHeader | null
  sheet: PullSheet
  query: PullQuery
  githubUrl: string
  now: Date
  /** The estimate of a review of each level, for an admin; null for a member (no "Run again"). */
  estimates?: Record<Level, number | null> | null
  rerunNotice?: RerunNotice | null
}

/**
 * REV-21. What chose the level of the last review job: the assignment rule that matched, the
 * command, the retry, the preference of the author, or the level of the repository. Null for a job
 * queued before REV-21.
 */
export function levelLine(summary: Pick<PullSummary, 'assignment' | 'levelOrigin'>): string | null {
  let origin = summary.levelOrigin
  if (!origin) return null
  switch (origin.source) {
    case 'rule':
      return summary.assignment ? assignmentLine(summary.assignment) : `Assignment: an assignment rule chose ${origin.level}.`
    case 'command':
      return `Level ${origin.level}: a command asked for it, so the assignment rules do not apply.`
    case 'retry':
      return `Level ${origin.level}: chosen at the retry from the dashboard.`
    case 'preference':
      return `Level ${origin.level}: preference of the author, no assignment rule matches.`
    case 'repo':
      return `Level ${origin.level}: the level of the repo, no assignment rule matches.`
  }
}

/** The words of the verdict on the stamp of the last review (REV-91). */
const STAMPS: Record<string, string> = {
  APPROVE: 'Approved',
  COMMENT: 'Comment',
  REQUEST_CHANGES: 'Changes requested',
}

/** The first sentence of a summary, at most 240 characters: the card says it in one line. */
export function firstSentence(summary: string | null): string | null {
  let text = (summary ?? '').trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim() ?? ''
  if (!text) return null
  let end = text.search(/[.!?](\s|$)/)
  let sentence = end === -1 ? text : text.slice(0, end + 1)
  return sentence.length > 240 ? `${sentence.slice(0, 239).trimEnd()}…` : sentence
}

/** A model id without its provider: `anthropic/claude-sonnet-5.5` reads `claude-sonnet-5.5`. */
export function modelName(model: string): string {
  return model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
}

/** The level in the head of a column, as the board writes it: lite, bal., heavy. */
const LEVEL_SHORT: Record<Level, string> = { lite: 'lite', balanced: 'bal.', heavy: 'heavy' }

export function PullPage(handle: Handle<PullPageProps>) {
  return () => {
    let { frame, summary, header, sheet, query, githubUrl, now, estimates, rerunNotice } = handle.props
    let { target } = summary
    let repoName = target.fullName.split('/')[1] ?? target.fullName
    let progress = scoreProgress(summary)
    let total = FINDING_STATUSES.reduce((n, s) => n + summary.byStatus[s], 0)
    let base = header?.baseRef || summary.baseRef
    let state = header ? (header.state === 'open' ? 'open' : header.state === 'merged' ? 'merged' : 'closed') : null
    let canRerun = !!estimates && !summary.active && header?.state !== 'closed' && header?.state !== 'merged'
    // The card of the last review shows on the newest page only: an older page has older columns.
    let last = query.reviews ? null : (sheet.columns.at(-1) ?? null)
    return (
      <Shell
        frame={frame}
        section="repos"
        title={header?.title || `${repoName} #${target.prNumber}`}
        actions={canRerun ? <RerunMenu summary={summary} estimates={estimates!} csrf={frame.csrfToken ?? ''} /> : undefined}
        memberCan="you can dismiss, keep (won't fix) or reopen a finding from its detail"
        before={
          <nav class="crumbs" aria-label="Breadcrumb">
            <a href={pageRoutes.repos.href()}>Repos</a>
            <span aria-hidden="true">/</span>
            <a href={pageRoutes.repoConfig.href({ id: target.repoId })} title={target.fullName}>
              {repoName}
            </a>
            <span aria-hidden="true">/</span>
            <span aria-current="page">#{target.prNumber}</span>
          </nav>
        }
      >
        <p class="pull-meta">
          <span class="mono">
            {repoName} #{target.prNumber}
          </span>
          <span>by {header?.author ? `@${header.author}` : 'an unknown author'}</span>
          <span class="mono">
            {header?.headRef || '?'} → {base || '?'}
          </span>
          <span class="mono" title="The last commit of the pull request">
            {short(header?.headSha || summary.headSha)}
          </span>
          {state ? <span class={`status ${header!.state === 'open' ? 'status-open' : 'status-neutral'}`}>{state}</span> : null}
          <a href={pullUrl(githubUrl, target.fullName, target.prNumber)}>
            Open on GitHub
            <ExternalIcon />
          </a>
        </p>
        {levelLine(summary) ? <p class="pull-assignment">{levelLine(summary)}</p> : null}
        {header ? null : <p class="hint pull-github-note">GitHub did not answer. The title, the author and the branches are missing.</p>}

        <section aria-label="At a glance">
        <dl class="pull-stats">
          <div>
            <dt>Reviews</dt>
            <dd>{summary.reviews}</dd>
          </div>
          <div>
            <dt>Score</dt>
            <dd>
              {progress.value}
              {progress.change ? <span class={progress.change.startsWith('+') ? 'pull-up' : 'pull-same'}> {progress.change}</span> : null}
            </dd>
          </div>
          <div>
            <dt>Findings</dt>
            <dd>
              {total}
              {total > 0
                ? ` · ${FINDING_STATUSES.filter((s) => summary.byStatus[s] > 0)
                    .map((s) => `${summary.byStatus[s]} ${STATUS_LABELS[s]}`)
                    .join(' · ')}`
                : ''}
            </dd>
          </div>
          <div>
            <dt>Total cost</dt>
            <dd>{summary.costUsd === null ? '—' : usdPrecise(summary.costUsd)}</dd>
          </div>
        </dl>
        </section>

        {rerunNotice ? (
          <div class={`banner ${rerunNotice === 'queued' ? 'banner-ok' : 'banner-info'}`} role="status">
            <p>{RERUN_NOTICES[rerunNotice]}</p>
          </div>
        ) : null}

        {summary.active ? <ActiveBanner job={summary.active} now={now} /> : null}

        {last ? <LastReview review={last} now={now} /> : null}

        <section class="pull-sheet" aria-labelledby="sheet-title">
          <div class="pull-sheet-head">
            <h2 id="sheet-title" class="section-title">
              Exposure sheet
            </h2>
            <SheetHelp />
            <StatusFilter summary={summary} query={query} />
          </div>
          <SheetTable summary={summary} sheet={sheet} query={query} now={now} />
        </section>
      </Shell>
    )
  }
}

/** REV-91. The last review: its verdict on a stamp, its facts, its summary in one sentence. */
function LastReview(handle: Handle<{ review: PullReview; now: Date }>) {
  return () => {
    let { review, now } = handle.props
    let stamp = review.verdict ? STAMPS[review.verdict] : undefined
    let sentence = firstSentence(review.summary)
    return (
      <section class="card pull-last" aria-labelledby="last-title">
        {stamp ? (
          <p class={`stamp stamp-${review.verdict === 'APPROVE' ? 'ok' : review.verdict === 'REQUEST_CHANGES' ? 'alert' : 'note'}`}>
            <span class="stamp-text">{stamp}</span>
            <span class="stamp-score">{review.score}/5</span>
          </p>
        ) : (
          <p class="stamp stamp-note">
            <span class="stamp-score">{review.score}/5</span>
          </p>
        )}
        <div class="pull-last-body">
          <h2 id="last-title" class="pull-last-title">
            Last review, R{review.number}
          </h2>
          <p class="pull-last-facts mono">
            {review.level} · {modelName(review.model)} · {short(review.headSha)} ·{' '}
            {review.costUsd === null ? 'unknown cost' : usdPrecise(review.costUsd)}
            {review.durationMs === null ? '' : ` · ${duration(review.durationMs)}`} ·{' '}
            <time dateTime={review.createdAt.toISOString()} title={clock(review.createdAt)}>
              {agoOrDate(review.createdAt, now)}
            </time>
          </p>
          {sentence ? <p class="pull-last-summary">{sentence}</p> : null}
          {review.publishedAt ? null : <p class="status status-stale">Not published</p>}
        </div>
        {/* The design shows a seal per pass (security, data, logic, rules, check); no level runs passes yet. */}
        <p class="pull-passes hint">One pass per review. The separate passes do not run yet.</p>
      </section>
    )
  }
}

function ActiveBanner(handle: Handle<{ job: PullActiveJob; now: Date }>) {
  return () => {
    let { job, now } = handle.props
    return (
      <div class="banner banner-info pull-active" role="status">
        <p>
          <strong>
            R{job.number} {job.state === 'running' ? 'in progress' : 'queued'}…
          </strong>{' '}
          {job.level} review of <span class="mono">{short(job.headSha)}</span>, asked {agoOrDate(job.createdAt, now)}. A new
          push cancels it.
        </p>
      </div>
    )
  }
}

const LEVEL_DEFAULT_HINT = 'The estimate is the mean of the last reviews of this level on this repo.'

/** "Run R5 again…" beside the title: it opens the three levels with their estimate (confirm.js closes it on Escape). */
function RerunMenu(handle: Handle<{ summary: PullSummary; estimates: Record<Level, number | null>; csrf: string }>) {
  return () => {
    let { summary, estimates, csrf } = handle.props
    let { repoId, prNumber } = summary.target
    return (
      <details class="confirm pull-rerun" data-confirm>
        <summary class={buttonClass()}>Run R{summary.reviews + 1}…</summary>
        <div class="confirm-body" role="group" aria-labelledby="rerun-title">
          <p id="rerun-title" class="pull-rerun-title">
            Run R{summary.reviews + 1}
          </p>
          <p class="hint">
            A new review of <span class="mono">{short(summary.headSha)}</span>, the last reviewed commit. A new push cancels it. {LEVEL_DEFAULT_HINT}
          </p>
          <div class="pull-rerun-actions">
            {LEVELS.map((level) => {
              let estimate = estimates[level]
              return (
                <form method="post" action={pullRoutes.pullRerun.href({ id: repoId, number: String(prNumber) })}>
                  <input type="hidden" name="_csrf" value={csrf} />
                  <input type="hidden" name="level" value={level} />
                  <Button type="submit">
                    Run at {level}
                    <span class="dash-estimate">{estimate === null ? ' · unknown cost' : ` · ≈ ${usdPrecise(estimate)}`}</span>
                  </Button>
                </form>
              )
            })}
            <Button variant="ghost" type="button" data-confirm-cancel hidden>
              Cancel
            </Button>
          </div>
        </div>
      </details>
    )
  }
}

/** The order of the legend, and what each case says (REV-91, "Read the sheet"). */
const LEGEND: { state: Exclude<Cell['state'], 'none'>; text: string }[] = [
  { state: 'posted', text: 'posted' },
  { state: 'found', text: 'found again, no new comment' },
  { state: 'moved', text: 'found again at another line' },
  { state: 'reopened', text: 'reopened' },
  { state: 'fixed', text: 'fixed by a push' },
  { state: 'dismissed', text: 'dismissed' },
  { state: 'wontfix', text: 'wontfix' },
  { state: 'absent', text: 'absent from this review' },
]

/** "?": how to read the sheet. Help is asked for, not shown at all times. */
function SheetHelp(_handle: Handle<{}>) {
  return () => (
    <details class="sheet-help">
      <summary class="sheet-help-button">
        <span aria-hidden="true">?</span>
        <span class="visually-hidden">Read the sheet</span>
      </summary>
      <div class="sheet-legend card">
        <p class="sheet-legend-title">Read the sheet</p>
        <p class="hint">
          One trace per finding, one cell per review. The colour says what the review did with it. A pale cell is what the review
          carries over from an earlier review. The status in the last column is the status of today.
        </p>
        <ul class="sheet-legend-list">
          {LEGEND.map(({ state, text }) => (
            <li>
              <span class={`cell cell-${state}`} aria-hidden="true"></span>
              {text}
            </li>
          ))}
        </ul>
        <p class="hint">Hover a cell to see its line.</p>
      </div>
    </details>
  )
}

function StatusFilter(handle: Handle<{ summary: PullSummary; query: PullQuery }>) {
  return () => {
    let { summary, query } = handle.props
    let { repoId, prNumber } = summary.target
    let all = query.statuses.length === 0
    let total = FINDING_STATUSES.reduce((n, s) => n + summary.byStatus[s], 0)
    let current = (s: FindingStatus) => !all && query.statuses.length === 1 && query.statuses[0] === s
    return (
      <nav class="pull-filter" aria-label="Filter by status">
        <a href={pullHref(repoId, prNumber, { reviews: query.reviews })} aria-current={all ? 'page' : undefined}>
          All <span class="count">{total}</span>
        </a>
        {FINDING_STATUSES.filter((s) => summary.byStatus[s] > 0 || current(s)).map((s) => (
          <a href={pullHref(repoId, prNumber, { statuses: [s], reviews: query.reviews })} aria-current={current(s) ? 'page' : undefined}>
            {STATUS_LABELS[s]} <span class="count">{summary.byStatus[s]}</span>
          </a>
        ))}
      </nav>
    )
  }
}

/** The name of a column, for its header and for the label of each cell on a phone. */
function columnLabel(review: PullReview): string {
  return `R${review.number} · ${short(review.headSha)}`
}

function SheetTable(handle: Handle<{ summary: PullSummary; sheet: PullSheet; query: PullQuery; now: Date }>) {
  return () => {
    let { summary, sheet, query, now } = handle.props
    let { repoId, prNumber } = summary.target
    // The job under way is a column of the newest page only.
    let active = query.reviews ? null : summary.active
    if (!sheet.columns.length && !active) {
      return (
        <div class="empty">
          <p>No review published on this pull request yet.</p>
        </div>
      )
    }
    return (
      <>
        <div class="table-wrap">
          <table class="table sheet">
            <caption class="visually-hidden">
              The findings of the pull request, and what each review did with them. The columns go from the oldest to the most recent.
            </caption>
            <thead>
              <tr>
                <th scope="col">Finding</th>
                {sheet.columns.map((review) => (
                  <th
                    scope="col"
                    class="sheet-col"
                    title={`${short(review.headSha)} · ${clock(review.createdAt)} · ${review.score}/5 · ${review.costUsd === null ? 'unknown cost' : usdPrecise(review.costUsd)} · ${review.findings} ${plural(review.findings, 'finding')}`}
                  >
                    <span class="sheet-col-name">R{review.number}</span>
                    <span class="sheet-col-level">{LEVEL_SHORT[review.level]}</span>
                    <span class="visually-hidden">
                      {' '}
                      {review.level}, {short(review.headSha)}, {agoOrDate(review.createdAt, now)}, {review.score}/5,{' '}
                      {review.costUsd === null ? 'unknown cost' : usdPrecise(review.costUsd)}, {review.findings} {plural(review.findings, 'finding')}
                    </span>
                    {review.publishedAt ? null : <span class="status status-stale">Not published</span>}
                  </th>
                ))}
                {active ? (
                  <th scope="col" class="sheet-col sheet-col-active">
                    <span class="sheet-col-name">R{active.number}</span>
                    <span class="sheet-col-level">{LEVEL_SHORT[active.level]}</span>
                    <span class="status status-wait">{active.state === 'running' ? 'In progress…' : 'Queued…'}</span>
                  </th>
                ) : null}
                <th scope="col" class="sheet-today">
                  Today
                </th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.length === 0 ? (
                <tr>
                  <td colSpan={sheet.columns.length + 2 + (active ? 1 : 0)}>
                    {query.statuses.length ? 'No finding with this status.' : 'No finding on this pull request.'}
                  </td>
                </tr>
              ) : (
                sheet.rows.map(({ finding, cells }) => (
                  <tr>
                    <th scope="row" class="sheet-finding">
                      <div class="sheet-finding-body">
                        <span class={`pri pri-${finding.severity}`}>{SEVERITY_BADGES[finding.severity]}</span>
                        <span class="sheet-finding-text">
                          <a class="sheet-title" href={pullRoutes.finding.href({ id: finding.id })}>
                            {finding.title || 'Untitled'}
                          </a>
                          <span class="sheet-where mono">
                            {finding.path}:{finding.line}
                          </span>
                        </span>
                      </div>
                    </th>
                    {sheet.columns.map((review, i) => (
                      <SheetCell cell={cells[i] ?? { state: 'none', carried: false, line: null }} label={columnLabel(review)} />
                    ))}
                    {active ? (
                      <td data-label={`R${active.number}`} class="sheet-cell">
                        <span class="cell cell-pending" title="In progress">
                          <span class="visually-hidden">in progress</span>
                        </span>
                      </td>
                    ) : null}
                    <td data-label="Today" class="sheet-today">
                      <span class={`status ${statusClass(finding.status)}`}>{STATUS_LABELS[finding.status]}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <nav class="pager" aria-label="Pages of the sheet">
          {query.reviews ? <a href={pullHref(repoId, prNumber, { statuses: query.statuses })}>Most recent reviews</a> : <span />}
          <p class="pager-range">
            {sheet.rows.length} {plural(sheet.rows.length, 'finding')} · R{sheet.columns[0]?.number ?? '?'} to R{sheet.columns.at(-1)?.number ?? '?'}
          </p>
          <span class="pager-links">
            {sheet.olderCursor ? (
              <a href={pullHref(repoId, prNumber, { statuses: query.statuses, reviews: sheet.olderCursor })}>Older reviews</a>
            ) : null}
            {sheet.nextRowsCursor ? (
              <a href={pullHref(repoId, prNumber, { statuses: query.statuses, reviews: query.reviews, rows: sheet.nextRowsCursor })}>Next findings</a>
            ) : null}
          </span>
        </nav>
      </>
    )
  }
}

/** One case of the trace: a bar in the colour of its state, its word for a screen reader, its line on hover. */
function SheetCell(handle: Handle<{ cell: Cell; label: string }>) {
  return () => {
    let { cell, label } = handle.props
    if (cell.state === 'none') {
      return (
        <td data-label={label} class="sheet-cell">
          <span class="cell cell-none">
            <span class="visually-hidden">not found yet</span>
          </span>
        </td>
      )
    }
    let text = CELL_LABELS[cell.state]
    return (
      <td data-label={label} class="sheet-cell">
        <span class={`cell cell-${cell.state}${cell.carried ? ' cell-carried' : ''}`} title={cell.line === null ? text : `${text}, line ${cell.line}`}>
          <span class="visually-hidden">
            {text}
            {cell.line !== null && (cell.state === 'moved' || cell.state === 'posted') ? ` l.${cell.line}` : ''}
          </span>
        </span>
      </td>
    )
  }
}

/** The mark of a status today: a ring open, a dot fixed, a cross dismissed, a dash wontfix (REV-91). */
export function statusClass(status: FindingStatus): string {
  switch (status) {
    case 'open':
      return 'status-open'
    case 'fixed':
      return 'status-online'
    case 'dismissed':
      return 'status-dismissed'
    case 'wontfix':
      return 'status-wontfix'
    default:
      return 'status-neutral'
  }
}
