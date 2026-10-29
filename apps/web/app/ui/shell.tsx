import type { Handle, RemixNode } from 'remix/component'

import { pageRoutes as routes } from '../routes.ts'
import { Document } from './document.tsx'
import {
  DashboardIcon,
  EyeIcon,
  SignOutIcon,
  FindingsIcon,
  MarkGlyph,
  ReposIcon,
  RunnersIcon,
  SettingsIcon,
} from './icons.tsx'
import { THEME_LABELS, THEMES, type Theme } from './theme.ts'

/** The screens of the navigation, in its order. */
export type Section = 'dashboard' | 'repos' | 'findings' | 'runners' | 'settings'

/**
 * `soon`: the screen is not there yet (REV-32). The sidebar names it, with « Bientôt » and no link;
 * the tab bar leaves it out. No link of the navigation leads to an empty screen.
 */
const NAV: { key: Section; label: string; href: string; Icon: typeof DashboardIcon; soon?: boolean }[] = [
  { key: 'dashboard', label: 'Tableau de bord', href: routes.home.href(), Icon: DashboardIcon },
  { key: 'repos', label: 'Repos', href: routes.repos.href(), Icon: ReposIcon },
  // REV-18 fills the Findings screen.
  { key: 'findings', label: 'Findings', href: routes.findings.href(), Icon: FindingsIcon, soon: true },
  { key: 'runners', label: 'Runners', href: routes.runners.href(), Icon: RunnersIcon },
  { key: 'settings', label: 'Réglages', href: routes.settings.href(), Icon: SettingsIcon },
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
  section: Section
  title: string
  lead?: string
  /** Buttons at the right of the title. A screen passes none to a member. */
  actions?: RemixNode
  children?: RemixNode
}

/**
 * The frame of every screen: sidebar on a wide screen; top bar and tab bar under 760 px; the page
 * header; the « Lecture seule » banner for a member; the footer « Kentō x.y.z · par Sakuga ».
 */
