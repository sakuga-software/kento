import type { Handle } from 'remix/component'

import { REPO_FILTERS, SWITCH_TARGET, type RepoFilter, type RepoListQuery, type RepoPage, type RepoView } from '../repos/store.ts'
import { pageRoutes as routes, pullRoutes } from '../routes.ts'
import type { Precision } from '../findings/precision.ts'
import { RowMenu } from './public/row-menu.tsx'
import { Button, Input, buttonClass } from './controls.tsx'
import { findingsHref } from './findings.tsx'
import { PrecisionValue } from './precision.tsx'
import { agoOrDate, plural, when } from './format.ts'
import { AlertIcon, CheckIcon, ExternalIcon, GitHubIcon, LockIcon } from './icons.tsx'
import { CircleHelpIcon, GlobeIcon, PowerIcon, RefreshCwIcon, SearchIcon } from './lucide.tsx'
import { readPageNumber } from '../paging.ts'
import { Pager } from './pager.tsx'
import { Shell, type PageFrame } from './shell.tsx'

/** What the screen says after a change, from the query of the redirect. */
export type ReposNotice =
  | { kind: 'enabled'; fullName: string }
  | { kind: 'disabled'; fullName: string; cancelled: number }
  | { kind: 'checked' }
  | { kind: 'check_failed' }

export interface ReposPageProps {
  frame: PageFrame
  /** One page of the list, and the counts of the org (REV-36). */
  page: RepoPage
  /** The filter, the search and the page on screen. */
  list: RepoList
  /**
   * The page of each installation of the App in the org, on GitHub (KNT-150: an org can hold
   * several). `login`: the GitHub account of the installation.
   */
  installations: { login: string; url: string }[]
  /** `https://github.com`, or the GitHub Enterprise Server. */
  githubUrl: string
  /** A check of GitHub runs in the background: the rows can change at the next load. */
  checking: boolean
  /** REV-18. The precision of the rows of the page over 30 days; null without the Findings screen. */
  precisions?: Map<string, Precision> | null
  notice: ReposNotice | null
  /** For the dates of the screen. */
  now: Date
}

/** The filter, the search and the page of the list, as the query of the screen gives them. */
export interface RepoList extends RepoListQuery {
  filter: RepoFilter
  search: string
  /** KNT-146: `?page=n`, from 1. */
  page: number
}

const SEARCH_MAX = 100

const FILTER_LABELS: Record<RepoFilter, string> = {
  all: 'All',
  enabled: 'Enabled',
  disabled: 'Not enabled',
  switching: 'To switch',
}

/** The list that a query of the screen asks for. A value that the screen does not know is ignored. */
export function readRepoList(query: URLSearchParams): RepoList {
  let filter = query.get('filter')
  return {
    filter: REPO_FILTERS.includes(filter as RepoFilter) ? (filter as RepoFilter) : 'all',
    search: (query.get('q') ?? '').trim().slice(0, SEARCH_MAX),
    page: readPageNumber(query),
  }
}

/** The query of a list: what `readRepoList` reads back. Empty for the first page of all the repos. */
export function repoListQuery(list: Partial<RepoList>): URLSearchParams {
  let query = new URLSearchParams()
  if (list.filter && list.filter !== 'all') query.set('filter', list.filter)
  if (list.search) query.set('q', list.search)
  if (list.page && list.page > 1) query.set('page', String(list.page))
  return query
}

/** `/repos`, with the query of a list when it has one. */
function reposHref(list: Partial<RepoList>): string {
  let query = repoListQuery(list).toString()
  return query ? `${routes.repos.href()}?${query}` : routes.repos.href()
}

const LEVELS: Record<RepoView['defaultLevel'], string> = { lite: 'lite', balanced: 'balanced', heavy: 'heavy' }

/** The name of a repository without its owner, when the owner is the org on screen. */
function shortName(fullName: string, org: string): string {
  let [owner, name] = fullName.split('/') as [string, string]
  return owner.toLowerCase() === org.toLowerCase() ? name : fullName
}

