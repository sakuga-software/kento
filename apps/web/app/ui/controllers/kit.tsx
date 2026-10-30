// REV-48. What every controller of the screens shares: the signed-in person, the frame of a page,
// the 404 or 400 page, the refusal of a form to a member, and the helpers of the forms.
import type { Handle } from 'remix/component'
import type { renderToString } from 'remix/component/server'
import { getCsrfToken } from 'remix/middleware/csrf'
import { createContextKey } from 'remix/router'
import { Session } from 'remix/session'

import { UUID } from '@sakuga-review/protocol'

import type { MembershipRow, UserRow } from '../../auth/store.ts'
import { log } from '../../log.ts'
import { pageRoutes } from '../../routes.ts'
import { ErrorPage, type ErrorExit, type ErrorKind } from '../not-found.tsx'
import { isRuleNotice, type RuleFormState, type RuleNotice } from '../rules.tsx'
import { Shell, type PageFrame, type Section, type Viewer } from '../shell.tsx'
import { readTheme } from '../theme.ts'
import type { UiDependencies } from './deps.ts'

export interface SignedIn {
  user: UserRow
  membership: MembershipRow
  memberships: MembershipRow[]
}

/** The signed-in person on the screen, set by `requireViewer`. */
export const Signed = createContextKey<SignedIn>()

/** What `context.render` takes: a node of `remix/component`. */
export type PageNode = Parameters<typeof renderToString>[0]

/** The context of a screen, as the helpers of this file read it. */
export type ScreenContext = Parameters<typeof getCsrfToken>[0] & {
  get(key: typeof Signed): SignedIn | undefined
  headers: Headers
  url: URL
  render(node: PageNode, init?: ResponseInit): Response
}

/** The context of a form of a screen. */
export type FormContext = ScreenContext & { get(key: typeof FormData): FormData | undefined }

/** The session of a request; the session middleware runs before every action that calls it. */
export function sessionOf(context: { get(key: typeof Session): Session | undefined }): Session {
  let session = context.get(Session)
  if (!session) throw new Error('the session middleware did not run')
  return session
}

/** The signed-in person of a request; `requireViewer` runs before every action that calls it. */
export function signedOf(context: { get(key: typeof Signed): SignedIn | undefined }): SignedIn {
  let signed = context.get(Signed)
  if (!signed) throw new Error('requireViewer did not run')
  return signed
}

export const SETTINGS_EXIT: ErrorExit = { href: pageRoutes.settings.href(), label: 'Revenir aux réglages' }
export const REPOS_EXIT: ErrorExit = { href: pageRoutes.repos.href(), label: 'Voir les repos' }
export const RUNNERS_EXIT: ErrorExit = { href: pageRoutes.runners.href(), label: 'Revenir aux runners' }

export function forbidden() {
  return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

export function redirect(location: string) {
  return new Response(null, { status: 303, headers: { Location: location } })
}

/**
 * True for an admin of the org on screen. For a member, logs `event` (when given) with the reason,
 * and the caller answers `forbidden()`.
 */
export function isAdmin(signed: SignedIn, event?: string, fields: Record<string, unknown> = {}): boolean {
  if (signed.membership.role === 'admin') return true
  if (event) log('warn', event, { login: signed.user.login, org: signed.membership.org.login, ...fields, reason: 'not an admin' })
  return false
}

/** The version of a versioned form (the field `version`), or null when it is not a number. */
export function readVersion(form: FormData | undefined): number | null {
  let text = form?.get('version')
  return typeof text === 'string' && /^\d{1,9}$/.test(text) ? Number(text) : null
}

/** The form values of a change, as the person typed them, to show again with their errors. */
export function formValues(form: FormData | undefined): Record<string, string> {
  let values: Record<string, string> = {}
  for (let [key, value] of form?.entries() ?? []) if (typeof value === 'string' && key !== '_csrf') values[key] = value
  return values
}

/** REV-19. What a page shows of the rules after a form: the notice, or the form with its errors. */
export type RulesExtra = { form: RuleFormState | null; notice: RuleNotice | null; noticeRule: string | null }

/** The notice of the rules from the query of a page: `?rules=added&rule=<id>`. */
export function rulesNotice(query: URLSearchParams): RulesExtra {
  let notice = query.get('rules')
  let rule = query.get('rule')
  return { form: null, notice: isRuleNotice(notice) ? notice : null, noticeRule: rule && UUID.test(rule) ? rule : null }
}

/** The page of the installation of the App on GitHub, where an owner picks the repositories it sees. */
export function installationUrl(githubUrl: string, org: { login: string; githubInstallationId: number }): string {
  return `${githubUrl}/organizations/${encodeURIComponent(org.login)}/settings/installations/${org.githubInstallationId}`
}

/** A path of this site, or `/`: never another origin (`//host`, `/\host`, a scheme). */
export function localPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  try {
    let url = new URL(value, 'http://kento.invalid')
    return url.origin === 'http://kento.invalid' ? `${url.pathname}${url.search}` : '/'
  } catch {
    return '/'
  }
}

