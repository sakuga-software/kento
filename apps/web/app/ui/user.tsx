// REV-22. The screen of a user (« alex · Kentō »): the preferences of the reviews of their own pull
// requests, the findings that those pull requests received, and the pull requests that Kentō
// reviewed. Every member of the org reads it; only the user changes it.
import type { Handle } from 'remix/component'

import { LEVELS, type Level } from '@sakuga-review/protocol'

import { userRoutes } from '../routes.ts'
import { PULLS_STEP, RECEIVED_DAYS, type ReviewedPull, type UserPref, type UserScreen } from '../users/store.ts'
import { VERDICT_LABEL } from './dashboard.tsx'
import { findingsHref } from './findings.tsx'
import { agoOrDate, plural } from './format.ts'
import { pullHref } from './pull.tsx'
import { Shell, ThemeSwitch, type PageFrame } from './shell.tsx'

/** What the screen says after a form, from `?fait=`. */
export const USER_NOTICES = {
  saved: 'Préférences enregistrées. Elles comptent dès le prochain push de vos PR.',
  added: 'Repo ajouté à vos préférences.',
  removed: 'Repo retiré : vos préférences de tous les repos s’y appliquent de nouveau.',
  missing: 'Ce repo n’est pas un repo activé de l’organisation : rien n’est enregistré.',
} as const
export type UserNotice = keyof typeof USER_NOTICES

export interface UserPageProps {
  frame: PageFrame
  screen: UserScreen
  /** The signed-in person is the user of the screen: the forms show. */
  self: boolean
  /** The pull requests on screen: `?prs=`. */
  pulls: number
  notice: UserNotice | null
  now: Date
}

const LEVEL_TEXT = (level: Level | null) => (level === null ? 'celui du repo' : level)
const AUTO_TEXT = (auto: boolean) => (auto ? 'activée' : 'désactivée')

/** `/users/:login`, with the number of pull requests on screen when it is more than the first step. */
export function userHref(login: string, pulls?: number): string {
  let path = userRoutes.user.href({ login })
  return pulls && pulls > PULLS_STEP ? `${path}?prs=${pulls}` : path
}

export function UserPage(handle: Handle<UserPageProps>) {
  return () => {
    let { frame, screen, self, pulls, notice, now } = handle.props
    let { user } = screen
    let org = frame.viewer!.org.login
    let role = screen.role === 'admin' ? 'Admin' : 'Membre'
    return (
      <Shell
        frame={frame}
        title={user.login}
        lead={`${user.name ? `${user.name} · ` : ''}${role} de ${org}, d’après ses droits sur GitHub.`}
        memberCan={self ? 'vous réglez les reviews de vos propres PR' : undefined}
      >
        {notice ? (
          <div class={`banner ${notice === 'missing' ? 'banner-info' : 'banner-ok'}`} role="status">
            <p>{USER_NOTICES[notice]}</p>
          </div>
        ) : null}
        <PrefsSection screen={screen} self={self} csrf={frame.csrfToken ?? ''} />
        {self ? (
          <section class="card user-section" aria-labelledby="user-theme-title">
            <h2 id="user-theme-title" class="section-title">
              Affichage
            </h2>
            <ThemeSwitch frame={frame} />
          </section>
        ) : null}
        <ReceivedSection screen={screen} self={self} />
        <PullsSection screen={screen} self={self} pulls={pulls} now={now} />
      </Shell>
    )
  }
}

