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
  saved: 'Preferences saved. They apply from the next push of your PRs.',
  added: 'Repo added to your preferences.',
  removed: 'Repo removed. Your preferences for all repos apply to it again.',
  missing: 'This repo is not an enabled repo of the organization. Nothing is saved.',
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

const LEVEL_TEXT = (level: Level | null) => (level === null ? 'from the repo' : level)
const AUTO_TEXT = (auto: boolean) => (auto ? 'on' : 'off')

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
    let role = screen.role === 'admin' ? 'Admin' : 'Member'
    return (
      <Shell
        frame={frame}
        title={user.login}
        lead={`${user.name ? `${user.name} · ` : ''}${role} of ${org}, from their rights on GitHub.`}
        memberCan={self ? 'you set the reviews of your own PRs' : undefined}
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
              Display
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
            Automatic review
          </label>
          <select class="input" id={`${id}-auto`} name="auto">
            <option value="on" selected={auto}>
              On: each push of my PRs
            </option>
            <option value="off" selected={!auto}>
              Off: only on a command
            </option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for={`${id}-level`}>
            Default level
          </label>
          <select class="input" id={`${id}-level`} name="level">
            <option value="" selected={level === null}>
              From the repo
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
          Reviews of {self ? 'my' : 'their'} PRs
        </h2>
        <p class="hint">
          An assignment rule of the repo comes before these preferences, and they come before the default level of the repo. With the
          automatic review off, {self ? 'your' : 'their'} PRs get no job, except with a <code>@kento-review</code> command.
        </p>
        <h3 class="dash-subtitle">All repos</h3>
        {self ? (
          <form class="user-pref-form" method="post" action={action}>
            <input type="hidden" name="_csrf" value={csrf} />
            <input type="hidden" name="repo" value="" />
            <PrefFields id="pref-all" pref={global} />
            <button class="button button-primary" type="submit">
              Save
            </button>
          </form>
        ) : (
          <p>
            Automatic review {AUTO_TEXT(global?.autoReview ?? true)} · level {LEVEL_TEXT(global?.level ?? null)}
            {global ? '' : ' (nothing set)'}.
          </p>
        )}

        <h3 class="dash-subtitle">Per repo</h3>
        {prefs.repos.length === 0 ? (
          <p class="hint">No repo has its own preferences. The preferences for all repos apply everywhere.</p>
        ) : (
          <div class="table-wrap">
            <table class="table user-prefs-table">
              <caption class="visually-hidden">Preferences per repo</caption>
              <thead>
                <tr>
                  <th scope="col">Repo</th>
                  <th scope="col">Automatic review</th>
                  <th scope="col">Level</th>
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
                            Remove<span class="visually-hidden"> {pref.fullName}</span>
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
              Add a repo
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
          Findings received · {RECEIVED_DAYS} days
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
            See {self ? 'my' : 'their'} {open} open {plural(open, 'finding')}
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
          <span class={`tag ${pull.state === 'open' ? 'tag-ok' : 'tag-quiet'}`}>{pull.state === 'open' ? 'Open' : 'Closed'}</span>
        </td>
        <td>{pull.reviews}</td>
        <td>{parts.length === 0 ? 'none' : parts.map(({ key, label }) => `${pull.findings[key]} ${label.toLowerCase()}`).join(' · ')}</td>
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
          {self ? 'My' : 'Their'} reviewed PRs <span class="count">{total}</span>
        </h2>
        {rows.length === 0 ? (
          <p class="hint">Kentō has reviewed no PR yet.</p>
        ) : (
          <div class="table-wrap">
            <table class="table user-pulls-table">
              <caption class="visually-hidden">PRs of {screen.user.login} that Kentō reviewed, the last review first</caption>
              <thead>
                <tr>
                  <th scope="col">PR</th>
                  <th scope="col">State</th>
                  <th scope="col">Reviews</th>
                  <th scope="col">Findings</th>
                  <th scope="col">Last verdict</th>
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
              Show {more} more {plural(more, 'PR')}
            </a>
          </p>
        ) : null}
      </section>
    )
  }
}