/**
 * The Repos screen (REV-9): the repositories of the installation, their visibility, their level,
 * the model of their last review, and their last review. An admin enables and disables a
 * repository; a member reads.
 */
export function ReposPage(handle: Handle<ReposPageProps>) {
  return () => {
    let { frame, page, list, installations, githubUrl, checking, precisions, notice, now } = handle.props
    let repos = page.rows
    let viewer = frame.viewer!
    let admin = viewer.canEdit
    let org = viewer.org.name
    let { all, enabled } = page.counts
    let checkedAt = page.checkedAt
    let csrf = frame.csrfToken ? <input type="hidden" name="_csrf" value={frame.csrfToken} /> : null

    return (
      <Shell
        frame={frame}
        section="repos"
        title="Repos"
        actions={
          <>
            {installations.map((installation) => (
              <a class={buttonClass('ghost')} href={installation.url} rel="noreferrer" target="_blank">
                <GitHubIcon />
                {installations.length > 1 ? `Manage ${installation.login} on GitHub` : 'Manage the installation on GitHub'}
                <ExternalIcon />
                <span class="visually-hidden">(new tab)</span>
              </a>
            ))}
            <form method="post" action={routes.reposCheck.href()}>
              {csrf}
              <Button type="submit">
                <RefreshCwIcon />
                Read GitHub again
              </Button>
            </form>
          </>
        }
      >
        {notice?.kind === 'check_failed' ? <Notice notice={notice} org={org} /> : null}
        {/* KNT-147: a live region on every load, empty when there is no notice. repo-toggle.js fills
            it after a change in place: a screen reader reads a change of its content, not a region
            that comes in already filled. */}
        {admin || (notice && notice.kind !== 'check_failed') ? (
          // Only for an admin when empty: a member has the "Read only" status, and changes nothing.
          <div class="notice-slot" role="status">
            {notice && notice.kind !== 'check_failed' ? <Notice notice={notice} org={org} /> : null}
          </div>
        ) : null}


        <p class="repos-summary" aria-live="polite">
          {all} {plural(all, 'repo')} in the installation · {enabled} enabled ·{' '}
          {checking ? (
            // REV-26: public/assets/repos.js reads the screen again until the check is over.
            <span data-recheck="">
              check in progress on GitHub · <a href={routes.repos.href()}>Reload</a>
            </span>
          ) : checkedAt
              ? `read on GitHub ${agoOrDate(checkedAt, now)}`
              : 'not checked on GitHub yet'}
        </p>

        {all === 0 ? (
          <section class="empty" aria-labelledby="empty-title">
            <h2 id="empty-title">No repo yet</h2>
            <p>
              Kentō reads the repos of the installation on GitHub. They show here after the check. "Manage the
              installation" chooses the repos that the App sees.
            </p>
          </section>
        ) : (
          <>
            <ListControls page={page} list={list} />
            {repos.length === 0 ? (
              <section class="empty" aria-labelledby="empty-title">
                <h2 id="empty-title">No repo matches</h2>
                <p>
                  {list.search ? `No name contains "${list.search}"` : 'No repo'}
                  {list.filter !== 'all' ? ` in "${FILTER_LABELS[list.filter]}"` : ''}.{' '}
                  <a href={routes.repos.href()}>Show all the repos</a>
                </p>
              </section>
            ) : (
              <div class="table-wrap">
                {/* REV-36. The buttons of the rows post this form: the token is written once, not once a row. */}
                {admin ? (
                  <form id="repo-actions" method="post" hidden>
                    {csrf}
                  </form>
                ) : null}
                <table class="table repos-table">
                  <caption class="visually-hidden">Repos of the installation {org}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Repo</th>
                      <th scope="col">Level</th>
                      <th scope="col">Model</th>
                      <th scope="col">Last review</th>
                      <th scope="col">
                        Precision 30 d
                      </th>
                      <th scope="col">
                        <span class="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {repos.map((repo) => (
                      <RepoRow
                        repo={repo}
                        org={org}
                        admin={admin}
                        githubUrl={githubUrl}
                        now={now}
                        precision={precisions?.get(repo.id) ?? null}
                        back={repoListQuery(list).toString()}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pager
              page={page.page}
              pages={page.pages}
              offset={page.offset}
              shown={repos.length}
              matching={page.matching}
              href={(number) => reposHref({ ...list, page: number })}
              label="Pages of the list"
            />
          </>
        )}

        {checking ? <script src={`/assets/repos.js?v=${encodeURIComponent(frame.assetVersion)}`} defer></script> : null}
        {/* KNT-147: "Enable" and "Disable" change the row in place, with no reload and no jump. */}
        {admin ? <script src={`/assets/repo-toggle.js?v=${encodeURIComponent(frame.assetVersion)}`} defer></script> : null}
      </Shell>
    )
  }
}

function Notice(handle: Handle<{ notice: ReposNotice; org: string }>) {
  return () => {
    let { notice, org } = handle.props
    if (notice.kind === 'check_failed') {
      return (
        <div class="banner banner-alert" role="alert">
          <AlertIcon />
          <p>
            <strong>GitHub did not answer.</strong> The list stays the one of the last check. Try again in a minute.
          </p>
        </div>
      )
    }
    let text =
      notice.kind === 'checked' ? (
        <p>
          <strong>List up to date.</strong> Kentō read the repos and their workflows on GitHub again.
        </p>
      ) : notice.kind === 'enabled' ? (
        <p>
          <strong>{shortName(notice.fullName, org)} is enabled.</strong> The next push of a PR creates a Kentō job.
        </p>
      ) : (
        <p>
          <strong>{shortName(notice.fullName, org)} is disabled.</strong> No new job starts
          {notice.cancelled > 0
            ? ` (${notice.cancelled} queued ${notice.cancelled === 1 ? 'job' : 'jobs'} cancelled)`
            : ''}
          . The published reviews stay.
        </p>
      )
    // In the slot `role="status"` of the screen: no role of its own.
    return (
      <div class="banner banner-ok">
        <CheckIcon />
        {text}
      </div>
    )
  }
}

interface RepoRowProps {
  repo: RepoView
  org: string
  admin: boolean
  githubUrl: string
  now: Date
  /** REV-18. Over 30 days; null when the repository has no closed finding. */
  precision: Precision | null
  /** The query of the list on screen: the forms come back to it. */
  back: string
}

function RepoRow(handle: Handle<RepoRowProps>) {
  return () => {
    let { repo, org, admin, githubUrl, now, precision, back } = handle.props
    let suffix = back ? `?${back}` : ''
    let name = shortName(repo.fullName, org)
    let repoUrl = `${githubUrl}/${repo.fullName}`
    return (
      <tr id={`repo-${repo.id}`}>
        <th scope="row">
          {/* KNT-180: the visibility is the icon left of the name; its word is for a screen reader only. */}
          <a class="repo-name" href={repoUrl} rel="noreferrer" title={repo.fullName}>
            {repo.private === null ? <CircleHelpIcon /> : repo.private ? <LockIcon /> : <GlobeIcon />}
            <span>{name}</span>
          </a>
          <span class="visually-hidden">, {visibility(repo.private)}</span>
        </th>
        <td class="mono">{LEVELS[repo.defaultLevel]}</td>
        <td>{repo.lastReview ? <ProviderModel model={repo.lastReview.model} /> : '–'}</td>
        <td>
          {repo.lastReview ? (
            // KNT-182: one line. A narrow cell cuts it with an ellipsis; the title keeps the whole of it.
            <span
              class="repo-last-review"
              title={`#${repo.lastReview.prNumber} · ${repo.lastReview.score}/5, published ${when(repo.lastReview.publishedAt)}`}
            >
              <a href={pullRoutes.pull.href({ id: repo.id, number: String(repo.lastReview.prNumber) })} class="mono">
                #{repo.lastReview.prNumber} · {repo.lastReview.score}/5
              </a>{' '}
              <span class="hint">· {agoOrDate(repo.lastReview.publishedAt, now)}</span>
            </span>
          ) : (
            '–'
          )}
        </td>
        <td>
          {precision ? (
            <a href={findingsHref({ view: 'closed', repoId: repo.id })}>
              <PrecisionValue precision={precision} />
              <span class="visually-hidden">: the closed findings of {name}</span>
            </a>
          ) : repo.enabled ? (
            '–'
          ) : (
            <span class="hint">Kentō not enabled</span>
          )}
        </td>
        <td class="row-action">
          {admin && !repo.enabled ? (
            // REV-36: a secondary button. The primary style stays for the main action of a screen.
            <Button size="sm" type="submit" form="repo-actions" formaction={routes.repoEnable.href({ id: repo.id }) + suffix}>
              <PowerIcon />
              Enable<span class="visually-hidden"> {name}</span>
            </Button>
          ) : null}
          {/* REV-91: the other actions of a row sit in "…": the config, the findings, "Remove review.yml" at the end of the
              switch (KNT-179), and "Disable Kentō…" (KNT-163: it hydrates). */}
          <RowMenu
            id={repo.id}
            name={name}
            removeWorkflow={admin ? removeWorkflowHref(repo, githubUrl) : undefined}
            disable={admin && repo.enabled ? true : undefined}
            back={suffix || undefined}
          />
        </td>
      </tr>
    )
  }
}

/** The search on the name, and the filters with their counts. A form and links: no JavaScript. */
function ListControls(handle: Handle<{ page: RepoPage; list: RepoList }>) {
  return () => {
    let { page, list } = handle.props
    return (
      <div class="list-controls">
        <form class="list-search" method="get" action={routes.repos.href()} role="search">
          <label class="visually-hidden" for="repos-search">
            Search a repo by its name
          </label>
          {/* KNT-146: the magnifier sits in the field, on its left; the field makes room for it. */}
          <SearchIcon class="list-search-icon" />
          <Input
            id="repos-search"
            type="search"
            name="q"
            value={list.search}
            maxlength={SEARCH_MAX}
            placeholder="Name of the repo"
            autocomplete="off"
          />
          {list.filter !== 'all' ? <input type="hidden" name="filter" value={list.filter} /> : null}
          {/* Enter sends the search; the button serves a screen reader and a browser without it. */}
          {/* Out of sight until the keyboard reaches it: then it shows, with its focus ring. */}
          <Button class="list-search-submit" type="submit">
            Search
          </Button>
        </form>
        <nav class="segmented-links" aria-label="Filter the repos">
          {REPO_FILTERS.map((filter) => (
            <a href={reposHref({ filter, search: list.search })} aria-current={filter === list.filter ? 'page' : undefined}>
              {FILTER_LABELS[filter]}
              <span class="list-filter-count">{page.counts[filter]}</span>
            </a>
          ))}
        </nav>
      </div>
    )
  }
}

/** The model of the last review, `anthropic/claude-haiku-5.5`: the model, then its provider. */
function ProviderModel(handle: Handle<{ model: string }>) {
  return () => {
    let { model } = handle.props
    let slash = model.indexOf('/')
    // REV-91: the model alone, as on the board; its provider in the title.
    return (
      <span class="mono" title={model}>
        {slash > 0 ? model.slice(slash + 1) : model}
      </span>
    )
  }
}

/** What a screen reader hears after the name of a repository (KNT-180). */
function visibility(isPrivate: boolean | null): string {
  return isPrivate === null ? 'unknown visibility' : isPrivate ? 'private' : 'public'
}

/**
 * The page of GitHub that deletes review.yml, once Kentō published `SWITCH_TARGET` reviews in a row
 * and the file is still in the repository; undefined before (KNT-179: it was in the column "Switch").
 */
export function removeWorkflowHref(repo: RepoView, githubUrl: string): string | undefined {
  let workflowLeft = repo.workflow === 'reusable' || repo.workflow === 'copy'
  if (!repo.enabled || repo.streak < SWITCH_TARGET || !workflowLeft || !repo.workflowPath || !repo.defaultBranch) return undefined
  let path = repo.workflowPath.split('/').map(encodeURIComponent).join('/')
  return `${githubUrl}/${repo.fullName}/delete/${encodeURIComponent(repo.defaultBranch)}/${path}`
}
