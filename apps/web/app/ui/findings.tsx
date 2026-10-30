import type { Handle } from 'remix/component'

import {
  FINDING_VIEWS,
  SEARCH_MAX,
  SEVERITIES,
  type FindingFacets,
  type FindingQuery,
  type FindingRow,
  type FindingScreenPage,
  type FindingView,
  type Severity,
} from '../findings/screen.ts'
import { pageRoutes as routes } from '../routes.ts'
import { agoOrDate, plural } from './format.ts'
import { Shell, type PageFrame } from './shell.tsx'

/** The filters, the search and the page of the list, as the query of the screen gives them. */
export interface FindingList extends FindingQuery {
  view: FindingView
  repoId: string | null
  severity: Severity | null
  ruleId: string | null
  search: string
  after: string | null
  before: string | null
}

export interface FindingsPageProps {
  frame: PageFrame
  page: FindingScreenPage
  facets: FindingFacets
  list: FindingList
  /** `https://github.com`, or the GitHub Enterprise Server: the links to the pull requests. */
  githubUrl: string
  /** For the dates of the screen. */
  now: Date
}

const VIEW_LABELS: Record<FindingView, string> = {
  open: 'Open',
  fixed: 'Fixed',
  dismissed: 'Dismissed',
  wontfix: 'Wontfix',
  stale: 'Stale',
  closed: 'Clos',
  all: 'Tous',
}

/** The priority of a severity, as the comments of the bot write it (engine/render.ts). */
const PRIORITY: Record<Severity, { label: string; tag: string; name: string }> = {
  critical: { label: 'P0', tag: 'tag-alert', name: 'critique' },
  major: { label: 'P1', tag: 'tag-warn', name: 'majeur' },
  minor: { label: 'P2', tag: 'tag-quiet', name: 'mineur' },
}

const CATEGORY_LABELS: Record<string, string> = {
  bug: 'Bug',
  security: 'Sécurité',
  data: 'Données',
  contract: 'Contrat',
  test: 'Test',
}

