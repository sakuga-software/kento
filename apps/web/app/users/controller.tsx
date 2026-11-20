// REV-22. The controller of the screen of a user, on the frame of the screens (`ScreenKit` of
// app/ui/pages.tsx): the session, the signed-in person, the 404 page.
import { isLevel, UUID } from '@kento-review/protocol'
import { createController } from 'remix/router'

import { log } from '../log.ts'
import { userRoutes } from '../routes.ts'
import type { ScreenKit } from '../ui/pages.tsx'
import { userHref, UserPage, USER_NOTICES, type UserNotice } from '../ui/user.tsx'
import { PULLS_MAX, PULLS_STEP, type UserPref, type UsersStore } from './store.ts'

/** The screen of a user. Null: it answers 404. */
export interface UsersDependencies {
  store: UsersStore
  now?: () => number
}

const EXIT = { href: '/', label: 'Back to the dashboard' }

/** The fields of a preference form, or null for a form that the server cannot read. */
export function readPrefForm(form: FormData | undefined): { repoId: string | null; pref: UserPref } | null {
  let repo = String(form?.get('repo') ?? '')
  let auto = String(form?.get('auto') ?? '')
  let level = String(form?.get('level') ?? '')
  if (repo !== '' && !UUID.test(repo)) return null
  if (auto !== 'on' && auto !== 'off') return null
  if (level !== '' && !isLevel(level)) return null
  return { repoId: repo === '' ? null : repo, pref: { autoReview: auto === 'on', level: level === '' ? null : level } }
}

/** `?prs=`: a multiple of the step, between the first step and the most that one page shows. */
function pullsOf(value: string | null): number {
  let n = value !== null && /^\d{1,4}$/.test(value) ? Number(value) : PULLS_STEP
  return Math.min(PULLS_MAX, Math.max(PULLS_STEP, Math.ceil(n / PULLS_STEP) * PULLS_STEP))
}

export function createUserControllers(kit: ScreenKit, deps: UsersDependencies | null) {
  let now = deps?.now ?? Date.now
  let isSelf = (signedLogin: string, login: string) => signedLogin.toLowerCase() === login.toLowerCase()

  return createController(userRoutes, {
    middleware: kit.middleware,
    actions: {
      async user(context) {
        let signed = kit.signed(context)
        let pulls = pullsOf(context.url.searchParams.get('prs'))
        let screen = deps ? await deps.store.screen(signed.orgId, context.params.login, pulls) : null
        if (!deps || !screen) return kit.errorPage(context, 404, 'page', undefined, EXIT)
        let done = context.url.searchParams.get('done')
        return context.render(
          <UserPage
            frame={kit.frame(context)}
            screen={screen}
            self={isSelf(signed.login, screen.user.login)}
            pulls={pulls}
            notice={done !== null && done in USER_NOTICES ? (done as UserNotice) : null}
            now={new Date(now())}
          />,
        )
      },

      async userPrefs(context) {
        let signed = kit.signed(context)
        if (!isSelf(signed.login, context.params.login)) return kit.forbidden()
        let user = deps ? await deps.store.member(signed.orgId, signed.login) : null
        if (!deps || !user) return kit.errorPage(context, 404, 'page', undefined, EXIT)
        let read = readPrefForm(context.get(FormData))
        if (!read) return kit.errorPage(context, 400, 'form')
        let change = await deps.store.savePref(signed.orgId, user.id, read.repoId, read.pref)
        log('info', 'user.prefs_saved', {
          login: signed.login,
          org: signed.orgLogin,
          repoId: read.repoId,
          autoReview: read.pref.autoReview,
          level: read.pref.level,
          outcome: change.outcome,
        })
        let notice: UserNotice = change.outcome === 'not_found' ? 'missing' : read.repoId === null ? 'saved' : 'added'
        return kit.redirect(`${userHref(user.login)}?done=${notice}`)
      },

      async userPrefRemove(context) {
        let signed = kit.signed(context)
        if (!isSelf(signed.login, context.params.login)) return kit.forbidden()
        let user = deps ? await deps.store.member(signed.orgId, signed.login) : null
        if (!deps || !user || !UUID.test(context.params.repoId)) return kit.errorPage(context, 404, 'page', undefined, EXIT)
        await deps.store.removePref(user.id, context.params.repoId)
        log('info', 'user.prefs_removed', { login: signed.login, org: signed.orgLogin, repoId: context.params.repoId })
        return kit.redirect(`${userHref(user.login)}?done=removed`)
      },
    },
  })
}
