import type { Handle } from 'remix/component'

import { REPO_FILTERS, SWITCH_TARGET, type RepoFilter, type RepoListQuery, type RepoPage, type RepoView } from '../repos/store.ts'
import { pageRoutes as routes, pullRoutes } from '../routes.ts'
import type { Precision } from '../findings/precision.ts'
import { Confirm } from './confirm.tsx'
import { findingsHref } from './findings.tsx'
import { PrecisionValue } from './precision.tsx'
import { agoOrDate, plural } from './format.ts'
import { AlertIcon, CheckIcon, ExternalIcon } from './icons.tsx'
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
  after: string | null
  before: string | null
}

const SEARCH_MAX = 100

const FILTER_LABELS: Record<RepoFilter, string> = {
  all: 'Tous',
  enabled: 'Activés',
  disabled: 'Non activés',
  switching: 'À basculer',
}

/** The list that a query of the screen asks for. A value that the screen does not know is ignored. */
export function readRepoList(query: URLSearchParams): RepoList {
  let filter = query.get('filter')
  return {
    filter: REPO_FILTERS.includes(filter as RepoFilter) ? (filter as RepoFilter) : 'all',
    search: (query.get('q') ?? '').trim().slice(0, SEARCH_MAX),
    after: query.get('after') || null,
    before: query.get('after') ? null : query.get('before') || null,
  }
}