export function Shell(handle: Handle<ShellProps>) {
  return () => {
    let { frame, section, title, lead, actions, children } = handle.props
    let { viewer } = frame
    let readOnly = viewer?.role === 'member'
    return (
      <Document title={title} theme={frame.theme} assetVersion={frame.assetVersion}>
        <a class="skip-link" href="#content">
          Aller au contenu
        </a>
        <div class="shell">
          <aside class="sidebar" aria-label="Kentō">
            <Mark />
            {viewer ? <OrgCard frame={frame} viewer={viewer} /> : null}
            <nav class="nav" aria-label="Navigation principale">
              <ul>
                {NAV.map(({ key, label, href, Icon, soon }) => (
                  <li>
                    {soon && key !== section ? (
                      <span class="nav-soon">
                        <Icon />
                        {label}
                        <span class="tag tag-quiet">Bientôt</span>
                        {/* REV-32: a screen reader hears that it is no link yet. */}
                        <span class="visually-hidden"> : pas encore disponible</span>
                      </span>
                    ) : (
                      <a href={href} aria-current={key === section ? 'page' : undefined}>
                        <Icon />
                        {label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
            <div class="sidebar-foot">
              <ThemeSwitch frame={frame} />
              {viewer ? <Who frame={frame} viewer={viewer} /> : null}
            </div>
          </aside>

          <div class="main">
            <header class="topbar">
              <Mark />
              {viewer ? <span class="org-name">{viewer.org.login}</span> : null}
            </header>

            <main class="content" id="content" tabIndex={-1}>
              <div class="page-header">
                <div>
                  <h1 class="page-title">{title}</h1>
                  {lead ? <p class="page-lead">{lead}</p> : null}
                </div>
                {actions && !readOnly ? <div class="page-actions">{actions}</div> : null}
              </div>
              {readOnly && viewer ? (
                <div class="banner" role="status">
                  <EyeIcon />
                  <p>
                    <strong>Lecture seule.</strong> Vous êtes membre de {viewer.org.login} : vous voyez tout, et seuls
                    les admins de l’organisation modifient.
                  </p>
                </div>
              ) : null}
              {children}
            </main>

            <footer class="footer">
              <div class="footer-settings">
                <ThemeSwitch frame={frame} />
                {viewer ? <Who frame={frame} viewer={viewer} /> : null}
              </div>
              <p>Kentō {frame.version} · par Sakuga</p>
            </footer>
          </div>
        </div>

        <nav class="tabbar" aria-label="Navigation principale, mobile">
          <ul>
            {NAV.filter((item) => !item.soon || item.key === section).map(({ key, label, href, Icon }) => (
              <li>
                <a href={href} aria-current={key === section ? 'page' : undefined}>
                  <Icon />
                  {label === 'Tableau de bord' ? 'Accueil' : label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </Document>
    )
  }
}

function Mark(_handle: Handle<{}>) {
  return () => (
    <a class="mark" href={routes.home.href()} aria-label="Kentō, tableau de bord">
      <MarkGlyph />
      <span class="mark-name">Kentō</span>
      <span class="mark-kanji" aria-hidden="true">
        見当
      </span>
    </a>
  )
}

/** Papier / Sumi / Appareil. public/assets/theme.js applies a choice at once; without it, « Appliquer ». */
export function ThemeSwitch(handle: Handle<{ frame: PageFrame }>) {
  return () => {
    let { frame } = handle.props
    return (
      <form method="post" action={routes.theme.href()} data-theme-switch="">
        {frame.csrfToken ? <input type="hidden" name="_csrf" value={frame.csrfToken} /> : null}
        <input type="hidden" name="returnTo" value={frame.path} />
        <fieldset class="theme-switch">
          <legend>Thème</legend>
          <div class="segmented">
            {THEMES.map((theme) => (
              <label>
                <input type="radio" name="theme" value={theme} checked={theme === frame.theme} />
                {THEME_LABELS[theme]}
              </label>
            ))}
          </div>
          <button class="button" type="submit">
            Appliquer
          </button>
        </fieldset>
      </form>
    )
  }
}

/** The org on screen; a switch when the person is a member of several. */
function OrgCard(handle: Handle<{ frame: PageFrame; viewer: Viewer }>) {
  return () => {
    let { frame, viewer } = handle.props
    if (viewer.orgs.length < 2) {
      return (
        <div class="org">
          <span class="org-label">Organisation</span>
          <span class="org-name">{viewer.org.login}</span>
        </div>
      )
    }
    return (
      <form class="org" method="post" action={routes.org.href()}>
        {frame.csrfToken ? <input type="hidden" name="_csrf" value={frame.csrfToken} /> : null}
        <input type="hidden" name="returnTo" value={frame.path} />
        <label class="org-label" for="org-switch">
          Organisation
        </label>
        <select class="org-select" id="org-switch" name="orgId">
          {viewer.orgs.map((org) => (
            <option value={org.id} selected={org.id === viewer.org.id}>
              {org.login}
            </option>
          ))}
        </select>
        <button class="button" type="submit">
          Changer
        </button>
      </form>
    )
  }
}

function Who(handle: Handle<{ frame: PageFrame; viewer: Viewer }>) {
  return () => {
    let { frame, viewer } = handle.props
    return (
      <div class="who">
        {viewer.avatarUrl ? (
          <img class="avatar" src={viewer.avatarUrl} alt="" width={32} height={32} />
        ) : (
          <span class="avatar" aria-hidden="true"></span>
        )}
        <div class="who-text">
          <span class="who-login">{viewer.login}</span>
          <span class="who-role">{viewer.role === 'admin' ? 'Admin' : 'Membre'}</span>
        </div>
        <form method="post" action={routes.signOut.href()}>
          {frame.csrfToken ? <input type="hidden" name="_csrf" value={frame.csrfToken} /> : null}
          <button class="button button-ghost" type="submit" aria-label="Se déconnecter" title="Se déconnecter">
            <SignOutIcon />
          </button>
        </form>
      </div>
    )
  }
}
