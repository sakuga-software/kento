import { LEVELS, type Level } from '@sakuga-review/protocol'
import type { Handle } from 'remix/component'

import { FINDING_STATUSES, type FindingStatus } from '../findings/store.ts'
import type { PullHeader } from '../pulls/github.ts'
import { CELL_LABELS, STATUS_LABELS, type Cell } from '../pulls/sheet.ts'
import type { PullActiveJob, PullFinding, PullReview, PullSheet, PullSummary } from '../pulls/store.ts'
import { pageRoutes, pullRoutes } from '../routes.ts'
import { agoOrDate, clock, plural, usdPrecise } from './format.ts'
import { ExternalIcon } from './icons.tsx'
import { Shell, type PageFrame } from './shell.tsx'

/** What the screen says after « Relancer », from `?relance=`. */
export const RERUN_NOTICES = {
  queued: 'Review relancée : elle est en file. Un nouveau push l’annule.',
  already: 'Une review de ce niveau est déjà en file ou en cours sur ce commit.',
  stale: 'GitHub a un commit plus récent que la dernière review : son push sera relu, rien n’est relancé.',
  closed: 'La PR est fermée sur GitHub, donc rien n’est relancé.',
  capped: 'Le plafond de coût de l’organisation est atteint, donc rien n’est relancé. Un admin le change dans Réglages.',
  github_failed: 'GitHub n’a pas répondu et rien n’est relancé. Réessayez dans un instant.',
  missing: 'Rien n’est relancé : le repo n’est plus activé, ou l’installation est suspendue.',
} as const
export type RerunNotice = keyof typeof RERUN_NOTICES

/** The badge of a severity, as the comments of the bot write it on GitHub. */
export const SEVERITY_BADGES: Record<PullFinding['severity'], string> = { critical: 'P0', major: 'P1', minor: 'P2' }

/** The query of the screen: the status filter and the two cursors. */
export interface PullQuery {
  statuses: FindingStatus[]
  /** The cursor of the older reviews (`?avant=`). */
  reviews: string | null
  /** The cursor of the next findings (`?suite=`). */
  rows: string | null
}

/** Reads `?statut=open&statut=fixed&avant=…&suite=…`. An unknown status is left out. */
export function readPullQuery(query: URLSearchParams): PullQuery {
  let statuses = query.getAll('statut').filter((s): s is FindingStatus => (FINDING_STATUSES as readonly string[]).includes(s))
  return { statuses: [...new Set(statuses)], reviews: query.get('avant') || null, rows: query.get('suite') || null }
}

/** The address of the screen with this query. */
export function pullHref(repoId: string, prNumber: number, query: Partial<PullQuery> = {}): string {
  let params = new URLSearchParams()
  for (let s of query.statuses ?? []) params.append('statut', s)
  if (query.reviews) params.set('avant', query.reviews)
  if (query.rows) params.set('suite', query.rows)
  let search = params.toString()
  return `${pullRoutes.pull.href({ id: repoId, number: String(prNumber) })}${search ? `?${search}` : ''}`
}

export function pullUrl(githubUrl: string, fullName: string, prNumber: number): string {
  let [owner, name] = fullName.split('/')
  return `${githubUrl}/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/pull/${prNumber}`
}

const short = (sha: string) => sha.slice(0, 7)

