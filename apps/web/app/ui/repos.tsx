import type { Handle } from 'remix/component'

import { commandNames } from '../github/comment-command.ts'
import { REPO_FILTERS, SWITCH_TARGET, type RepoFilter, type RepoListQuery, type RepoPage, type RepoView } from '../repos/store.ts'
import { pageRoutes as routes, pullRoutes } from '../routes.ts'
import type { Precision } from '../findings/precision.ts'
import { Confirm } from './confirm.tsx'
import { findingsHref } from './findings.tsx'
import { PrecisionValue } from './precision.tsx'
import { agoOrDate, plural } from './format.ts'
import { AlertIcon, CheckIcon, ExternalIcon, GitHubIcon, LockIcon } from './icons.tsx'
import {
  BookMarkedIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  GlobeIcon,
  ListChecksIcon,
  PowerIcon,
  PowerOffIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersIcon,
} from './lucide.tsx'
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
  /** The page of the installation of the App on GitHub. */
  installationUrl: string
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
 * The Repos screen (REV-9): the repositories of the installation, their mode, their level, the
 * model of their last review, the switch counter and their last review. An admin enables and
 * disables a repository; a member reads.
 */
/** The command of the Action of review.yml. When it is also a name of Kentō, both answer it. */
const ACTION_COMMAND = 'sakuga-review'

/** Which command gets two answers during the switch, with the names of the instance (KENTO_COMMAND_NAMES). */
function SwitchCommands() {
  return () => {
    let names = commandNames()
    let own = names.find((name) => name !== ACTION_COMMAND)
    return (
      <li>
        {names.includes(ACTION_COMMAND) ? (
          <>
            A <code>@{ACTION_COMMAND}</code> command then gets two answers.{own ? ' ' : ''}
          </>
        ) : null}
        {own ? (
          <>
            <code>@{own}</code> speaks to Kentō only.
          </>
        ) : null}
      </li>
    )
  }
}