function PrefFields(handle: Handle<{ id: string; pref: UserPref | null }>) {
  return () => {
    let { id, pref } = handle.props
    let auto = pref?.autoReview ?? true
    let level = pref?.level ?? null
    return (
      <>
        <div class="field">
          <label class="field-label" for={`${id}-auto`}>
            Review automatique
          </label>
          <select class="input" id={`${id}-auto`} name="auto">
            <option value="on" selected={auto}>
              Activée : chaque push de mes PR
            </option>
            <option value="off" selected={!auto}>
              Désactivée : seulement sur commande
            </option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for={`${id}-level`}>
            Niveau par défaut
          </label>
          <select class="input" id={`${id}-level`} name="level">
            <option value="" selected={level === null}>
              Celui du repo
            </option>
            {LEVELS.map((l) => (
              <option value={l} selected={level === l}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </>
    )
  }
}

function PrefsSection(handle: Handle<{ screen: UserScreen; self: boolean; csrf: string }>) {
  return () => {
    let { screen, self, csrf } = handle.props
    let { prefs, user } = screen
    let action = userRoutes.userPrefs.href({ login: user.login })
    let global = prefs.global
    return (
      <section class="card user-section" aria-labelledby="user-prefs-title">
        <h2 id="user-prefs-title" class="section-title">
          Reviews de {self ? 'mes' : 'ses'} PR
        </h2>
        <p class="hint">
          Une règle d’assignation du repo passe avant ces préférences, et elles passent avant le niveau par défaut du repo. Review automatique
          désactivée : aucun job sur {self ? 'vos' : 'ses'} PR, sauf une commande <code>@kento-review</code>.
        </p>
        <h3 class="dash-subtitle">Tous les repos</h3>
        {self ? (
          <form class="user-pref-form" method="post" action={action}>
            <input type="hidden" name="_csrf" value={csrf} />
            <input type="hidden" name="repo" value="" />
            <PrefFields id="pref-all" pref={global} />
            <button class="button button-primary" type="submit">
              Enregistrer
            </button>
          </form>
        ) : (
          <p>
            Review automatique {AUTO_TEXT(global?.autoReview ?? true)} · niveau {LEVEL_TEXT(global?.level ?? null)}
            {global ? '' : ' (rien de réglé)'}.
          </p>
        )}

        <h3 class="dash-subtitle">Par repo</h3>
        {prefs.repos.length === 0 ? (
          <p class="hint">Aucun repo réglé à part : les préférences de tous les repos s’appliquent partout.</p>
        ) : (
          <div class="table-wrap">
            <table class="table user-prefs-table">
              <caption class="visually-hidden">Préférences par repo</caption>
              <thead>
                <tr>
                  <th scope="col">Repo</th>
                  <th scope="col">Review automatique</th>
                  <th scope="col">Niveau</th>
                  {self ? (
                    <th scope="col">
                      <span class="visually-hidden">Action</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {prefs.repos.map((pref) => (
                  <tr>
                    <th scope="row" class="mono">
                      {pref.fullName}
                    </th>
                    <td>{AUTO_TEXT(pref.autoReview)}</td>
                    <td>{LEVEL_TEXT(pref.level)}</td>
                    {self ? (
                      <td>
                        <form method="post" action={userRoutes.userPrefRemove.href({ login: user.login, repoId: pref.repoId })}>
                          <input type="hidden" name="_csrf" value={csrf} />
                          <button class="button button-small" type="submit">
                            Retirer<span class="visually-hidden"> {pref.fullName}</span>
                          </button>
                        </form>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {self && screen.addable.length > 0 ? (
          <form class="user-pref-form" method="post" action={action}>
            <input type="hidden" name="_csrf" value={csrf} />
            <div class="field">
              <label class="field-label" for="pref-repo">
                Repo
              </label>
              <select class="input" id="pref-repo" name="repo">
                {screen.addable.map((repo) => (
                  <option value={repo.id}>{repo.fullName}</option>
                ))}
              </select>
            </div>
            <PrefFields id="pref-new" pref={null} />
            <button class="button" type="submit">
              Ajouter un repo
            </button>
          </form>
        ) : null}
      </section>
    )
  }
}

const RECEIVED: { key: 'open' | 'fixed' | 'dismissed' | 'wontfix' | 'stale'; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'fixed', label: 'Fixed' },
  { key: 'dismissed', label: 'Dismissed' },
  { key: 'wontfix', label: 'Wontfix' },
  { key: 'stale', label: 'Stale' },
]

function ReceivedSection(handle: Handle<{ screen: UserScreen; self: boolean }>) {
  return () => {
    let { screen, self } = handle.props
    let { received, user } = screen
    let open = received.open
    return (
      <section class="dash-section user-section" aria-labelledby="user-received-title">
        <h2 id="user-received-title" class="section-title">
          Findings reçus · {RECEIVED_DAYS} jours
        </h2>
        <dl class="dash-tiles user-received">
          {RECEIVED.map(({ key, label }) => (
            <div class="dash-tile">
              <dt class="dash-tile-label">{label}</dt>
              <dd class="dash-tile-value">{received[key]}</dd>
            </div>
          ))}
        </dl>
        <p>
          <a href={findingsHref({ view: 'open', author: user.login, days: RECEIVED_DAYS })}>
            Voir {self ? 'mes' : 'ses'} {open} {plural(open, 'finding')} open
          </a>
        </p>
      </section>
    )
  }
}

function PullRow(handle: Handle<{ pull: ReviewedPull; now: Date }>) {
  return () => {
    let { pull, now } = handle.props
    let verdict = pull.verdict ? VERDICT_LABEL[pull.verdict] : undefined
    let parts = RECEIVED.filter(({ key }) => pull.findings[key] > 0)
    return (
      <tr>
        <th scope="row">
          <a class="mono" href={pullHref(pull.repoId, pull.prNumber)}>
            {pull.repo}#{pull.prNumber}
          </a>
        </th>
        <td>
          <span class={`tag ${pull.state === 'open' ? 'tag-ok' : 'tag-quiet'}`}>{pull.state === 'open' ? 'Ouverte' : 'Fermée'}</span>
        </td>
        <td>{pull.reviews}</td>
        <td>{parts.length === 0 ? 'aucun' : parts.map(({ key, label }) => `${pull.findings[key]} ${label.toLowerCase()}`).join(' · ')}</td>
        <td>
          {verdict ? <span class={`tag ${verdict.tag}`}>{verdict.text}</span> : '—'}
          {pull.score !== null ? ` · ${pull.score}/5` : ''}
        </td>
        <td>
          <time dateTime={pull.lastReviewAt.toISOString()}>{agoOrDate(pull.lastReviewAt, now)}</time>
        </td>
      </tr>
    )
  }
}

function PullsSection(handle: Handle<{ screen: UserScreen; self: boolean; pulls: number; now: Date }>) {
  return () => {
    let { screen, self, pulls, now } = handle.props
    let { rows, total } = screen.pulls
    let more = Math.min(PULLS_STEP, total - rows.length)
    return (
      <section class="dash-section user-section" aria-labelledby="user-pulls-title">
        <h2 id="user-pulls-title" class="section-title">
          {self ? 'Mes' : 'Ses'} PR reviewées <span class="count">{total}</span>
        </h2>
        {rows.length === 0 ? (
          <p class="hint">Aucune PR reviewée par Kentō pour l’instant.</p>
        ) : (
          <div class="table-wrap">
            <table class="table user-pulls-table">
              <caption class="visually-hidden">PR de {screen.user.login} reviewées par Kentō, la dernière review d’abord</caption>
              <thead>
                <tr>
                  <th scope="col">PR</th>
                  <th scope="col">État</th>
                  <th scope="col">Reviews</th>
                  <th scope="col">Findings</th>
                  <th scope="col">Dernier verdict</th>
                  <th scope="col">Date</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((pull) => (
                  <PullRow pull={pull} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more > 0 ? (
          <p>
            <a href={userHref(screen.user.login, pulls + PULLS_STEP)}>
              Afficher {more} PR de plus
            </a>
          </p>
        ) : null}
      </section>
    )
  }
}
