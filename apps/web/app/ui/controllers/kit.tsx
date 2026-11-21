// REV-48. What every controller of the screens shares: the signed-in person, the frame of a page,
// the 404 or 400 page, the refusal of a form to a member, and the helpers of the forms.
import type { Handle } from 'remix/component'
import type { renderToString } from 'remix/component/server'
import { getCsrfToken } from 'remix/middleware/csrf'
import { createContextKey } from 'remix/router'

import { UUID } from '@kento-review/protocol'

import { canEdit } from '../../auth/access.ts'
import type { MembershipRow, UserRow } from '../../auth/store.ts'
import { createLiveRegistry, type LiveRegistry } from '../../dashboard/streams.ts'
import { log } from '../../log.ts'
import { pageRoutes } from '../../routes.ts'
import { ErrorPage, type ErrorExit, type ErrorKind } from '../not-found.tsx'
import { isRuleNotice, type RuleFormState, type RuleNotice } from '../rules.tsx'
import { Shell, type PageFrame, type Section, type Viewer } from '../shell.tsx'
import { readTheme } from '../theme.ts'
import type { UiDependencies } from './deps.ts'

export interface SignedIn {
  /** The session of Better Auth of the request. */
  sessionId: string
  user: UserRow
  membership: MembershipRow
  memberships: MembershipRow[]
  /** KNT-150. The pending invitations of the person, in any org. */
  invitations?: number
}

/** The signed-in person on the screen, set by `requireViewer`. */
export const Signed = createContextKey<SignedIn>()

/** KNT-150. A signed-in person, with an org (`signed`) or with only invitations to answer. */
export interface SignedPerson {
  sessionId: string
  user: UserRow
  signed: SignedIn | null
}

/** Set by `requireViewer` and `requirePerson`. */
export const Person = createContextKey<SignedPerson>()

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

/** The signed-in person of a request; `requireViewer` runs before every action that calls it. */
export function signedOf(context: { get(key: typeof Signed): SignedIn | undefined }): SignedIn {
  let signed = context.get(Signed)
  if (!signed) throw new Error('requireViewer did not run')
  return signed
}

export const SETTINGS_EXIT: ErrorExit = { href: pageRoutes.settings.href(), label: 'Back to the settings' }
export const REPOS_EXIT: ErrorExit = { href: pageRoutes.repos.href(), label: 'See the repos' }
export const RUNNERS_EXIT: ErrorExit = { href: pageRoutes.runners.href(), label: 'Back to the runners' }

export function forbidden() {
  return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

export function redirect(location: string) {
  return new Response(null, { status: 303, headers: { Location: location } })
}

/**
 * True for an owner or an admin of the org on screen. For a member, logs `event` (when given) with the reason,
 * and the caller answers `forbidden()`.
 */
export function isAdmin(signed: SignedIn, event?: string, fields: Record<string, unknown> = {}): boolean {
  if (canEdit(signed.membership.role)) return true
  if (event) log('warn', event, { login: signed.user.login, org: signed.membership.org.name, ...fields, reason: 'not an admin' })
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

/** The page of an installation of the App on GitHub, where an owner picks the repositories it sees. */
export function installationUrl(githubUrl: string, installation: { login: string; githubInstallationId: number }): string {
  return `${githubUrl}/organizations/${encodeURIComponent(installation.login)}/settings/installations/${installation.githubInstallationId}`
}

/** A path of this site, or `/`: never another origin (`//host`, `/\host`, a scheme). */
export function localPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  try {
    let url = new URL(value, 'http://kento.invalid')
    let path = `${url.pathname}${url.search}`
    // The parse can turn `/.//host` into `//host`, which a browser reads as another origin.
    return url.origin === 'http://kento.invalid' && !path.startsWith('//') ? path : '/'
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
  /**
   * KNT-189. The open streams of the live card, by session: the sign-out, the switch of org and the
   * end of a session end the streams of that session (app/dashboard/streams.ts).
   */
  streams: LiveRegistry
}

export function createKit(deps: UiDependencies): UiKit {
  let assetVersion = deps.commit ?? deps.version
  let auth = deps.auth
  let live = deps.dashboard?.live
  let kit: UiKit = {
    deps,
    streams: createLiveRegistry({ perSession: live?.perSession, total: live?.total }),
    assetVersion,
    now: auth?.now ?? Date.now,
    secure: auth?.publicUrl.protocol === 'https:',
    frame(signed, context, csrfToken) {
      let viewer: Viewer = {
        login: signed.user.login,
        name: signed.user.name,
        avatarUrl: signed.user.avatarUrl,
        role: signed.membership.role,
        canEdit: canEdit(signed.membership.role),
        org: { id: signed.membership.org.id, name: signed.membership.org.name },
        orgs: signed.memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role })),
        invitations: signed.invitations ?? 0,
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
    title: 'Dashboard',
    lead: 'What runs, what failed, and what it costs.',
    empty: 'The latest reviews, the job queue, the cost of the day and the runners will show here.',
  },
  repos: {
    title: 'Repos',
    lead: 'The repos of the installation, and where each one stands in its switch.',
    empty: 'The list of the repos, their mode and their switch counter will show here.',
  },
  findings: {
    title: 'Findings',
    lead: 'Each finding, and the precision of the reviews.',
    empty: 'The findings, with filters, and the precision by repo will show here.',
  },
  feedback: {
    title: 'Feedback',
    lead: 'What the authors of the pull requests say about the reviews of Kentō.',
    empty: 'The feedback on the reviews will show here.',
  },
  runners: {
    title: 'Runners',
    lead: 'The machines that do the reviews.',
    empty: 'The runners, their last signal and their jobs will show here.',
  },
  settings: {
    title: 'Settings',
    lead: 'What applies to the whole organization.',
    empty: 'The cost cap, the default values, the providers and the state of the App will show here.',
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
          <h2 id="empty-title">Soon here</h2>
          <p>{page.empty}</p>
        </section>
      </Shell>
    )
  }
}
