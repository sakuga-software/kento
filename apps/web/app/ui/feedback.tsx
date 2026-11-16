// REV-107. « Feedback »: the answers about the reviews of Kentō in the org, the newest first. A
// command `feedback`, a comment that quotes the request for feedback, or a 👍 or 👎 on the request.
import type { Handle } from 'remix/component'

import {
  FEEDBACK_KINDS,
  FEEDBACK_PAGE_MAX,
  FEEDBACK_SOURCES,
  type FeedbackKind,
  type FeedbackQuery,
  type FeedbackRow,
  type FeedbackScreen,
  type FeedbackSource,
} from '../feedback/store.ts'
import { feedbackRoutes } from '../routes.ts'
import { agoOrDate, count, plural } from './format.ts'
import { shortName } from './precision.tsx'
import { pullHref } from './pull.tsx'
import { Shell, type PageFrame } from './shell.tsx'

export const SOURCE_LABELS: Record<FeedbackSource, string> = {
  command: 'Command',
  quote: 'Quote',
  reaction: 'Reaction',
}

export const KIND_LABELS: Record<FeedbackKind, string> = {
  person: 'Person',
  agent: 'Agent',
}

/** The filters of the query: `repo`, `source`, `auteur`. A value that the screen does not know is dropped. */
export function readFeedbackQuery(params: URLSearchParams): FeedbackQuery {
  let source = params.get('source')
  let kind = params.get('auteur')
  return {
    repoId: params.get('repo') || null,
    source: (FEEDBACK_SOURCES as readonly string[]).includes(source ?? '') ? (source as FeedbackSource) : null,
    kind: (FEEDBACK_KINDS as readonly string[]).includes(kind ?? '') ? (kind as FeedbackKind) : null,
  }
}

export function feedbackHref(query: FeedbackQuery = {}): string {
  let params = new URLSearchParams()
  if (query.repoId) params.set('repo', query.repoId)
  if (query.source) params.set('source', query.source)
  if (query.kind) params.set('auteur', query.kind)
  let search = params.toString()
  return search ? `${feedbackRoutes.feedback.href()}?${search}` : feedbackRoutes.feedback.href()
}

export interface FeedbackPageProps {
  frame: PageFrame
  screen: FeedbackScreen
  query: FeedbackQuery
  now: Date
}

export function FeedbackPage(handle: Handle<FeedbackPageProps>) {
  return () => {
    let { frame, screen, query, now } = handle.props
    let org = frame.viewer!.org.login
    let filtered = Boolean(query.repoId || query.source || query.kind)
    let none = screen.total === 0 && !filtered
    return (
      <Shell
        frame={frame}
        section="feedback"
        title="Feedback"
        lead="What the authors of the pull requests say about the reviews of Kentō. Kentō asks once per pull request, after its third review."
      >
        {none ? (
          <section class="empty" aria-labelledby="empty-title">
            <h2 id="empty-title">No feedback yet</h2>
            <p>
              After its third review on a pull request, Kentō asks its author for feedback. The answers arrive here: a command{' '}
              <code>@kento-review feedback</code>, a comment that quotes the request, or a 👍 or a 👎 on the request.
            </p>
          </section>
        ) : (
          <>
            <FilterForm screen={screen} query={query} org={org} />
            {screen.rows.length === 0 ? (
              <section class="empty" aria-labelledby="empty-title">
                <h2 id="empty-title">No feedback for these filters</h2>
                <p>
                  <a href={feedbackHref()}>See all the feedback</a>
                </p>
              </section>
            ) : (
              <>
                <p class="hint">
                  {count(screen.total)} {plural(screen.total, 'answer')}
                  {screen.total > screen.rows.length ? `, the ${FEEDBACK_PAGE_MAX} most recent shown` : ''}.
                </p>
                <div class="table-wrap">
                  <table class="table feedback-table">
                    <caption class="visually-hidden">Feedback on the reviews of Kentō in {org}, from the most recent to the oldest</caption>
                    <thead>
                      <tr>
                        <th scope="col">Feedback</th>
                        <th scope="col">PR</th>
                        <th scope="col">Author</th>
                        <th scope="col">Source</th>
                        <th scope="col" class="num">
                          Score
                        </th>
                        <th scope="col">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {screen.rows.map((row) => (
                        <FeedbackLine row={row} org={org} now={now} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </Shell>
    )
  }
}

function FeedbackLine(handle: Handle<{ row: FeedbackRow; org: string; now: Date }>) {
  return () => {
    let { row, org, now } = handle.props
    return (
      <tr>
        <th scope="row" class="feedback-text">
          {row.text}
          {row.url ? (
            <>
              {' '}
              <a class="feedback-link" href={row.url}>
                Open on GitHub
              </a>
            </>
          ) : null}
        </th>
        <td>
          <a class="mono" href={pullHref(row.repoId, row.prNumber)}>
            {shortName(row.repo, org)}#{row.prNumber}
          </a>
        </td>
        <td>
          <span class="mono">{row.authorLogin}</span>{' '}
          <span class={`tag ${row.authorIsBot ? 'tag-info' : 'tag-quiet'}`}>{KIND_LABELS[row.authorIsBot ? 'agent' : 'person']}</span>
        </td>
        <td>{SOURCE_LABELS[row.source]}</td>
        <td class="num">{row.score === null ? '—' : `${row.score}/5`}</td>
        <td>
          <time dateTime={row.createdAt.toISOString()}>{agoOrDate(row.createdAt, now)}</time>
        </td>
      </tr>
    )
  }
}

/** The filters: a GET form, without JavaScript, so that the URL keeps them. */
function FilterForm(handle: Handle<{ screen: FeedbackScreen; query: FeedbackQuery; org: string }>) {
  return () => {
    let { screen, query, org } = handle.props
    return (
      <form class="feedback-filters" method="get" action={feedbackRoutes.feedback.href()} role="search" aria-label="Filter the feedback">
        <div class="findings-filter">
          <label class="field-label" for="feedback-repo">
            Repo
          </label>
          <select class="input" id="feedback-repo" name="repo">
            <option value="" selected={!query.repoId}>
              All repos
            </option>
            {screen.repos.map((repo) => (
              <option value={repo.id} selected={repo.id === query.repoId}>
                {shortName(repo.fullName, org)}
              </option>
            ))}
          </select>
        </div>
        <div class="findings-filter">
          <label class="field-label" for="feedback-source">
            Source
          </label>
          <select class="input" id="feedback-source" name="source">
            <option value="" selected={!query.source}>
              All
            </option>
            {FEEDBACK_SOURCES.map((source) => (
              <option value={source} selected={source === query.source}>
                {SOURCE_LABELS[source]}
              </option>
            ))}
          </select>
        </div>
        <div class="findings-filter">
          <label class="field-label" for="feedback-kind">
            Author
          </label>
          <select class="input" id="feedback-kind" name="auteur">
            <option value="" selected={!query.kind}>
              People and agents
            </option>
            {FEEDBACK_KINDS.map((kind) => (
              <option value={kind} selected={kind === query.kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>
        <div class="findings-filter-actions">
          <button class="button" type="submit">
            Filter
          </button>
          {query.repoId || query.source || query.kind ? (
            <a class="button button-ghost" href={feedbackHref()}>
              Clear the filters
            </a>
          ) : null}
        </div>
      </form>
    )
  }
}
