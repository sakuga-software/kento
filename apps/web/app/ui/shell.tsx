import type { Handle, RemixNode } from 'remix/component'

import { feedbackRoutes, pageRoutes as routes, userRoutes } from '../routes.ts'
import { Button } from './controls.tsx'
import { Document } from './document.tsx'
import { LockIcon, Logo, MenuIcon, SignOutIcon } from './icons.tsx'
import type { Theme } from './theme.ts'
import type { OrgRole } from '../db/schema.ts'

/** The screens of the navigation, in its order. */
export type Section = 'dashboard' | 'repos' | 'findings' | 'feedback' | 'runners' | 'settings'

/**
 * `soon`: the screen is not there yet (REV-32). The bar names it, with "Soon" and no link. No link
 * of the navigation leads to an empty screen.
 */
const NAV: { key: Section; label: string; href: string; soon?: boolean }[] = [
  { key: 'dashboard', label: 'Dashboard', href: routes.home.href() },
  { key: 'repos', label: 'Repos', href: routes.repos.href() },
  { key: 'findings', label: 'Findings', href: routes.findings.href() },
  { key: 'feedback', label: 'Feedback', href: feedbackRoutes.feedback.href() },
  { key: 'runners', label: 'Runners', href: routes.runners.href() },
  { key: 'settings', label: 'Settings', href: routes.settings.href() },
]

/** The person who is signed in, and their role in the org on screen. */
/** KNT-150. What the screens call each role. */
export const ROLE_LABELS: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

export interface Viewer {
  login: string
  name: string | null
  avatarUrl: string | null
  /** An admin of the org edits; a member reads. */
  role: OrgRole
  /** An owner or an admin: the forms of the org. */
  canEdit: boolean
  /** The org on screen. */
  org: { id: string; name: string }
  /** Every org where the person is a member, with their role in it: the menu of the org. */
  orgs: { id: string; name: string; role: OrgRole }[]
}

/** What every screen gives to the frame. */
export interface PageFrame {
  theme: Theme
  version: string
  assetVersion: string
  /** Null while nobody is signed in. */
  viewer: Viewer | null
  /** The CSRF token of the session, for the forms of the frame. Null without a session. */
  csrfToken: string | null
  /** The path of the page, where the forms of the frame come back to without JavaScript. */
  path: string
}

export interface ShellProps {
  frame: PageFrame
  /** The current item of the navigation. None: a page outside of it (REV-40, a 404). */
  section?: Section
  title: string
  /** REV-91. Above the title: the crumbs of a screen that has a parent. */
  before?: RemixNode
  lead?: string
  /** Buttons at the right of the title. A screen passes none to a member. */
  actions?: RemixNode
  /** REV-91. The tabs of a screen at the right of its title, for every person ("List", "Precision"). */
  tabs?: RemixNode
  /** KNT-141. A short line at the right of the title, on its baseline, for every person ("Updated 8 s ago · Refresh"). */
  meta?: RemixNode
  /** REV-17. What a member can do on this screen, in place of "only the admins … can change". */
  memberCan?: string
  children?: RemixNode
}

/**
 * The frame of every screen (REV-91): the bar with the mark, the screens, the org and the avatar;
 * under 760 px, "Menu" opens the list (public/assets/frame.js). Then the page header, the "Read
 * only" notice for a member, and the foot: "Kentō x.y.z · by Sakuga" and the sign-out. The theme is
 * on the screen of the user (KNT-142).
 */