/** « 4/5, +1 depuis R3 »: the last score and how it moved since the review before. */
export function scoreProgress(summary: Pick<PullSummary, 'lastScores' | 'reviews'>): { value: string; change: string | null } {
  let [last, previous] = summary.lastScores
  if (last === undefined) return { value: '—', change: null }
  if (previous === undefined) return { value: `${last}/5`, change: null }
  let delta = last - previous
  let since = `depuis R${summary.reviews - 1}`
  return { value: `${last}/5`, change: delta === 0 ? `inchangé ${since}` : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} ${since}` }
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
  /** The estimate of a review of each level, for an admin; null for a member (no « Relancer »). */
  estimates?: Record<Level, number | null> | null
  rerunNotice?: RerunNotice | null
}

export function PullPage(handle: Handle<PullPageProps>) {
  return () => {
    let { frame, summary, header, sheet, query, githubUrl, now, estimates, rerunNotice } = handle.props
    let { target } = summary
    let repoName = target.fullName.split('/')[1] ?? target.fullName
    let progress = scoreProgress(summary)
    let total = FINDING_STATUSES.reduce((n, s) => n + summary.byStatus[s], 0)
    let base = header?.baseRef || summary.baseRef
    return (
      <Shell
        frame={frame}
        section="repos"
        title={`${repoName} #${target.prNumber}${header?.title ? ` · ${header.title}` : ''}`}
        memberCan="vous dismissez, gardez (wontfix) ou rouvrez un finding depuis son détail"
      >
        <nav class="crumbs" aria-label="Fil d’Ariane">
          <a href={pageRoutes.repos.href()}>Repos</a>
          <span aria-hidden="true">/</span>
          <a href={pageRoutes.repoConfig.href({ id: target.repoId })}>{target.fullName}</a>
          <span aria-hidden="true">/</span>
          <span aria-current="page">#{target.prNumber}</span>
        </nav>

        <dl class="pull-meta">
          <div>
            <dt>Auteur</dt>
            <dd>{header?.author ? `@${header.author}` : 'inconnu'}</dd>
          </div>
          <div>
            <dt>Branches</dt>
            <dd class="mono">
              {header?.headRef || '?'} → {base || '?'}
            </dd>
          </div>
          <div>
            <dt>Head</dt>
            <dd class="mono">{short(header?.headSha || summary.headSha)}</dd>
          </div>
          <div>
            <dt>État</dt>
            <dd>{header ? (header.state === 'open' ? 'ouverte' : header.state === 'merged' ? 'mergée' : 'fermée') : 'inconnu'}</dd>
          </div>
          <div>
            <dt>GitHub</dt>
            <dd>
              <a href={pullUrl(githubUrl, target.fullName, target.prNumber)}>
                Voir sur GitHub
                <ExternalIcon />
              </a>
            </dd>
          </div>
        </dl>
        {header ? null : <p class="hint pull-github-note">GitHub n’a pas répondu : le titre, l’auteur et les branches manquent.</p>}

        <section class="dash-tiles pull-tiles" aria-label="En bref">
          <div class="dash-tile">
            <span class="dash-tile-label">Reviews</span>
            <span class="dash-tile-value">{summary.reviews}</span>
          </div>
          <div class="dash-tile">
            <span class="dash-tile-label">Score</span>
            <span class="dash-tile-value">{progress.value}</span>
            {progress.change ? <span class="hint">{progress.change}</span> : null}
          </div>
          <div class="dash-tile">
            <span class="dash-tile-label">Findings</span>
            <span class="dash-tile-value">{total}</span>
            <span class="hint">
              {FINDING_STATUSES.filter((s) => summary.byStatus[s] > 0)
                .map((s) => `${summary.byStatus[s]} ${STATUS_LABELS[s]}`)
                .join(' · ') || 'aucun'}
            </span>
          </div>
          <div class="dash-tile">
            <span class="dash-tile-label">Coût cumulé</span>
            <span class="dash-tile-value">{summary.costUsd === null ? '—' : usdPrecise(summary.costUsd)}</span>
          </div>
        </section>

        {rerunNotice ? (
          <div class={`banner ${rerunNotice === 'queued' ? 'banner-ok' : 'banner-info'}`} role="status">
            <p>{RERUN_NOTICES[rerunNotice]}</p>
          </div>
        ) : null}

        {summary.active ? <ActiveBanner job={summary.active} now={now} /> : null}

        {estimates && !summary.active && header?.state !== 'closed' && header?.state !== 'merged' ? (
          <RerunSection summary={summary} estimates={estimates} csrf={frame.csrfToken ?? ''} />
        ) : null}

        <section class="pull-sheet" aria-labelledby="sheet-title">
          <div class="dash-section-head">
            <h2 id="sheet-title" class="section-title">
              Feuille d’exposition
            </h2>
          </div>
          <p class="hint">
            Une colonne par review, une ligne par finding. Chaque case dit ce que la review a fait du finding : posté, retrouvé
            (même ligne, sans nouveau commentaire), déplacé (autre ligne, sans nouveau commentaire), rouvert, fixed, dismissed,
            wontfix ou absent. Une case dit l’état au moment de sa review ; le statut sous chaque titre est celui d’aujourd’hui.
          </p>
          <StatusFilter summary={summary} query={query} />
          <SheetTable summary={summary} sheet={sheet} query={query} now={now} />
        </section>
      </Shell>
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
            R{job.number} {job.state === 'running' ? 'en cours' : 'en file'}…
          </strong>{' '}
          Review {job.level} de <span class="mono">{short(job.headSha)}</span>, demandée {agoOrDate(job.createdAt, now)}. Un nouveau
          push l’annule.
        </p>
      </div>
    )
  }
}

