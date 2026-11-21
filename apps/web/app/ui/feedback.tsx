// REV-107. "Feedback": the answers about the reviews of Kentō in the org, the newest first. A
// command `feedback`, a comment that quotes the request for feedback, or a 👍 or 👎 on the request.
import { UUID } from '@kento-review/protocol'
import type { Handle } from 'remix/component'

import {
  FEEDBACK_KINDS,
  FEEDBACK_SOURCES,
  type FeedbackKind,
  type FeedbackQuery,
  type FeedbackRow,
  type FeedbackScreen,
  type FeedbackSource,
  readFeedbackCursor,
} from '../feedback/store.ts'
import { encodeCursor } from '../findings/store.ts'
import { mention } from '../instance.ts'
import { feedbackRoutes } from '../routes.ts'
import { Button, Select, buttonClass } from './controls.tsx'
import { agoOrDate } from './format.ts'
import { ChevronLeftIcon, ChevronRightIcon } from './lucide.tsx'
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

/**
 * The query: the filters `repo`, `source`, `author`, and the page `before` (KNT-176). A value that
 * the screen cannot read (not an id, a source it does not know, a broken cursor) gives the default.
 */
export function readFeedbackQuery(params: URLSearchParams): FeedbackQuery {
  let repo = params.get('repo') ?? ''
  let source = params.get('source')
  let kind = params.get('author')
  // Written again from what it reads: a variant that decodes to the same cursor (a trailing space, a
  // third field) gets the one URL of the page.
  let cursor = readFeedbackCursor(params.get('before'))
  return {
    repoId: UUID.test(repo) ? repo : null,
    source: (FEEDBACK_SOURCES as readonly string[]).includes(source ?? '') ? (source as FeedbackSource) : null,
    kind: (FEEDBACK_KINDS as readonly string[]).includes(kind ?? '') ? (kind as FeedbackKind) : null,
    before: cursor ? encodeCursor(cursor) : null,
  }
}

export function feedbackHref(query: FeedbackQuery = {}): string {
  let params = new URLSearchParams()
  if (query.repoId) params.set('repo', query.repoId)
  if (query.source) params.set('source', query.source)
  if (query.kind) params.set('author', query.kind)
  if (query.before) params.set('before', query.before)
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
    let org = frame.viewer!.org.name
    let filtered = Boolean(query.repoId || query.source || query.kind)
    let none = screen.rows.length === 0 && !screen.newer && !filtered
    // The same filters, on the first page.
    let newest = feedbackHref({ ...query, before: null })
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
              <code>{mention('feedback')}</code>, a comment that quotes the request, or a 👍 or a 👎 on the request.
            </p>
          </section>
        ) : (
          <>
            <FilterForm screen={screen} query={query} org={org} />
            {screen.rows.length === 0 && screen.newer ? (
              // A page after the last one: an answer left the list, or the link is old.
              <section class="empty" aria-labelledby="empty-title">
                <h2 id="empty-title">No older feedback</h2>
                <p>
                  <a href={newest}>See the newest feedback</a>
                </p>
              </section>
            ) : screen.rows.length === 0 ? (
              <section class="empty" aria-labelledby="empty-title">
                <h2 id="empty-title">No feedback for these filters</h2>
                <p>
                  <a href={feedbackHref()}>See all the feedback</a>
                </p>
              </section>
            ) : (
              <>
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
                <FeedbackPager screen={screen} query={query} />
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

/**
 * KNT-176. "Newer" and "Older": plain links, without JavaScript, that keep the filters. Not shown
 * when the list fits on one page.
 */
function FeedbackPager(handle: Handle<{ screen: FeedbackScreen; query: FeedbackQuery }>) {
  return () => {
    let { screen, query } = handle.props
    if (!screen.newer && !screen.older) return null
    return (
      <nav class="pager pager-steps" aria-label="Pages of the feedback">
        {screen.newer ? (
          <a class={buttonClass('outline', 'sm')} href={feedbackHref({ ...query, before: screen.newer.before })} rel="prev">
            <ChevronLeftIcon />
            Newer
          </a>
        ) : (
          // Not a link and not focusable: its text says that there is no page before.
          <span class={buttonClass('outline', 'sm')} aria-disabled="true">
            <ChevronLeftIcon />
            Newer
            <span class="visually-hidden"> (this is the newest feedback)</span>
          </span>
        )}
        {screen.older ? (
          <a class={buttonClass('outline', 'sm')} href={feedbackHref({ ...query, before: screen.older })} rel="next">
            Older
            <ChevronRightIcon />
          </a>
        ) : (
          <span class={buttonClass('outline', 'sm')} aria-disabled="true">
            Older
            <span class="visually-hidden"> (no older feedback)</span>
            <ChevronRightIcon />
          </span>
        )}
      </nav>
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
          <Select id="feedback-repo" name="repo">
            <option value="" selected={!query.repoId}>
              All repos
            </option>
            {screen.repos.map((repo) => (
              <option value={repo.id} selected={repo.id === query.repoId}>
                {shortName(repo.fullName, org)}
              </option>
            ))}
          </Select>
        </div>
        <div class="findings-filter">
          <label class="field-label" for="feedback-source">
            Source
          </label>
          <Select id="feedback-source" name="source">
            <option value="" selected={!query.source}>
              All
            </option>
            {FEEDBACK_SOURCES.map((source) => (
              <option value={source} selected={source === query.source}>
                {SOURCE_LABELS[source]}
              </option>
            ))}
          </Select>
        </div>
        <div class="findings-filter">
          <label class="field-label" for="feedback-kind">
            Author
          </label>
          <Select id="feedback-kind" name="author">
            <option value="" selected={!query.kind}>
              People and agents
            </option>
            {FEEDBACK_KINDS.map((kind) => (
              <option value={kind} selected={kind === query.kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </Select>
        </div>
        <div class="findings-filter-actions">
          <Button type="submit">
            Filter
          </Button>
          {query.repoId || query.source || query.kind ? (
            <a class={buttonClass('ghost')} href={feedbackHref()}>
              Clear the filters
            </a>
          ) : null}
        </div>
      </form>
    )
  }
}
