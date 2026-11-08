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
import { agoOrDate, plural } from './format.ts'
import { DismissDialog } from './dismiss-dialog.tsx'
import { AlertIcon, CheckIcon } from './icons.tsx'
import { statusClass } from './pull.tsx'
import { PrecisionSection, shortName } from './precision.tsx'
import { Shell, type PageFrame } from './shell.tsx'

/** The filters, the search and the page of the list, as the query of the screen gives them. */
export interface FindingList extends FindingQuery {
  view: FindingView
  repoId: string | null
  severity: Severity | null
  ruleId: string | null
  reason: string | null
  search: string
  /** REV-22. The pull requests of one person: the link « Voir mes N findings open » of their screen. */
  author: string | null
  days: number | null
  after: string | null
  before: string | null
  /** REV-91. The tab of the screen: the list, or the precision (`?vue=precision`). */
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
  /** What the screen says after « Marquer dismissed » or « Marquer wontfix », from the query of the redirect. */
  notice?: FindingsNotice | null
}

/** The answer of a change of status: how many changed, and how many replies GitHub got. */
export type FindingsNotice =
  | { kind: 'done'; status: BulkStatus; changed: number; unchanged: number; fixed: number; missing: number; failed: number; replied: number; unreplied: number }
  | { kind: 'error'; error: 'none' | 'too_many' | 'status' | 'reason' | 'reason_long' }

const NOTICE_ERRORS: Record<Extract<FindingsNotice, { kind: 'error' }>['error'], string> = {
  none: 'Cochez au moins un finding, puis choisissez l’action.',
  too_many: `Au plus ${BULK_MAX} findings à la fois.`,
  status: 'Choisissez « Marquer dismissed » ou « Marquer wontfix ».',
  reason: 'Choisissez un motif, ou écrivez-le dans « Autre ».',
  reason_long: `Le motif tient en ${REASON_MAX} caractères au plus.`,
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
  closed: 'clos',
  all: 'tous',
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
    after,
    before: after ? null : cursorOf(query.get('before')),
    tab: query.get('vue') === 'precision' ? 'precision' : 'list',
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
  if (list.after) query.set('after', list.after)
  else if (list.before) query.set('before', list.before)
  if (list.tab === 'precision') query.set('vue', 'precision')
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
  }
}

function hasFilters(list: FindingList): boolean {
  return Boolean(list.repoId || list.severity || list.ruleId || list.reason || list.search || list.author || list.days)
}

/**
 * The Findings screen (REV-18): every finding of the org, filtered by repository, status, priority,
 * rule and a search, a page of 50 at a time.
 */
/** « Précision sur 30 j : 78 % (n = 40) », or « n = 5 sur 10 » under the minimum, for the lead of the screen. */
export function precisionLead(report: PrecisionReport): string {
  let org = report.org
  let value = org.rate === null ? `n = ${org.closed} sur ${PRECISION_MIN}` : `${Math.round(org.rate * 100)} % (n = ${org.closed})`
  return `Chaque finding des reviews de Kentō, et ce qu’il est devenu. Précision sur ${PRECISION_DAYS} j : ${value}.`
}

