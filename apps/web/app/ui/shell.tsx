import type { Handle, RemixNode } from 'remix/component'

import { feedbackRoutes, pageRoutes as routes, userRoutes } from '../routes.ts'
import { Button, Select } from './controls.tsx'
import { Document } from './document.tsx'
import { LockIcon, Logo, MenuIcon, SignOutIcon } from './icons.tsx'
import { THEME_LABELS, THEMES, type Theme } from './theme.ts'

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
export interface Viewer {
  login: string
  name: string | null
  avatarUrl: string | null
  /** An admin of the org edits; a member reads. */
  role: 'admin' | 'member'
  /** The org on screen. */
  org: { id: string; login: string }
  /** Every org where the person is a member; more than one shows a switch. */
  orgs: { id: string; login: string }[]
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
  /** The path of the page, where the theme form comes back to without JavaScript. */
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
  /** REV-17. What a member can do on this screen, in place of "only the admins … can change". */
  memberCan?: string
  children?: RemixNode
}

/**
 * The frame of every screen (REV-91): the bar with the mark, the screens, the org and the avatar;
 * under 760 px, "Menu" opens the list (public/assets/frame.js). Then the page header, the "Read
 * only" notice for a member, and the foot: "Kentō x.y.z · by Sakuga", the theme and the sign-out.
 */
export function Shell(handle: Handle<ShellProps>) {
  return () => {
    let { frame, section, title, before, lead, actions, tabs, children, memberCan } = handle.props
    let { viewer } = frame
    let readOnly = viewer?.role === 'member'
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
            {tabs ? <div class="page-tabs">{tabs}</div> : null}
            {actions && !readOnly ? <div class="page-actions">{actions}</div> : null}
          </div>
          {readOnly && viewer ? (
            <div class="banner banner-info" role="status">
              <LockIcon />
              <p>
                <strong class="banner-title">Read only</strong> You are a member of {viewer.org.login}. You can see everything
                {memberCan ? `, ${memberCan}` : ''}, and only the admins of the organization can change
                {memberCan ? ' the rest' : ' it'}.
              </p>
            </div>
          ) : null}
          {children}
        </main>

        <footer class="footer">
          <p>Kentō {frame.version} · by Sakuga</p>
          <div class="footer-settings">
            <ThemeSwitch frame={frame} />
            {viewer ? <Who frame={frame} viewer={viewer} /> : null}
          </div>
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

/** Paper / Sumi / Device. public/assets/theme.js applies a choice at once; without it, "Apply". */
export function ThemeSwitch(handle: Handle<{ frame: PageFrame }>) {
  return () => {
    let { frame } = handle.props
    return (
      <form method="post" action={routes.theme.href()} data-theme-switch="">
        {frame.csrfToken ? <input type="hidden" name="_csrf" value={frame.csrfToken} /> : null}
        <input type="hidden" name="returnTo" value={frame.path} />
        <fieldset class="theme-switch">
          <legend>Theme</legend>
          <div class="segmented">
            {THEMES.map((theme) => (
              <label>
                <input type="radio" name="theme" value={theme} checked={theme === frame.theme} />
                {THEME_LABELS[theme]}
              </label>
            ))}
          </div>
          <Button type="submit">
            Apply
          </Button>
        </fieldset>
      </form>
    )
  }
}

/** The org on screen; a select when the person is a member of several. frame.js sends a choice at once. */
function OrgSwitch(handle: Handle<{ frame: PageFrame; viewer: Viewer }>) {
  return () => {
    let { frame, viewer } = handle.props
    if (viewer.orgs.length < 2) {
      return (
        <span class="bar-org">
          <span class="visually-hidden">Organization: </span>
          <span class="bar-org-box">{viewer.org.login}</span>
        </span>
      )
    }
    return (
      <form class="bar-org" method="post" action={routes.org.href()} data-org-switch="">
        {frame.csrfToken ? <input type="hidden" name="_csrf" value={frame.csrfToken} /> : null}
        <input type="hidden" name="returnTo" value={frame.path} />
        <label class="visually-hidden" for="org-switch">
          Organization
        </label>
        <Select class="mono" wrapperClass="bar-org-select" id="org-switch" name="orgId">
          {viewer.orgs.map((org) => (
            <option value={org.id} selected={org.id === viewer.org.id}>
              {org.login}
            </option>
          ))}
        </Select>
        <Button type="submit">
          Switch
        </Button>
      </form>
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
        <span class="who-role">{viewer.role === 'admin' ? 'Admin' : 'Member'}</span>
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