export function ReposPage(handle: Handle<ReposPageProps>) {
  return () => {
    let { frame, page, list, installationUrl, githubUrl, checking, precisions, notice, now } = handle.props
    let repos = page.rows
    let viewer = frame.viewer!
    let admin = viewer.role === 'admin'
    let org = viewer.org.login
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
            <a class="button button-ghost" href={installationUrl} rel="noreferrer" target="_blank">
              <GitHubIcon />
              Manage the installation on GitHub
              <ExternalIcon />
              <span class="visually-hidden">(new tab)</span>
            </a>
            <form method="post" action={routes.reposCheck.href()}>
              {csrf}
              <button class="button" type="submit">
                <RefreshCwIcon />
                Read GitHub again
              </button>
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
                      <th scope="col">Reviews by</th>
                      <th scope="col">Level</th>
                      <th scope="col">Model</th>
                      <th scope="col">Switch</th>
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

        {all > 0 ? (
          <p class="repos-legend">
            Reviews by:
            <span class="tag tag-ok">
              <CircleCheckIcon />
              Kentō
            </span>{' '}
            the App does the reviews
            <span class="tag tag-warn">
              <CircleCheckIcon />
              Kentō + review.yml
            </span>{' '}
            switch in progress, two reviews per push
            <span class="tag">
              <CircleDashedIcon />
              review.yml
            </span>{' '}
            the GitHub Action alone
            <span class="tag">
              <CircleDashedIcon />
              none
            </span>{' '}
            installed, with no review
          </p>
        ) : null}
        {/* REV-91: the notes of the switch are asked for, not shown at all times. */}
        <details class="card repos-howto">
          <summary>How the switch from review.yml to Kentō works</summary>
            <div class="repos-notes">
            <section class="card note" aria-labelledby="criterion-title">
              <h2 id="criterion-title">Switch criterion</h2>
              <ul>
                <li>
                  <strong>{SWITCH_TARGET} reviews published by Kentō</strong> in a row on the repo, with no failed job and no
                  double publication.
                </li>
                <li>A failed job sets the counter back to zero. A double publication does too.</li>
                <li>
                  At {SWITCH_TARGET}/{SWITCH_TARGET}, "Remove review.yml" opens the deletion of the file on GitHub. The commit
                  that removes it ends the switch.
                </li>
              </ul>
            </section>
            <section class="card note" aria-labelledby="fallback-title">
              <h2 id="fallback-title">Fallback during the switch</h2>
              <ul>
                <li>
                  While review.yml stays in the repo, the Action also reviews each push. The PR then gets two reviews, and the one of
                  the Action is the fallback if Kentō fails.
                </li>
                <SwitchCommands />
                <li>If you disable the repo, review.yml alone reviews from the next push. The published reviews stay.</li>
              </ul>
            </section>
          </div>
        </details>
        {checking ? <script src={`/assets/repos.js?v=${encodeURIComponent(frame.assetVersion)}`} defer></script> : null}
        {/* KNT-147: "Enable" and "Disable" change the row in place, with no reload and no jump. */}
        {admin ? <script src={`/assets/repo-toggle.js?v=${encodeURIComponent(frame.assetVersion)}`} defer></script> : null}
        {/* REV-91: the menus "…" of the rows close on Escape and on a click outside. */}
        <script src={`/assets/row-menu.js?v=${encodeURIComponent(frame.assetVersion)}`} defer></script>
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
          <a class="repo-name" href={repoUrl} rel="noreferrer" title={repo.fullName}>
            <BookMarkedIcon />
            <span>{name}</span>
          </a>
          <span class="hint repo-visibility">
            {repo.private === null ? <CircleHelpIcon /> : repo.private ? <LockIcon /> : <GlobeIcon />}
            {repo.private === null ? 'unknown visibility' : repo.private ? 'private' : 'public'}
          </span>
        </th>
        <td>
          <Mode repo={repo} />
        </td>
        <td class="mono">{LEVELS[repo.defaultLevel]}</td>
        <td>{repo.lastReview ? <ProviderModel model={repo.lastReview.model} /> : '–'}</td>
        <td>
          <Switch repo={repo} admin={admin} githubUrl={githubUrl} />
        </td>
        <td>
          {repo.lastReview ? (
            <span class="stack">
              <a href={pullRoutes.pull.href({ id: repo.id, number: String(repo.lastReview.prNumber) })} class="mono">
                #{repo.lastReview.prNumber} · {repo.lastReview.score}/5
              </a>
              <span class="hint">{agoOrDate(repo.lastReview.publishedAt, now)}</span>
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
            <button class="button button-small" type="submit" form="repo-actions" formaction={routes.repoEnable.href({ id: repo.id }) + suffix}>
              <PowerIcon />
              Enable<span class="visually-hidden"> {name}</span>
            </button>
          ) : null}
          {/* REV-91: the other actions of a row sit in "…": the config, the findings, and "Disable Kentō…". */}
          <details class="row-menu">
            {/* No class: kento.css styles `.row-menu > summary` and `> div`, the page holds 25 of them (budget of 110 KB). */}
            <summary aria-label={`Actions of ${name}`}>…</summary>
            <div>
              <a href={routes.repoConfig.href({ id: repo.id })}>
                <SlidersIcon />
                Open the config
              </a>
              <a href={findingsHref({ repoId: repo.id })}>
                <ListChecksIcon />
                See the findings
              </a>
              {admin && repo.enabled ? (
                <Confirm
                  trigger={
                    // The icon, then one flex item: the gap of .button would split the visible "Disable…".
                    <>
                      <PowerOffIcon />
                      <span>
                        Disable<span class="visually-hidden"> {name}</span> Kentō…
                      </span>
                    </>
                  }
                  action={routes.repoDisable.href({ id: repo.id }) + suffix}
                  csrf={null}
                  form="repo-actions"
                  submit={`Disable ${name}`}
                >
                  <p>No new job starts, and the queued jobs are cancelled. The published reviews and the counter stay.</p>
                </Confirm>
              ) : null}
            </div>
          </details>
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
          <input
            class="input"
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
          <button class="button list-search-submit" type="submit">
            Search
          </button>
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

/** REV-91. Who reviews the repository, in the four words of the design, with the detail under it. */
function Mode(handle: Handle<{ repo: RepoView }>) {
  return () => {
    let { repo } = handle.props
    let workflowLeft = repo.workflow === 'reusable' || repo.workflow === 'copy'
    let detail =
      repo.workflow === 'reusable' ? (
        <span class="hint mono">review.yml@{repo.workflowRef}</span>
      ) : repo.workflow === 'copy' ? (
        <span class="hint">copy of review.yml</span>
      ) : repo.workflow === null ? (
        <span class="hint">not checked yet</span>
      ) : null
    if (repo.enabled) {
      return (
        <span class="stack">
          <span class={`tag ${workflowLeft ? 'tag-warn' : 'tag-ok'}`}>
            <CircleCheckIcon />
            {workflowLeft ? 'Kentō + review.yml' : 'Kentō'}
          </span>
          {workflowLeft ? detail : null}
        </span>
      )
    }
    return (
      <span class="stack">
        <span class="tag">
          <CircleDashedIcon />
          {workflowLeft ? 'review.yml' : 'none'}
        </span>
        {detail}
      </span>
    )
  }
}

function Switch(handle: Handle<{ repo: RepoView; admin: boolean; githubUrl: string }>) {
  return () => {
    let { repo, admin, githubUrl } = handle.props
    if (!repo.enabled) return <>–</>
    let count = Math.min(repo.streak, SWITCH_TARGET)
    let done = count >= SWITCH_TARGET
    let workflowLeft = (repo.workflow === 'reusable' || repo.workflow === 'copy') && repo.workflowPath !== null
    let reset =
      !done && repo.resetBy === 'failure'
        ? 'set back to zero after a failure'
        : !done && repo.resetBy === 'double'
          ? 'set back to zero after a double publication'
          : null
    return (
      <span class="stack">
        <span class="switch">
          <span class="switch-count">
            {count}/{SWITCH_TARGET}
          </span>
          {/* The count says it in text: the bar is decorative. No inline style (CSP): a <progress>. */}
          <progress class={done ? 'switch-bar switch-done' : 'switch-bar'} max={SWITCH_TARGET} value={count} aria-hidden="true"></progress>
        </span>
        {/* A note, not an alert: the counter starts again by itself at the next review. */}
        {reset ? (
          <span class="hint">
            {reset}
            {repo.resetPr !== null ? (
              <>
                {' '}
                on{' '}
                <a href={`${githubUrl}/${repo.fullName}/pull/${repo.resetPr}`} rel="noreferrer">
                  #{repo.resetPr}
                </a>
              </>
            ) : null}
          </span>
        ) : null}
        {done && workflowLeft && admin && repo.defaultBranch ? (
          <a
            class="button button-small"
            href={`${githubUrl}/${repo.fullName}/delete/${encodeURIComponent(repo.defaultBranch)}/${repo.workflowPath!.split('/').map(encodeURIComponent).join('/')}`}
            rel="noreferrer"
            target="_blank"
          >
            Remove review.yml
            <span class="visually-hidden"> from {repo.fullName} (GitHub, new tab)</span>
          </a>
        ) : done && workflowLeft ? (
          <span class="hint">ready to remove review.yml</span>
        ) : done ? (
          <span class="hint hint-ok">switched</span>
        ) : null}
      </span>
    )
  }
}