export function FindingsPage(handle: Handle<FindingsPageProps>) {
  return () => {
    let { frame, page, facets, list, precision, githubUrl, now, notice } = handle.props
    let org = frame.viewer!.org.login
    // REV-18: an admin sets findings aside; a member reads.
    let admin = frame.viewer!.role === 'admin'
    let none = page.counts.all === 0 && !hasFilters(list)
    let tabs = (
      <nav class="tabs" aria-label="Vues des findings">
        <a href={findingsHref({ ...filtersOf(list), tab: 'list' })} aria-current={list.tab === 'list' ? 'page' : undefined}>
          Liste
        </a>
        {/* The filters ride along, unused by the precision: « Liste » gives them back. */}
        <a href={findingsHref({ ...filtersOf(list), tab: 'precision' })} aria-current={list.tab === 'precision' ? 'page' : undefined}>
          Précision
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
            <h2 id="empty-title">Aucun finding pour l’instant</h2>
            <p>
              Chaque finding d’une review publiée par Kentō s’affichera ici, avec son statut : open, fixed quand un push le corrige,
              dismissed ou wontfix quand quelqu’un l’écarte. <a href={routes.repos.href()}>Voir les repos</a>
            </p>
          </section>
        ) : (
          <>
            <FilterForm list={list} facets={facets} org={org} />
            {list.reason ? (
              <p class="findings-reason">
                Motif « {list.reason} » · <a href={findingsHref({ ...filtersOf(list), reason: null })}>Retirer ce filtre</a>
              </p>
            ) : null}
            {list.author || list.days ? (
              <p class="findings-reason">
                {list.author ? `PR de @${list.author}` : 'Toutes les PR'}
                {list.days ? ` · ${list.days} derniers jours` : ''} ·{' '}
                <a href={findingsHref({ ...filtersOf(list), author: null, days: null })}>Retirer ce filtre</a>
              </p>
            ) : null}
            <nav class="segmented-links findings-views" aria-label="Statut des findings">
              {FINDING_VIEWS.map((view) => (
                <a href={findingsHref({ ...filtersOf(list), view })} aria-current={view === list.view ? 'page' : undefined}>
                  {VIEW_LABELS[view]} <span class="list-filter-count">{page.counts[view].toLocaleString('fr-FR')}</span>
                </a>
              ))}
            </nav>
            {page.rows.length === 0 ? (
              <Empty page={page} list={list} />
            ) : (
              <div class="table-wrap findings-wrap">
                <table class="table findings-table">
                  <caption class="visually-hidden">
                    Findings {VIEW_LABELS[list.view]} de {org}, du plus récent au plus ancien
                  </caption>
                  <thead>
                    <tr>
                      {admin ? (
                        <th scope="col" class="finding-check">
                          {/* public/assets/findings.js shows it: without JavaScript, each row is checked by hand. */}
                          <input type="checkbox" id="findings-all" data-select-all hidden aria-label="Sélectionner tous les findings de la page" />
                        </th>
                      ) : null}
                      <th scope="col">Finding</th>
                      <th scope="col">Statut</th>
                      <th scope="col">Retrouvé</th>
                      <th scope="col">Pull request</th>
                      <th scope="col">Source</th>
                      <th scope="col" class="num">
                        Confiance
                      </th>
                      <th scope="col" class="num">
                        Depuis
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
      <form class="findings-filters" method="get" action={routes.findings.href()} role="search" aria-label="Filtrer les findings">
        {list.view !== 'open' ? <input type="hidden" name="status" value={list.view} /> : null}
        {list.reason ? <input type="hidden" name="reason" value={list.reason} /> : null}
        {list.author ? <input type="hidden" name="author" value={list.author} /> : null}
        {list.days ? <input type="hidden" name="days" value={String(list.days)} /> : null}
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
            Source
          </label>
          {/* With no rule, « Review et règles » is the only choice: the list says so and stays still. */}
          {/* A disabled select is not sent: a rule of the URL that the org no longer has stays in the list. */}
          {facets.rules.length === 0 && list.ruleId ? <input type="hidden" name="rule" value={list.ruleId} /> : null}
          <select class="input" id="findings-rule" name="rule" disabled={facets.rules.length === 0}>
            <option value="" selected={!list.ruleId}>
              Review et règles
            </option>
            {facets.rules.map((rule) => (
              <option value={rule.id} selected={rule.id === list.ruleId}>
                {rule.repo ? `${shortName(rule.repo, org)} · ${rule.title}` : `Org · ${rule.title}`}
              </option>
            ))}
          </select>
        </div>
        <div class="findings-filter-actions">
          {/* REV-91: with JavaScript a filter applies on change (findings.js); « Filtrer » serves a browser without it. */}
          <button class="button findings-submit" type="submit">
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
                aria-label={`Sélectionner « ${row.title} »`}
              />
            ) : null}
          </td>
        ) : null}
        <th scope="row">
          <span class="finding-cell">
            <span class={`pri pri-${row.severity}`} title={`Priorité ${priority.name}`}>
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
              </span>
            </span>
          </span>
        </th>
        <td data-label="Statut">
          <span class="stack">
            <span class={`status status-mono ${statusClass(row.status)}`}>{row.status}</span>
            {row.statusReason ? <span class="hint">{row.statusReason}</span> : null}
          </span>
        </td>
        <td data-label="Retrouvé">
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
              <span>Règle</span>
              <span class="hint">{row.ruleTitle}</span>
            </span>
          ) : (
            <span class="stack">
              <span>Review</span>
              <span class="hint">{(CATEGORY_LABELS[row.category] ?? row.category).toLowerCase()}</span>
            </span>
          )}
        </td>
        <td data-label="Confiance" class="num mono">
          {row.confidence} %
        </td>
        <td data-label="Depuis" class="num mono">
          <time datetime={row.createdAt.toISOString()}>{agoOrDate(row.createdAt, now)}</time>
        </td>
      </tr>
    )
  }
}