/** The query of a list: what `readRepoList` reads back. Empty for the first page of all the repos. */
export function repoListQuery(list: Partial<RepoList>): URLSearchParams {
  let query = new URLSearchParams()
  if (list.filter && list.filter !== 'all') query.set('filter', list.filter)
  if (list.search) query.set('q', list.search)
  if (list.after) query.set('after', list.after)
  else if (list.before) query.set('before', list.before)
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
              Gérer l’installation sur GitHub
              <ExternalIcon />
              <span class="visually-hidden">(nouvel onglet)</span>
            </a>
            <form method="post" action={routes.reposCheck.href()}>
              {csrf}
              <button class="button" type="submit">
                Relire GitHub
              </button>
            </form>
          </>
        }
      >
        {notice ? <Notice notice={notice} org={org} /> : null}


        <p class="repos-summary" aria-live="polite">
          {all} {plural(all, 'repo')} dans l’installation · {enabled} {plural(enabled, 'activé')} ·{' '}
          {checking ? (
            // REV-26: public/assets/repos.js reads the screen again until the check is over.
            <span data-recheck="">
              vérification en cours sur GitHub · <a href={routes.repos.href()}>Recharger</a>
            </span>
          ) : checkedAt
              ? `relus sur GitHub ${agoOrDate(checkedAt, now)}`
              : 'pas encore vérifiés sur GitHub'}
        </p>

        {all === 0 ? (
          <section class="empty" aria-labelledby="empty-title">
            <h2 id="empty-title">Aucun repo pour l’instant</h2>
            <p>
              Kentō lit les repos de l’installation sur GitHub. Ils s’afficheront ici après la vérification ; « Gérer
              l’installation » choisit les repos que l’App voit.
            </p>
          </section>
        ) : (
          <>
            <ListControls page={page} list={list} />
            {repos.length === 0 ? (
              <section class="empty" aria-labelledby="empty-title">
                <h2 id="empty-title">Aucun repo ne correspond</h2>
                <p>
                  {list.search ? `Aucun nom ne contient « ${list.search} »` : 'Aucun repo'}
                  {list.filter !== 'all' ? ` dans « ${FILTER_LABELS[list.filter]} »` : ''}.{' '}
                  <a href={routes.repos.href()}>Afficher tous les repos</a>
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
                  <caption class="visually-hidden">Repos de l’installation {org}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Repo</th>
                      <th scope="col">Reviews par</th>
                      <th scope="col">Niveau</th>
                      <th scope="col">Modèle</th>
                      <th scope="col">Bascule</th>
                      <th scope="col">Dernière review</th>
                      <th scope="col">
                        Précision 30 j
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
            <Pager page={page} list={list} />
          </>
        )}

        {all > 0 ? (
          <p class="repos-legend">
            Reviews par :<span class="tag tag-ok">Kentō</span> l’App fait les reviews
            <span class="tag tag-warn">Kentō + review.yml</span> bascule en cours, deux reviews par push
            <span class="tag">review.yml</span> l’Action GitHub seule
            <span class="tag">aucune</span> installé, sans review
          </p>
        ) : null}
        {/* REV-91: the notes of the switch are asked for, not shown at all times. */}
        <details class="card repos-howto">
          <summary>Comment se passe la bascule de review.yml vers Kentō</summary>
            <div class="repos-notes">
            <section class="card note" aria-labelledby="criterion-title">
              <h2 id="criterion-title">Critère de bascule</h2>
              <ul>
                <li>
                  <strong>{SWITCH_TARGET} reviews publiées par Kentō</strong> d’affilée sur le repo, sans job en échec ni
                  double publication.
                </li>
                <li>Un job en échec remet le compteur à zéro ; une double publication aussi.</li>
                <li>
                  À {SWITCH_TARGET}/{SWITCH_TARGET}, « Retirer review.yml » ouvre la suppression du fichier sur GitHub. Le commit
                  qui le retire termine la bascule.
                </li>
              </ul>
            </section>
            <section class="card note" aria-labelledby="fallback-title">
              <h2 id="fallback-title">Repli pendant la transition</h2>
              <ul>
                <li>
                  Tant que review.yml reste dans le repo, l’Action relit aussi chaque push. La PR reçoit alors deux reviews, et celle de
                  l’Action sert de repli si Kentō échoue.
                </li>
                <li>
                  Une commande <code>@sakuga-review</code> reçoit alors deux réponses ; <code>@kento-review</code> ne s’adresse qu’à Kentō.
                </li>
                <li>Désactiver le repo rend la main à review.yml seul, au push suivant. Les reviews publiées restent.</li>
              </ul>
            </section>
          </div>
        </details>
        {checking ? <script src={`/assets/repos.js?v=${encodeURIComponent(frame.assetVersion)}`} defer></script> : null}
        {/* REV-91: the menus « … » of the rows close on Échap and on a click outside. */}
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
            <strong>GitHub n’a pas répondu.</strong> La liste reste celle de la dernière vérification ; réessayez dans une minute.
          </p>
        </div>
      )
    }
    let text =
      notice.kind === 'checked' ? (
        <p>
          <strong>Liste à jour.</strong> Les repos et leurs workflows viennent d’être relus sur GitHub.
        </p>
      ) : notice.kind === 'enabled' ? (
        <p>
          <strong>{shortName(notice.fullName, org)} est activé.</strong> Le prochain push d’une PR crée un job Kentō.
        </p>
      ) : (
        <p>
          <strong>{shortName(notice.fullName, org)} est désactivé.</strong> Aucun nouveau job ne part
          {notice.cancelled > 0
            ? ` (${notice.cancelled} ${notice.cancelled > 1 ? 'jobs en file annulés' : 'job en file annulé'})`
            : ''}
          ; les reviews publiées restent.
        </p>
      )
    return (
      <div class="banner banner-ok" role="status">
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
            {name}
          </a>
          <span class="hint">{repo.private === null ? 'visibilité inconnue' : repo.private ? 'privé' : 'public'}</span>
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
              <span class="visually-hidden"> : les findings clos de {name}</span>
            </a>
          ) : repo.enabled ? (
            '–'
          ) : (
            <span class="hint">Kentō non activé</span>
          )}
        </td>
        <td class="row-action">
          {admin && !repo.enabled ? (
            // REV-36: a secondary button. The primary style stays for the main action of a screen.
            <button class="button button-small" type="submit" form="repo-actions" formaction={routes.repoEnable.href({ id: repo.id }) + suffix}>
              Activer<span class="visually-hidden"> {name}</span>
            </button>
          ) : null}
          {/* REV-91: the other actions of a row sit in « … »: the config, the findings, and « Désactiver Kentō… ». */}
          <details class="row-menu">
            {/* No class: kento.css styles `.row-menu > summary` and `> div`, the page holds 50 of them (budget of 110 KB). */}
            <summary aria-label={`Actions de ${name}`}>…</summary>
            <div>
              <a href={routes.repoConfig.href({ id: repo.id })}>Ouvrir la config</a>
              <a href={findingsHref({ repoId: repo.id })}>Voir les findings</a>
              {admin && repo.enabled ? (
                <Confirm
                  trigger={
                    // One flex item: the gap of .button would split the visible « Désactiver… ».
                    <span>
                      Désactiver<span class="visually-hidden"> {name}</span> Kentō…
                    </span>
                  }
                  action={routes.repoDisable.href({ id: repo.id }) + suffix}
                  csrf={null}
                  form="repo-actions"
                  submit={`Désactiver ${name}`}
                >
                  <p>Aucun nouveau job ne part et les jobs en file sont annulés. Les reviews publiées et le compteur restent.</p>
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
            Rechercher un repo par son nom
          </label>
          <input
            class="input"
            id="repos-search"
            type="search"
            name="q"
            value={list.search}
            maxlength={SEARCH_MAX}
            placeholder="Nom du repo"
            autocomplete="off"
          />
          {list.filter !== 'all' ? <input type="hidden" name="filter" value={list.filter} /> : null}
          {/* Entrée sends the search; the button serves a screen reader and a browser without it. */}
          {/* Out of sight until the keyboard reaches it: then it shows, with its focus ring. */}
          <button class="button list-search-submit" type="submit">
            Rechercher
          </button>
        </form>
        <nav class="segmented-links" aria-label="Filtrer les repos">
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

/** « 51–100 sur 122 », and the links to the pages around. Shown when the list has more than a page. */
function Pager(handle: Handle<{ page: RepoPage; list: RepoList }>) {
  return () => {
    let { page, list } = handle.props
    if (page.rows.length === 0 || (page.next === null && page.previous === null)) return null
    let from = page.offset + 1
    let to = page.offset + page.rows.length
    return (
      <nav class="pager" aria-label="Pages de la liste">
        {page.previous ? (
          <a class="button button-small" href={reposHref({ filter: list.filter, search: list.search, before: page.previous })} rel="prev">
            Précédents
          </a>
        ) : (
          <span aria-hidden="true"></span>
        )}
        <p class="pager-range">
          {from} à {to} sur {page.matching}
        </p>
        {page.next ? (
          <a class="button button-small" href={reposHref({ filter: list.filter, search: list.search, after: page.next })} rel="next">
            Suivants
          </a>
        ) : (
          <span aria-hidden="true"></span>
        )}
      </nav>
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
        <span class="hint">copie de review.yml</span>
      ) : repo.workflow === null ? (
        <span class="hint">pas encore vérifié</span>
      ) : null
    if (repo.enabled) {
      return (
        <span class="stack">
          <span class={`tag ${workflowLeft ? 'tag-warn' : 'tag-ok'}`}>{workflowLeft ? 'Kentō + review.yml' : 'Kentō'}</span>
          {workflowLeft ? detail : null}
        </span>
      )
    }
    return (
      <span class="stack">
        <span class="tag">{workflowLeft ? 'review.yml' : 'aucune'}</span>
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
        ? 'remis à zéro après un échec'
        : !done && repo.resetBy === 'double'
          ? 'remis à zéro après une double publication'
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
                sur{' '}
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
            Retirer review.yml
            <span class="visually-hidden"> de {repo.fullName} (GitHub, nouvel onglet)</span>
          </a>
        ) : done && workflowLeft ? (
          <span class="hint">prêt à retirer review.yml</span>
        ) : done ? (
          <span class="hint hint-ok">basculé</span>
        ) : null}
      </span>
    )
  }
}
