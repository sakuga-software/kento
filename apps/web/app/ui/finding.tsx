import type { Handle, RemixNode } from 'remix/component'

import { rankLabel } from '../db/review-count.ts'
import type { FindingEventType, Page } from '../findings/store.ts'
import type { CodeExcerpt, CodeRead, FindingDetail, HistoryEvent } from '../pulls/finding.ts'
import { STATUS_LABELS } from '../pulls/sheet.ts'
import { pageRoutes, pullRoutes } from '../routes.ts'
import { agoOrDate, clock, plural } from './format.ts'
import { CONSIDERED_LABEL } from './findings.tsx'
import { ExternalIcon } from './icons.tsx'
import { pullHref, pullUrl, SEVERITY_BADGES, statusClass } from './pull.tsx'
import { Shell, type PageFrame } from './shell.tsx'

/** A member decides on a finding as an admin does (REV-17). */
export const MEMBER_CAN = "you can dismiss, keep (won't fix) or reopen a finding"

/** The words of each event of the history. */
export const EVENT_LABELS: Record<FindingEventType, string> = {
  opened: 'posted',
  reopened: 'reopened',
  fixed: 'fixed',
  stale: 'stale',
  dismissed: 'dismissed',
  wontfix: 'wontfix',
}

/** The thread of a finding on GitHub. */
export function threadUrl(githubUrl: string, finding: Pick<FindingDetail, 'target' | 'githubCommentId'>): string | null {
  if (finding.githubCommentId === null) return null
  return `${pullUrl(githubUrl, finding.target.fullName, finding.target.prNumber)}#discussion_r${finding.githubCommentId}`
}

/** The address of the detail, with the cursor of its history. */
export function findingHref(id: string, history: string | null = null): string {
  let base = pullRoutes.finding.href({ id })
  return history ? `${base}?history=${encodeURIComponent(history)}` : base
}

export interface FindingPageProps {
  frame: PageFrame
  finding: FindingDetail
  history: Page<HistoryEvent>
  /** The cursor of the page of history on screen, null for the first. */
  historyCursor: string | null
  /** Undefined: GitHub was not asked (no GitHub App). `failed`: GitHub did not answer. */
  code: CodeRead | 'failed' | undefined
  githubUrl: string
  now: Date
  /** The forms of the finding (REV-17, 3/4), under its facts. */
  actions?: RemixNode
  notice?: RemixNode
}