/** « 1 à 50 sur 1 234 findings », and the links to the pages around. Shown when the tab has more than a page. */
function Pager(handle: Handle<{ page: FindingScreenPage; list: FindingList }>) {
  return () => {
    let { page, list } = handle.props
    if (page.rows.length === 0 || (page.next === null && page.previous === null)) return null
    let from = page.offset + 1
    let to = page.offset + page.rows.length
    let filters = filtersOf(list)
    return (
      <nav class="pager findings-pager" aria-label="Pages de la liste">
        <p class="pager-range">
          {from.toLocaleString('fr-FR')} à {to.toLocaleString('fr-FR')} sur {page.matching.toLocaleString('fr-FR')} {plural(page.matching, 'finding')}
        </p>
        <span class="pager-links">
          {page.previous ? (
            <a class="button button-small" href={findingsHref({ ...filters, before: page.previous })} rel="prev">
              Précédents
            </a>
          ) : (
            <span class="button button-small" aria-disabled="true">
              Précédents
            </span>
          )}
          {page.next ? (
            <a class="button button-small" href={findingsHref({ ...filters, after: page.next })} rel="next">
              Suivants
            </a>
          ) : (
            <span class="button button-small" aria-disabled="true">
              Suivants
            </span>
          )}
        </span>
      </nav>
    )
  }
}

/**
 * REV-18. The actions on the findings checked in the table: « Marquer dismissed… » with the dialog of
 * the reason (shared with the screen of a pull request), and « Marquer wontfix ». Each finding
 * changed gets a reply in its thread on GitHub. REV-91: a bar that floats at the foot of the screen;
 * with JavaScript it shows once a finding is checked, with « Désélectionner ».
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
        <div class="findings-bulk" role="group" aria-label="Actions sur les findings cochés" data-bulk>
          <p class="findings-selected" data-selected aria-live="polite">
            Cochez des findings pour les marquer.
          </p>
          <DismissDialog id="bulk" form={BULK_FORM} trigger="Marquer dismissed…" submit="Marquer dismissed" />
          <button class="button" type="submit" form={BULK_FORM} name="status" value="wontfix">
            Marquer wontfix
          </button>
          <button class="button button-ghost findings-clear" type="button" data-select-none hidden>
            Désélectionner
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
            <strong>Rien n’a changé.</strong> {NOTICE_ERRORS[notice.error]}
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
            {changed} {plural(changed, 'finding marqué', 'findings marqués')} {status}.
          </strong>{' '}
          {replied > 0 ? `${replied} ${plural(replied, 'réponse postée', 'réponses postées')} dans les fils GitHub. ` : ''}
          {unreplied > 0
            ? `${unreplied} ${plural(unreplied, 'fil n’a pas reçu', 'fils n’ont pas reçu')} de réponse : GitHub a refusé ou n’a pas répondu ; le statut est enregistré quand même. `
            : ''}
          {unchanged > 0 ? `${unchanged} ${plural(unchanged, 'avait', 'avaient')} déjà ce statut et ce motif. ` : ''}
          {fixed > 0 ? `${fixed} ${plural(fixed, 'finding fixed est resté', 'findings fixed sont restés')} tel quel : un push l’a corrigé. ` : ''}
          {missing > 0
            ? `${missing} ${plural(missing, 'finding n’existe plus', 'findings n’existent plus')} dans cette organisation, par exemple parce que son repo a été retiré depuis l’affichage de la page. La liste ci-dessous est à jour. `
            : ''}
          {failed > 0 ? `${failed} ${plural(failed, 'finding n’a pas pu', 'findings n’ont pas pu')} être enregistré : réessayez.` : ''}
        </p>
      </div>
    )
  }
}
