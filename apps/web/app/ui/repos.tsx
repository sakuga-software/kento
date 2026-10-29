import type { Handle } from 'remix/component'

import { SWITCH_TARGET, type RepoView } from '../repos/store.ts'
import { pageRoutes as routes } from '../routes.ts'
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
  repos: RepoView[]
  /** The page of the installation of the App on GitHub. */
  installationUrl: string
  /** `https://github.com`, or the GitHub Enterprise Server. */
  githubUrl: string
  /** A check of GitHub runs in the background: the rows can change at the next load. */
  checking: boolean
  notice: ReposNotice | null
  /** The repository that the admin is about to disable: the screen asks to confirm. */
  confirm: RepoView | null
  /** For the dates of the screen. */
  now: Date
}

const LEVELS: Record<RepoView['defaultLevel'], string> = { lite: 'lite', balanced: 'balanced', heavy: 'heavy' }

const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })

/** « il y a 4 min », « il y a 2 h », or a date. */
export function ago(date: Date, now: Date): string {
  let minutes = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60_000))
  if (minutes < 1) return 'à l’instant'
  if (minutes < 60) return `il y a ${minutes} min`
  let hours = Math.round(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  return `le ${DATE.format(date)}`
}

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
    let { frame, repos, installationUrl, githubUrl, checking, notice, confirm, now } = handle.props
    let viewer = frame.viewer!
    let admin = viewer.role === 'admin'
    let org = viewer.org.login
    let enabled = repos.filter((repo) => repo.enabled).length
    let checkedAt = repos.reduce<Date | null>(
      (oldest, repo) => (repo.workflowCheckedAt && (!oldest || repo.workflowCheckedAt < oldest) ? repo.workflowCheckedAt : oldest),
      null,
    )
    let csrf = frame.csrfToken ? <input type="hidden" name="_csrf" value={frame.csrfToken} /> : null

    return (
      <Shell
        frame={frame}
        section="repos"
        title="Repos"
        lead="Les repos de l’installation, et où en est chacun dans sa bascule."
        actions={
          <>
            <form method="post" action={routes.reposCheck.href()}>
              {csrf}
              <button class="button" type="submit">
                Actualiser
              </button>
            </form>
            <a class="button" href={installationUrl} rel="noreferrer" target="_blank">
              Gérer l’installation
              <ExternalIcon />
              <span class="visually-hidden">(GitHub, nouvel onglet)</span>
            </a>
          </>
        }
      >
        {notice ? <Notice notice={notice} org={org} /> : null}

        {confirm && admin ? (
          <section class="banner banner-alert banner-confirm" aria-labelledby="confirm-title">
            <AlertIcon />
            <div class="banner-confirm-body">
              <h2 id="confirm-title" class="banner-confirm-title">
                Désactiver {shortName(confirm.fullName, org)} ?
              </h2>
              <p>
                Aucun nouveau job ne part : le prochain push ne crée rien, et les jobs en file sont annulés. Les reviews
                déjà publiées restent sur GitHub, et le compteur de bascule garde sa valeur.
              </p>
              <div class="banner-confirm-actions">
                <form method="post" action={routes.repoDisable.href({ id: confirm.id })}>
                  {csrf}
                  <button class="button button-primary" type="submit">
                    Désactiver {shortName(confirm.fullName, org)}
                  </button>
                </form>
                <a class="button" href={`${routes.repos.href()}#repo-${confirm.id}`}>
                  Annuler
                </a>
              </div>
            </div>
          </section>
        ) : null}

        <p class="repos-summary" aria-live="polite">
          {repos.length} {repos.length > 1 ? 'repos' : 'repo'} · {enabled} {enabled > 1 ? 'activés' : 'activé'} ·{' '}
          {checking
            ? 'vérification en cours sur GitHub, rechargez dans un instant'
            : checkedAt
              ? `vérifiés sur GitHub ${ago(checkedAt, now)}`
              : 'pas encore vérifiés sur GitHub'}
        </p>

        {repos.length === 0 ? (
          <section class="empty" aria-labelledby="empty-title">
            <h2 id="empty-title">Aucun repo pour l’instant</h2>
            <p>
              Kentō lit les repos de l’installation sur GitHub. Ils s’afficheront ici après la vérification ; « Gérer
              l’installation » choisit les repos que l’App voit.
            </p>
          </section>
        ) : (
          <div class="table-wrap">
            <table class="table repos-table">
              <caption class="visually-hidden">Repos de l’installation {org}</caption>
              <thead>
                <tr>
                  <th scope="col">Repo</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Niveau</th>
                  <th scope="col">Provider · modèle</th>
                  <th scope="col">Bascule</th>
                  <th scope="col">Dernière review</th>
                  <th scope="col">Précision</th>
                  {admin ? (
                    <th scope="col">
                      <span class="visually-hidden">Action</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {repos.map((repo) => (
                  <RepoRow repo={repo} org={org} admin={admin} githubUrl={githubUrl} csrfToken={frame.csrfToken} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        )}

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
                À {SWITCH_TARGET}/{SWITCH_TARGET}, « Retirer review.yml » ouvre la suppression du fichier sur GitHub : le commit
                qui le retire termine la bascule.
              </li>
            </ul>
          </section>
          <section class="card note" aria-labelledby="fallback-title">
            <h2 id="fallback-title">Repli pendant la transition</h2>
            <ul>
              <li>
                Tant que review.yml reste dans le repo, l’Action relit aussi chaque push : la PR reçoit deux reviews, et celle de
                l’Action sert de repli si Kentō échoue.
              </li>
              <li>
                Une commande <code>@sakuga-review</code> reçoit alors deux réponses ; <code>@kento-ai</code> ne s’adresse qu’à Kentō.
              </li>
              <li>Désactiver le repo rend la main à review.yml seul, au push suivant. Les reviews publiées restent.</li>
            </ul>
          </section>
        </div>
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
  csrfToken: string | null
  now: Date
}

function RepoRow(handle: Handle<RepoRowProps>) {
  return () => {
    let { repo, org, admin, githubUrl, csrfToken, now } = handle.props
    let name = shortName(repo.fullName, org)
    let repoUrl = `${githubUrl}/${repo.fullName}`
    return (
      <tr id={`repo-${repo.id}`}>
        <th scope="row" data-label="Repo">
          <a class="repo-name" href={repoUrl} rel="noreferrer">
            {name}
          </a>
          <span class="tag tag-quiet">{repo.private === null ? 'visibilité inconnue' : repo.private ? 'privé' : 'public'}</span>
        </th>
        <td data-label="Mode">
          <Mode repo={repo} />
        </td>
        <td data-label="Niveau">
          <span class="stack">
            <span class="mono">{LEVELS[repo.defaultLevel]}</span>
            <a href={routes.repoConfig.href({ id: repo.id })}>
              Config<span class="visually-hidden"> de {name}</span>
            </a>
          </span>
        </td>
        <td data-label="Provider · modèle">{repo.lastReview ? <ProviderModel model={repo.lastReview.model} /> : '–'}</td>
        <td data-label="Bascule">
          <Switch repo={repo} admin={admin} githubUrl={githubUrl} />
        </td>
        <td data-label="Dernière review">
          {repo.lastReview ? (
            <span class="stack">
              <a href={`${repoUrl}/pull/${repo.lastReview.prNumber}`} rel="noreferrer">
                #{repo.lastReview.prNumber} · {repo.lastReview.score}/5
              </a>
              <span class="hint">{ago(repo.lastReview.publishedAt, now)}</span>
            </span>
          ) : (
            '–'
          )}
        </td>
        <td data-label="Précision">
          <span aria-hidden="true">–</span>
          <span class="visually-hidden">pas encore mesurée</span>
        </td>
        {admin ? (
          <td data-label="Action" class="row-action">
            {repo.enabled ? (
              <a class="button" href={`${routes.repos.href()}?confirm=${repo.id}#confirm-title`}>
                Désactiver<span class="visually-hidden"> {name}</span>
              </a>
            ) : (
              <form method="post" action={routes.repoEnable.href({ id: repo.id })}>
                {csrfToken ? <input type="hidden" name="_csrf" value={csrfToken} /> : null}
                <button class="button button-primary" type="submit">
                  Activer<span class="visually-hidden"> {name}</span>
                </button>
              </form>
            )}
          </td>
        ) : null}
      </tr>
    )
  }
}

/** The model of the last review, `anthropic/claude-haiku-5.5`: the model, then its provider. */
function ProviderModel(handle: Handle<{ model: string }>) {
  return () => {
    let { model } = handle.props
    let slash = model.indexOf('/')
    if (slash <= 0) return <span class="mono">{model}</span>
    return (
      <span class="stack">
        <span class="mono">{model.slice(slash + 1)}</span>
        <span class="hint">{model.slice(0, slash)}</span>
      </span>
    )
  }
}

function Mode(handle: Handle<{ repo: RepoView }>) {
  return () => {
    let { repo } = handle.props
    let workflowLeft = repo.workflow === 'reusable' || repo.workflow === 'copy'
    if (repo.enabled) {
      return (
        <span class="stack">
          <span class="tag tag-ok">App Kentō</span>
          {workflowLeft ? <span class="hint">review.yml encore là</span> : null}
        </span>
      )
    }
    if (repo.workflow === 'reusable') return <span class="tag tag-info mono">review.yml@{repo.workflowRef}</span>
    if (repo.workflow === 'copy') return <span class="tag tag-info">copie de review.yml</span>
    return (
      <span class="stack">
        <span class="tag tag-quiet">installée sans job</span>
        {repo.workflow === null ? <span class="hint">pas encore vérifié</span> : null}
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
        {reset ? <span class="hint hint-alert">{reset}</span> : null}
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