export function FindingPage(handle: Handle<FindingPageProps>) {
  return () => {
    let { frame, finding, history, historyCursor, code, githubUrl, now, actions, notice } = handle.props
    let { target } = finding
    let repoName = target.fullName.split('/')[1] ?? target.fullName
    let thread = threadUrl(githubUrl, finding)
    let review = finding.review
    return (
      <Shell
        frame={frame}
        section="repos"
        title={finding.title || 'Untitled finding'}
        memberCan={MEMBER_CAN}
        before={
            <nav class="crumbs" aria-label="Breadcrumb">
              <a href={pageRoutes.repos.href()}>Repos</a>
              <span aria-hidden="true">/</span>
              <a href={pageRoutes.repoConfig.href({ id: target.repoId })}>{target.fullName}</a>
              <span aria-hidden="true">/</span>
              <a href={pullHref(target.repoId, target.prNumber)}>
                {repoName} #{target.prNumber}
              </a>
              <span aria-hidden="true">/</span>
              <span aria-current="page">Finding</span>
            </nav>
        }
      >

        {notice}

        <div class="finding-tags">
          <span class="tag">{SEVERITY_BADGES[finding.severity]}</span>
          <span class={`status ${statusClass(finding.status)}`}>{STATUS_LABELS[finding.status]}</span>
          <span class="tag tag-quiet">{finding.category}</span>
          {/* REV-102: the last review lists it under "To consider (code already reviewed)", as the block of the PR does. */}
          {review?.considered ? <span class="tag tag-info">{CONSIDERED_LABEL}</span> : null}
          {finding.statusReason ? <span class="hint">Reason: {finding.statusReason}</span> : null}
          {review?.considered ? <span class="hint">{CONSIDERED_LABEL}: code already reviewed, not blocking.</span> : null}
        </div>

        <dl class="pull-meta finding-facts">
          <div>
            <dt>Source</dt>
            <dd>{finding.rule ? `Rule "${finding.rule.title ?? 'removed since'}"` : 'Model pass'}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{finding.confidence}%</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{review ? `${review.model} (${rankLabel(review.rank)}, ${review.level})` : 'unknown'}</dd>
          </div>
          <div>
            <dt>Check</dt>
            <dd>none, one pass only</dd>
          </div>
          <div>
            <dt>File</dt>
            <dd class="mono">
              {finding.path}:{finding.line}
            </dd>
          </div>
          <div>
            <dt>GitHub thread</dt>
            <dd>
              {thread ? (
                <a href={thread}>
                  Open the thread
                  <ExternalIcon />
                </a>
              ) : (
                'no inline comment'
              )}
            </dd>
          </div>
        </dl>

        {actions}

        <div class="finding-grid">
          <section class="card finding-section" aria-labelledby="scenario-title">
            <h2 id="scenario-title" class="section-title">
              Scenario
            </h2>
            <p class="finding-text">{review?.scenario || 'The review did not write it.'}</p>
            <h2 id="fix-title" class="section-title">
              Fix
            </h2>
            <p class="finding-text">{review?.fix || 'The review gives none.'}</p>
            {review?.suggestion ? (
              <>
                <h3 class="finding-subtitle">Suggestion</h3>
                <pre class="code-block">
                  <code>{review.suggestion}</code>
                </pre>
              </>
            ) : null}
          </section>

          <section class="card finding-section" aria-labelledby="code-title">
            <h2 id="code-title" class="section-title">
              Code
            </h2>
            <p class="hint">
              <span class="mono">{finding.path}</span> at <span class="mono">{finding.lastSeenSha.slice(0, 7)}</span>, the commit of the last review that found it.
            </p>
            {code !== undefined && code !== 'failed' && code.kind === 'lines' ? (
              <>
                {finding.line < 1 ? <p class="hint">This finding has no line (a thread of an earlier version). Here is the start of the file.</p> : null}
                <CodeView code={code.excerpt} line={finding.line} />
              </>
            ) : (
              <p class="finding-text">{codeText(code)}</p>
            )}
          </section>
        </div>

        <section class="finding-history" aria-labelledby="history-title">
          <h2 id="history-title" class="section-title">
            History
          </h2>
          {history.items.length === 0 ? (
            <p class="hint">No event.</p>
          ) : (
            <ol class="history">
              {history.items.map((event) => (
                <li class="history-item">
                  <span class={`cell cell-${event.type === 'opened' ? 'posted' : event.type === 'stale' ? 'absent' : event.type}`}>{EVENT_LABELS[event.type]}</span>
                  <span>
                    {event.actor === 'kento' ? 'Kentō' : `@${event.actor}`}
                    {event.review === null ? '' : ` · ${rankLabel(event.review)}`}
                    {event.reason ? ` · "${event.reason}"` : ''}
                  </span>
                  <time class="hint" dateTime={event.createdAt.toISOString()} title={clock(event.createdAt)}>
                    {agoOrDate(event.createdAt, now)}
                  </time>
                </li>
              ))}
            </ol>
          )}
          {historyCursor || history.nextCursor ? (
            <nav class="pager" aria-label="Pages of the history">
              {historyCursor ? <a href={findingHref(finding.id)}>Start of the history</a> : <span />}
              <span />
              {history.nextCursor ? <a href={findingHref(finding.id, history.nextCursor)}>Next events</a> : <span />}
            </nav>
          ) : null}
        </section>
      </Shell>
    )
  }
}

/** Why the code of a finding is not on screen. */
export function codeText(code: CodeRead | 'failed' | undefined): string {
  if (code === undefined) return 'Without the GitHub App, Kentō does not read the code.'
  if (code === 'failed') return 'GitHub did not answer, so Kentō could not read the code.'
  if (code.kind === 'missing') return 'This file is no longer on GitHub at this commit (a force-push removed it, or someone renamed the file).'
  if (code.kind === 'empty') return 'The file is empty at this commit.'
  if (code.kind === 'unreadable') return 'GitHub does not give the content of this file (a folder, or a file of more than 1 MB).'
  if (code.kind === 'short') return `The file has only ${code.length} ${plural(code.length, 'line')} at this commit. The line of the finding is not in it.`
  return ''
}

function CodeView(handle: Handle<{ code: CodeExcerpt; line: number }>) {
  return () => {
    let { code, line } = handle.props
    return (
      <div class="code-block" role="group" tabIndex={0} aria-label={`Lines ${code.start} to ${code.start + code.lines.length - 1}`}>
        {code.lines.map((text, i) => {
          let n = code.start + i
          return (
            <div class={`code-line${n === line ? ' code-line-hit' : ''}`}>
              <span class="code-number" aria-hidden="true">
                {n}
              </span>
              <code>{text || ' '}</code>
              {n === line ? <span class="visually-hidden"> (line of the finding)</span> : null}
            </div>
          )
        })}
      </div>
    )
  }
}