const STATUS_TAGS: Record<FindingRow['status'], string> = {
  open: 'tag-info',
  fixed: 'tag-ok',
  dismissed: 'tag-quiet',
  wontfix: 'tag-quiet',
  stale: 'tag-warn',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The list that a query of the screen asks for. A value that the screen does not know is ignored. */
export function readFindingList(query: URLSearchParams): FindingList {
  let view = query.get('status')
  let severity = query.get('priority')
  let repo = query.get('repo')
  let rule = query.get('rule')
  return {
    view: FINDING_VIEWS.includes(view as FindingView) ? (view as FindingView) : 'open',
    repoId: repo && UUID.test(repo) ? repo : null,
    severity: SEVERITIES.includes(severity as Severity) ? (severity as Severity) : null,
    ruleId: rule && UUID.test(rule) ? rule : null,
    search: (query.get('q') ?? '').trim().slice(0, SEARCH_MAX),
    after: query.get('after') || null,
    before: query.get('after') ? null : query.get('before') || null,
  }
}

/** The query of a list: what `readFindingList` reads back. Empty for the first page of the open findings. */
export function findingListQuery(list: Partial<FindingList>): URLSearchParams {
  let query = new URLSearchParams()
  if (list.view && list.view !== 'open') query.set('status', list.view)
  if (list.repoId) query.set('repo', list.repoId)
  if (list.severity) query.set('priority', list.severity)
  if (list.ruleId) query.set('rule', list.ruleId)
  if (list.search) query.set('q', list.search)
  if (list.after) query.set('after', list.after)
  else if (list.before) query.set('before', list.before)
  return query
}

/** `/findings`, with the query of a list when it has one. */
export function findingsHref(list: Partial<FindingList>): string {
  let query = findingListQuery(list).toString()
  return query ? `${routes.findings.href()}?${query}` : routes.findings.href()
}

/** The filters of a list without its page: a new filter or tab starts at the first page. */
function filtersOf(list: FindingList): Partial<FindingList> {
  return { view: list.view, repoId: list.repoId, severity: list.severity, ruleId: list.ruleId, search: list.search }
}

function hasFilters(list: FindingList): boolean {
  return Boolean(list.repoId || list.severity || list.ruleId || list.search)
}

/** The name of a repository without its owner, when the owner is the org on screen. */
function shortName(fullName: string, org: string): string {
  let [owner, name] = fullName.split('/') as [string, string]
  return owner.toLowerCase() === org.toLowerCase() ? name : fullName
}

/**
 * The Findings screen (REV-18): every finding of the org, filtered by repository, status, priority,
 * rule and a search, a page of 50 at a time.
 */
export function FindingsPage(handle: Handle<FindingsPageProps>) {
  return () => {
    let { frame, page, facets, list, githubUrl, now } = handle.props
    let org = frame.viewer!.org.login
    let none = page.counts.all === 0 && !hasFilters(list)
    return (
      <Shell frame={frame} section="findings" title="Findings" lead="Chaque finding des reviews de Kentō, et ce qu’il est devenu.">
        {none ? (
          <section class="empty" aria-labelledby="empty-title">
            <h2 id="empty-title">Aucun finding pour l’instant</h2>
            <p>
              Chaque finding d’une review publiée par Kentō s’affichera ici, avec son statut : open, fixed quand un push le corrige,
              dismissed ou wontfix quand quelqu’un l’écarte. <a href={routes.repos.href()}>Voir les repos</a>
            </p>
          </section>
        ) : (
          <>
            <FilterForm list={list} facets={facets} org={org} />
            <nav class="list-filters findings-views" aria-label="Statut des findings">
              <ul>
                {FINDING_VIEWS.map((view) => (
                  <li>
                    <a href={findingsHref({ ...filtersOf(list), view })} aria-current={view === list.view ? 'page' : undefined}>
                      {VIEW_LABELS[view]}
                      <span class="list-filter-count">{page.counts[view].toLocaleString('fr-FR')}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            {page.rows.length === 0 ? (
              <Empty page={page} list={list} />
            ) : (
              <div class="table-wrap">
                <table class="table findings-table">
                  <caption class="visually-hidden">
                    Findings {VIEW_LABELS[list.view].toLowerCase()} de {org}, du plus récent au plus ancien
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Priorité</th>
                      <th scope="col">Finding</th>
                      <th scope="col">PR</th>
                      <th scope="col">Source</th>
                      <th scope="col">Confiance</th>
                      <th scope="col">Retrouvé</th>
                      <th scope="col">Depuis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((row) => (
                      <FindingTableRow row={row} org={org} githubUrl={githubUrl} now={now} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pager page={page} list={list} />
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
      <form class="findings-filters" method="get" action={routes.findings.href()} role="search" aria-label="Filtrer les findings">
        {list.view !== 'open' ? <input type="hidden" name="status" value={list.view} /> : null}
        <div class="findings-filter findings-filter-search">
          <label class="field-label" for="findings-q">
            Recherche
          </label>
          <input
            class="input"
            id="findings-q"
            type="search"
            name="q"
            value={list.search}
            maxlength={SEARCH_MAX}
            placeholder="Titre ou chemin"
            autocomplete="off"
          />
        </div>
        <div class="findings-filter">
          <label class="field-label" for="findings-repo">
            Repo
          </label>
          <select class="input" id="findings-repo" name="repo">
            <option value="" selected={!list.repoId}>
              Tous les repos
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
            Priorité
          </label>
          <select class="input" id="findings-priority" name="priority">
            <option value="" selected={!list.severity}>
              Toutes
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
            Règle
          </label>
          <select class="input" id="findings-rule" name="rule" disabled={facets.rules.length === 0}>
            <option value="" selected={!list.ruleId}>
              {facets.rules.length === 0 ? 'Aucune règle' : 'Toutes'}
            </option>
            {facets.rules.map((rule) => (
              <option value={rule.id} selected={rule.id === list.ruleId}>
                {rule.repo ? `${shortName(rule.repo, org)} · ${rule.title}` : `Org · ${rule.title}`}
              </option>
            ))}
          </select>
        </div>
        <div class="findings-filter-actions">
          <button class="button" type="submit">
            Filtrer
          </button>
          {hasFilters(list) ? (
            <a class="button button-ghost" href={findingsHref({ view: list.view })}>
              Effacer les filtres
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
            ? 'Aucun finding pour ces filtres'
            : list.view === 'closed'
              ? `Aucun finding clos${filtered ? ' pour ces filtres' : ''}`
              : `Aucun finding ${label}${filtered ? ' pour ces filtres' : ''}`}
        </h2>
        <p>
          {list.view === 'open' && closed > 0 ? (
            <>
              <a href={findingsHref({ ...filtersOf(list), view: 'closed' })}>
                Voir {closed > 1 ? `les ${closed.toLocaleString('fr-FR')} findings clos` : 'le finding clos'}
              </a>
              {filtered ? ' · ' : null}
            </>
          ) : list.view !== 'all' && page.counts.all > 0 ? (
            <>
              <a href={findingsHref({ ...filtersOf(list), view: 'all' })}>
                Voir {page.counts.all > 1 ? `les ${page.counts.all.toLocaleString('fr-FR')} findings` : 'le finding'} de tous les statuts
              </a>
              {filtered ? ' · ' : null}
            </>
          ) : null}
          {filtered ? <a href={findingsHref({ view: list.view })}>Effacer les filtres</a> : null}
        </p>
      </section>
    )
  }
}

function FindingTableRow(handle: Handle<{ row: FindingRow; org: string; githubUrl: string; now: Date }>) {
  return () => {
    let { row, org, githubUrl, now } = handle.props
    let priority = PRIORITY[row.severity]
    let pullUrl = `${githubUrl}/${row.repo}/pull/${row.prNumber}`
    let seenAgain = row.lastSeenSha !== row.firstSeenSha
    return (
      <tr id={`finding-${row.id}`}>
        <td>
          <span class={`tag ${priority.tag}`} title={`Priorité ${priority.name}`}>
            {priority.label}
          </span>
        </td>
        <th scope="row">
          <span class="stack finding-cell">
            {row.githubCommentId !== null ? (
              <a class="finding-title" href={`${pullUrl}#discussion_r${row.githubCommentId}`} rel="noreferrer">
                {row.title}
              </a>
            ) : (
              <span class="finding-title">{row.title}</span>
            )}
            <span class="hint mono finding-path">
              {row.path}:{row.line}
            </span>
            {row.status !== 'open' ? (
              <span class="finding-status">
                <span class={`tag ${STATUS_TAGS[row.status]}`}>{row.status}</span>
                {row.statusReason ? <span class="hint">{row.statusReason}</span> : null}
              </span>
            ) : null}
          </span>
        </th>
        <td>
          <span class="stack">
            <a href={pullUrl} rel="noreferrer">
              #{row.prNumber}
            </a>
            <span class="hint">{shortName(row.repo, org)}</span>
          </span>
        </td>
        <td>
          {row.ruleTitle ? (
            <span class="stack">
              <span>Règle</span>
              <span class="hint">{row.ruleTitle}</span>
            </span>
          ) : (
            <span class="stack">
              <span>Review</span>
              <span class="hint">{CATEGORY_LABELS[row.category] ?? row.category}</span>
            </span>
          )}
        </td>
        <td>
          <span class="mono">{row.confidence} %</span>
        </td>
        <td>
          {seenAgain ? (
            <span class="stack">
              <span>oui</span>
              <span class="hint mono">{row.lastSeenSha.slice(0, 7)}</span>
            </span>
          ) : (
            <>
              <span aria-hidden="true">–</span>
              <span class="visually-hidden">non</span>
            </>
          )}
        </td>
        <td>
          <time datetime={row.createdAt.toISOString()}>{agoOrDate(row.createdAt, now)}</time>
        </td>
      </tr>
    )
  }
}

/** « 51–100 sur 1 234 », and the links to the pages around. Shown when the tab has more than a page. */
function Pager(handle: Handle<{ page: FindingScreenPage; list: FindingList }>) {
  return () => {
    let { page, list } = handle.props
    if (page.rows.length === 0 || (page.next === null && page.previous === null)) return null
    let from = page.offset + 1
    let to = page.offset + page.rows.length
    let filters = filtersOf(list)
    return (
      <nav class="pager" aria-label="Pages de la liste">
        {page.previous ? (
          <a class="button button-small" href={findingsHref({ ...filters, before: page.previous })} rel="prev">
            Précédents
          </a>
        ) : (
          <span aria-hidden="true"></span>
        )}
        <p class="pager-range">
          {from.toLocaleString('fr-FR')}–{to.toLocaleString('fr-FR')} sur {page.matching.toLocaleString('fr-FR')}{' '}
          {plural(page.matching, 'finding')}
        </p>
        {page.next ? (
          <a class="button button-small" href={findingsHref({ ...filters, after: page.next })} rel="next">
            Suivants
          </a>
        ) : (
          <span aria-hidden="true"></span>
        )}
      </nav>
    )
  }
}
