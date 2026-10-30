import type { Handle } from 'remix/component'

import { authRoutes, pageRoutes } from '../routes.ts'
import { Document } from './document.tsx'
import { MarkGlyph } from './icons.tsx'
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
    title: 'Cette page n’existe pas',
    text: 'L’adresse est peut-être ancienne, ou ce qu’elle montrait a été retiré.',
  },
  repo: {
    title: 'Ce repo n’est plus dans l’installation',
    text: 'L’App Kentō ne le voit pas dans cette organisation : il a été retiré de l’installation sur GitHub, ou le lien est ancien. La liste des repos montre ceux que Kentō voit.',
  },
  form: {
    title: 'Ce formulaire n’a pas pu être lu',
    text: 'La page a peut-être changé depuis que vous l’avez ouverte. Rechargez-la, puis recommencez.',
  },
}

/** Where the link of the page leads. */
export interface ErrorExit {
  href: string
  label: string
}

const HOME: ErrorExit = { href: pageRoutes.home.href(), label: 'Retour au tableau de bord' }
const REPOS: ErrorExit = { href: pageRoutes.repos.href(), label: 'Voir les repos' }

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
            <div>
              <div class="signin-card">
                <span class="mark">
                  <MarkGlyph />
                  <span class="mark-name">Kentō</span>
                  <span class="mark-kanji" aria-hidden="true">
                    見当
                  </span>
                </span>
                <div>
                  <h1>{error.title}</h1>
                  <p>{error.text}</p>
                </div>
                <a class="button button-primary button-large" href={authRoutes.signIn.href()}>
                  Se connecter à Kentō
                </a>
              </div>
              <p class="signin-foot">Kentō {frame.version} · par Sakuga</p>
            </div>
          </main>
        </Document>
      )
    }
    let link = exit ?? (kind === 'repo' ? REPOS : HOME)
    return (
      <Shell frame={frame} section={section} title={error.title} lead={error.text}>
        <p>
          <a class="button button-primary" href={link.href}>
            {link.label}
          </a>
        </p>
      </Shell>
    )
  }
}