const LEVEL_DEFAULT_HINT = 'L’estimation est la moyenne des dernières reviews de ce niveau sur ce repo.'

function RerunSection(handle: Handle<{ summary: PullSummary; estimates: Record<Level, number | null>; csrf: string }>) {
  return () => {
    let { summary, estimates, csrf } = handle.props
    let { repoId, prNumber } = summary.target
    return (
      <section class="pull-rerun" aria-labelledby="rerun-title">
        <h2 id="rerun-title" class="section-title">
          Relancer R{summary.reviews + 1}
        </h2>
        <p class="hint">
          Une nouvelle review de <span class="mono">{short(summary.headSha)}</span>, le dernier commit relu. Un nouveau push l’annule. {LEVEL_DEFAULT_HINT}
        </p>
        <div class="pull-rerun-actions">
          {LEVELS.map((level) => {
            let estimate = estimates[level]
            return (
              <form method="post" action={pullRoutes.pullRerun.href({ id: repoId, number: String(prNumber) })}>
                <input type="hidden" name="_csrf" value={csrf} />
                <input type="hidden" name="level" value={level} />
                <button class="button" type="submit">
                  Relancer en {level}
                  <span class="dash-estimate">{estimate === null ? ' · coût inconnu' : ` · ≈ ${usdPrecise(estimate)}`}</span>
                </button>
              </form>
            )
          })}
        </div>
      </section>
    )
  }
}

