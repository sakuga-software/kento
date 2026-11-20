import type { Handle } from 'remix/component'

import { authRoutes, pageRoutes } from '../routes.ts'
import { buttonClass } from './controls.tsx'
import { Document } from './document.tsx'
import { Logo } from './icons.tsx'
import { Shell, type PageFrame, type Section } from './shell.tsx'

/**
 * REV-40. Why a screen answers 404 or 400:
 * - `page`: no screen at this address;
 * - `repo`: the repository is not in the installation of the org on screen (or never was);
 * - `form`: a form that the server cannot read (a field is missing or unknown).
 */
export type ErrorKind = 'page' | 'repo' | 'form'

const ERRORS: Record<ErrorKind, { title: string; text: string }> = {
  page: {
    title: 'This page does not exist',
    text: 'The address can be old, or what it showed was removed.',
  },
  repo: {
    title: 'This repo is no longer in the installation',
    text: 'The Kentō App does not see it in this organization. It was removed from the installation on GitHub, or the link is old. The list of repos shows the ones that Kentō sees.',
  },
  form: {
    title: 'Kentō could not read this form',
    text: 'The page can have changed since you opened it. Reload it, then try again.',
  },
}

/** Where the link of the page leads. */
export interface ErrorExit {
  href: string
  label: string
}

const HOME: ErrorExit = { href: pageRoutes.home.href(), label: 'Back to the dashboard' }
const REPOS: ErrorExit = { href: pageRoutes.repos.href(), label: 'See the repos' }

export interface ErrorPageProps {
  /** `viewer: null`: nobody is signed in; the page then offers the sign-in. */
  frame: PageFrame
  kind: ErrorKind
  /** The screen of the navigation that the page belongs to. None: no item is current. */
  section?: Section
  /** The link out. Default: Repos for `repo`, the dashboard otherwise. */
  exit?: ErrorExit
}

/** A 404 or a 400 of a screen, in the frame of Kentō, with a link out. The status stays as it is. */
export function ErrorPage(handle: Handle<ErrorPageProps>) {
  return () => {
    let { frame, kind, section, exit } = handle.props
    let error = ERRORS[kind]
    if (!frame.viewer) {
      return (
        <Document title={error.title} theme={frame.theme} assetVersion={frame.assetVersion}>
          <main class="signin">
            <div class="signin-wrap signin-wrap-narrow">
              <div class="signin-card">
                <div class="signin-main">
                  <span class="mark">
                    <Logo />
                  </span>
                  <div>
                    <h1>{error.title}</h1>
                    <p class="signin-lead">{error.text}</p>
                  </div>
                  <a class={buttonClass('primary', 'lg')} href={authRoutes.signIn.href()}>
                    Sign in to Kentō
                  </a>
                </div>
              </div>
              <p class="signin-foot">Kentō {frame.version} · by Sakuga</p>
            </div>
          </main>
        </Document>
      )
    }
    let link = exit ?? (kind === 'repo' ? REPOS : HOME)
    return (
      <Shell frame={frame} section={section} title={error.title} lead={error.text}>
        <p>
          <a class={buttonClass('primary')} href={link.href}>
            {link.label}
          </a>
        </p>
      </Shell>
    )
  }
}