export function Shell(handle: Handle<ShellProps>) {
  return () => {
    let { frame, section, title, before, lead, actions, tabs, meta, children, memberCan } = handle.props
    let { viewer } = frame
    let readOnly = viewer !== null && !viewer.canEdit
    return (
      <Document title={title} theme={frame.theme} assetVersion={frame.assetVersion}>
        <a class="skip-link" href="#content">
          Skip to content
        </a>
        <header class="bar" data-bar="">
          <div class="bar-in">
            <Mark />
            <nav class="bar-nav" aria-label="Main navigation">
              <button class="bar-menu" type="button" aria-expanded="false" aria-controls="bar-links" data-bar-menu="">
                <MenuIcon />
                Menu
              </button>
              <ul id="bar-links">
                {NAV.map(({ key, label, href, soon }) => (
                  <li>
                    {soon && key !== section ? (
                      <span class="bar-link">
                        {label}
                        <span class="tag tag-quiet">Soon</span>
                        {/* REV-32: a screen reader hears that it is no link yet. */}
                        <span class="visually-hidden">, not available yet</span>
                      </span>
                    ) : (
                      <a class="bar-link" href={href} aria-current={key === section ? 'page' : undefined}>
                        {label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
            {viewer ? (
              <div class="bar-end">
                <OrgSwitch frame={frame} viewer={viewer} />
                <Avatar viewer={viewer} current={frame.path === userRoutes.user.href({ login: viewer.login })} />
              </div>
            ) : null}
          </div>
        </header>

        <main class="content" id="content" tabIndex={-1}>
          {before}
          <div class="page-header">
            <div>
              <h1 class="page-title">{title}</h1>
              {lead ? <p class="page-lead">{lead}</p> : null}
            </div>
            {meta ? <div class="page-meta">{meta}</div> : null}
            {tabs ? <div class="page-tabs">{tabs}</div> : null}
            {actions && !readOnly ? <div class="page-actions">{actions}</div> : null}
          </div>
          {readOnly && viewer ? (
            <div class="banner banner-info" role="status">
              <LockIcon />
              <p>
                <strong class="banner-title">Read only</strong> You are a member of {viewer.org.name}. You can see everything
                {memberCan ? `, ${memberCan}` : ''}, and only the admins of the organization can change
                {memberCan ? ' the rest' : ' it'}.
              </p>
            </div>
          ) : null}
          {children}
        </main>

        <footer class="footer">
          <p>Kentō {frame.version} · by Sakuga</p>
          {viewer ? <Who frame={frame} viewer={viewer} /> : null}
        </footer>
      </Document>
    )
  }
}

function Mark(_handle: Handle<{}>) {
  return () => (
    <a class="mark" href={routes.home.href()} aria-label="Kentō, dashboard">
      <Logo />
    </a>
  )
}

/**
 * KNT-150. The org on screen, and a menu of every org of the person with their role in it: a form
 * per org (no JavaScript needed), then the settings of the org.
 */
function OrgSwitch(handle: Handle<{ frame: PageFrame; viewer: Viewer }>) {
  return () => {
    let { frame, viewer } = handle.props
    return (
      <details class="bar-org org-menu">
        <summary class="bar-org-box">
          <span class="visually-hidden">Organization: </span>
          <span class="org-menu-name">{viewer.org.name}</span>
        </summary>
        <div class="org-menu-panel">
          <p class="org-menu-title">Organizations</p>
          <ul>
            {viewer.orgs.map((org) =>
              org.id === viewer.org.id ? (
                <li>
                  <span class="org-menu-item" aria-current="true">
                    <span class="org-menu-item-name">{org.name}</span>
                    <span class="tag tag-quiet">{ROLE_LABELS[org.role]}</span>
                  </span>
                </li>
              ) : (
                <li>
                  <form method="post" action={routes.org.href()}>
                    {frame.csrfToken ? <input type="hidden" name="_csrf" value={frame.csrfToken} /> : null}
                    <input type="hidden" name="returnTo" value={frame.path} />
                    <input type="hidden" name="orgId" value={org.id} />
                    <button class="org-menu-item" type="submit">
                      <span class="org-menu-item-name">{org.name}</span>
                      <span class="tag tag-quiet">{ROLE_LABELS[org.role]}</span>
                    </button>
                  </form>
                </li>
              ),
            )}
          </ul>
          <a class="org-menu-link" href={routes.settings.href()}>
            Organization settings
          </a>
        </div>
      </details>
    )
  }
}

/**
 * Two letters: the initials of the name, else the first two of the login. Array.from splits by code
 * point, so a character outside the BMP stays whole.
 */
export function initials(viewer: Pick<Viewer, 'login' | 'name'>): string {
  let words = (viewer.name ?? '').trim().split(/\s+/).filter(Boolean).map((word) => Array.from(word))
  let first = words[0]
  let last = words[words.length - 1]
  let letters = words.length >= 2 ? [first![0]!, last![0]!] : (first ?? Array.from(viewer.login)).slice(0, 2)
  return letters.join('').toUpperCase()
}

/** REV-22: the avatar leads to the screen of the person, with their preferences. */
function Avatar(handle: Handle<{ viewer: Viewer; current: boolean }>) {
  return () => {
    let { viewer, current } = handle.props
    return (
      <a
        class="bar-avatar"
        href={userRoutes.user.href({ login: viewer.login })}
        aria-current={current ? 'page' : undefined}
        title={viewer.login}
      >
        <span aria-hidden="true">{initials(viewer)}</span>
        <span class="visually-hidden">{viewer.login}, your preferences</span>
      </a>
    )
  }
}

/** The login, the role and the sign-out, in the foot. */
function Who(handle: Handle<{ frame: PageFrame; viewer: Viewer }>) {
  return () => {
    let { frame, viewer } = handle.props
    return (
      <div class="who">
        <span class="who-login">{viewer.login}</span>
        <span class="who-role">{ROLE_LABELS[viewer.role]}</span>
        <form method="post" action={routes.signOut.href()}>
          {frame.csrfToken ? <input type="hidden" name="_csrf" value={frame.csrfToken} /> : null}
          <Button variant="ghost" type="submit">
            <SignOutIcon />
            Sign out
          </Button>
        </form>
      </div>
    )
  }
}