/** The dependencies of the screens, and the frame that each screen draws around its page. */
export interface UiKit {
  deps: UiDependencies
  /** The commit of the image, or the version: it versions the URLs of the assets. */
  assetVersion: string
  now: () => number
  /** The service answers over HTTPS: the cookies are `Secure` and `__Host-`. */
  secure: boolean
  frame(signed: SignedIn, context: { headers: Headers; url: URL }, csrfToken: string): PageFrame
  /** The frame of the page of a request, for the signed-in person. */
  page(context: ScreenContext): PageFrame
  /** REV-40. A 404 or a 400 of a screen, in the frame, with a link out. */
  errorPage(context: ScreenContext, status: 400 | 404, kind: ErrorKind, section?: Section, exit?: ErrorExit): Response
}

export function createKit(deps: UiDependencies): UiKit {
  let assetVersion = deps.commit ?? deps.version
  let auth = deps.auth
  let kit: UiKit = {
    deps,
    assetVersion,
    now: auth?.now ?? Date.now,
    secure: auth?.publicUrl.protocol === 'https:',
    frame(signed, context, csrfToken) {
      let viewer: Viewer = {
        login: signed.user.login,
        name: signed.user.name,
        avatarUrl: signed.user.avatarUrl,
        role: signed.membership.role,
        org: { id: signed.membership.org.id, login: signed.membership.org.login },
        orgs: signed.memberships.map((m) => ({ id: m.org.id, login: m.org.login })),
      }
      return {
        theme: readTheme(context.headers.get('Cookie')),
        version: deps.version,
        assetVersion,
        viewer,
        csrfToken,
        path: `${context.url.pathname}${context.url.search}`,
      }
    },
    page(context) {
      return kit.frame(signedOf(context), context, getCsrfToken(context))
    },
    errorPage(context, status, kind, section, exit) {
      return context.render(<ErrorPage frame={kit.page(context)} kind={kind} section={section} exit={exit} />, { status })
    },
  }
  return kit
}

/**
 * The screens of milestone M3. Each one is a frame with an empty state until its own ticket fills
 * it: REV-14 the dashboard, REV-9 the repos, REV-18 the findings, REV-10 the runners, REV-13 the
 * settings of the org.
 */
const PLACEHOLDERS: Record<Section, { title: string; lead: string; empty: string }> = {
  dashboard: {
    title: 'Tableau de bord',
    lead: 'Ce qui tourne, ce qui a échoué, et ce que ça coûte.',
    empty: 'Les dernières reviews, la file de jobs, le coût du jour et les runners s’afficheront ici.',
  },
  repos: {
    title: 'Repos',
    lead: 'Les repos de l’installation, et où en est chacun dans sa bascule.',
    empty: 'La liste des repos, leur mode et leur compteur de bascule s’afficheront ici.',
  },
  findings: {
    title: 'Findings',
    lead: 'Chaque finding, et la précision des reviews.',
    empty: 'Les findings filtrables et la précision par repo s’afficheront ici.',
  },
  runners: {
    title: 'Runners',
    lead: 'Les machines qui font les reviews.',
    empty: 'Les runners, leur dernier signal et leurs jobs s’afficheront ici.',
  },
  settings: {
    title: 'Réglages',
    lead: 'Ce qui vaut pour toute l’organisation.',
    empty: 'Le plafond de coût, les valeurs par défaut, les providers et l’état de l’App s’afficheront ici.',
  },
}

/** The frame of a screen whose dependencies the server did not give, with its empty state. */
export function PlaceholderPage(handle: Handle<{ frame: PageFrame; section: Section }>) {
  return () => {
    let { frame, section } = handle.props
    let page = PLACEHOLDERS[section]
    return (
      <Shell frame={frame} section={section} title={page.title} lead={page.lead}>
        <section class="empty" aria-labelledby="empty-title">
          <h2 id="empty-title">Bientôt ici</h2>
          <p>{page.empty}</p>
        </section>
      </Shell>
    )
  }
}