function StatusFilter(handle: Handle<{ summary: PullSummary; query: PullQuery }>) {
  return () => {
    let { summary, query } = handle.props
    let { repoId, prNumber } = summary.target
    let all = query.statuses.length === 0
    return (
      <nav class="pull-filter" aria-label="Filtrer par statut">
        <a href={pullHref(repoId, prNumber, { reviews: query.reviews })} aria-current={all ? 'page' : undefined}>
          Tous
        </a>
        {FINDING_STATUSES.map((s) => (
          <a href={pullHref(repoId, prNumber, { statuses: [s], reviews: query.reviews })} aria-current={!all && query.statuses.length === 1 && query.statuses[0] === s ? 'page' : undefined}>
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
          <p>Aucune review publiée sur cette PR pour l’instant.</p>
        </div>
      )
    }
    return (
      <>
        <div class="table-wrap">
          <table class="table sheet">
            <caption class="visually-hidden">
              Les findings de la PR, et ce que chaque review en a fait. Les colonnes vont de la plus ancienne à la plus récente.
            </caption>
            <thead>
              <tr>
                <th scope="col">Finding</th>
                {sheet.columns.map((review) => (
                  <th scope="col" class="sheet-col">
                    <span class="sheet-col-name">R{review.number}</span> <span class="tag">{review.level}</span>
                    <span class="sheet-col-facts">
                      <span class="mono">{short(review.headSha)}</span>
                      <time dateTime={review.createdAt.toISOString()} title={clock(review.createdAt)}>
                        {agoOrDate(review.createdAt, now)}
                      </time>
                      <span>
                        {review.score}/5 · {review.costUsd === null ? 'coût inconnu' : usdPrecise(review.costUsd)}
                      </span>
                      <span>
                        {review.findings} {plural(review.findings, 'finding')}
                      </span>
                      {review.publishedAt ? null : <span class="status status-stale">Non publiée</span>}
                    </span>
                  </th>
                ))}
                {active ? (
                  <th scope="col" class="sheet-col sheet-col-active">
                    <span class="sheet-col-name">R{active.number}</span> <span class="tag">{active.level}</span>
                    <span class="sheet-col-facts">
                      <span class="mono">{short(active.headSha)}</span>
                      <span class="status status-wait">{active.state === 'running' ? 'En cours…' : 'En file…'}</span>
                    </span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.length === 0 ? (
                <tr>
                  <td colSpan={sheet.columns.length + 1 + (active ? 1 : 0)}>
                    {query.statuses.length ? 'Aucun finding de ce statut.' : 'Aucun finding sur cette PR.'}
                  </td>
                </tr>
              ) : (
                sheet.rows.map(({ finding, cells }) => (
                  <tr>
                    <th scope="row" class="sheet-finding">
                      <div class="sheet-finding-body">
                        <a class="sheet-title" href={pullRoutes.finding.href({ id: finding.id })}>
                          {finding.title || 'Sans titre'}
                        </a>
                        <span class="sheet-where mono">
                          {finding.path}:{finding.line}
                        </span>
                        <span class="sheet-tags">
                          <span class="tag">{SEVERITY_BADGES[finding.severity]}</span>
                          <span class={`status ${statusClass(finding.status)}`}>{STATUS_LABELS[finding.status]}</span>
                        </span>
                      </div>
                    </th>
                    {sheet.columns.map((review, i) => (
                      <SheetCell cell={cells[i] ?? { state: 'none', carried: false, line: null }} label={columnLabel(review)} />
                    ))}
                    {active ? <td data-label={`R${active.number}`} class="sheet-cell"><span class="cell cell-pending">…</span></td> : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <nav class="pager" aria-label="Pages de la feuille">
          {query.reviews ? <a href={pullHref(repoId, prNumber, { statuses: query.statuses })}>Reviews les plus récentes</a> : <span />}
          <p class="pager-range">
            {sheet.rows.length} {plural(sheet.rows.length, 'finding')} · R{sheet.columns[0]?.number ?? '?'} à R{sheet.columns.at(-1)?.number ?? '?'}
          </p>
          <span class="pager-links">
            {sheet.olderCursor ? (
              <a href={pullHref(repoId, prNumber, { statuses: query.statuses, reviews: sheet.olderCursor })}>Reviews plus anciennes</a>
            ) : null}
            {sheet.nextRowsCursor ? (
              <a href={pullHref(repoId, prNumber, { statuses: query.statuses, reviews: query.reviews, rows: sheet.nextRowsCursor })}>Findings suivants</a>
            ) : null}
          </span>
        </nav>
      </>
    )
  }
}

function SheetCell(handle: Handle<{ cell: Cell; label: string }>) {
  return () => {
    let { cell, label } = handle.props
    if (cell.state === 'none') {
      return (
        <td data-label={label} class="sheet-cell">
          <span class="visually-hidden">pas encore trouvé</span>
        </td>
      )
    }
    let text = CELL_LABELS[cell.state]
    return (
      <td data-label={label} class="sheet-cell">
        <span class={`cell cell-${cell.state}${cell.carried ? ' cell-carried' : ''}`} title={cell.line === null ? undefined : `ligne ${cell.line}`}>
          {text}
          {cell.line !== null && (cell.state === 'moved' || cell.state === 'posted') ? <span class="cell-line"> l.{cell.line}</span> : null}
        </span>
      </td>
    )
  }
}

export function statusClass(status: FindingStatus): string {
  switch (status) {
    case 'open':
      return 'status-alert'
    case 'fixed':
      return 'status-online'
    default:
      return 'status-neutral'
  }
}
