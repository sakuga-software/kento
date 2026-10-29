import type { Handle } from 'remix/component'

import { Document } from './document.tsx'
import { AlertIcon, GitHubIcon, MarkGlyph } from './icons.tsx'
import type { Theme } from './theme.ts'

/** Why the sign-in page is shown again. Each one has its sentence below. */
export type SignInNotice = 'not_member' | 'failed' | 'signed_out' | 'expired' | 'disabled' | 'unavailable'

const NOTICES: Record<SignInNotice, { tone: 'alert' | 'info'; title: string; text: string }> = {
  not_member: {
    tone: 'alert',
    title: 'Accès refusé.',
    text: 'Ce compte GitHub n’est membre d’aucune organisation où Kentō est installé. Demandez à un admin de l’organisation de vous inviter, puis réessayez.',
  },
  failed: {
    tone: 'alert',
    title: 'La connexion a échoué.',
    text: 'GitHub n’a pas confirmé la connexion. Réessayez ; si cela se reproduit, prévenez un admin.',
  },
  expired: {
    tone: 'info',
    title: 'Session terminée.',
    text: 'Votre session a expiré ou vos droits sur l’organisation ont changé. Reconnectez-vous.',
  },
  signed_out: {
    tone: 'info',
    title: 'Vous êtes déconnecté.',
    text: 'À bientôt.',
  },
  unavailable: {
    tone: 'alert',
    title: 'GitHub ne répond pas.',
    text: 'Kentō ne peut pas confirmer votre rôle dans l’organisation. Votre session est gardée : réessayez dans une minute.',
  },
  disabled: {
    tone: 'alert',
    title: 'Connexion indisponible.',
    text: 'La connexion GitHub n’est pas encore configurée sur ce serveur.',
  },
}

export interface SignInPageProps {
  theme: Theme
  version: string
  assetVersion: string
  /** The link that starts the GitHub sign-in. Null when the sign-in is not configured. */
  signInHref: string | null
  notice: SignInNotice | null
}

/** « Se connecter à Kentō »: one button, GitHub. */
export function SignInPage(handle: Handle<SignInPageProps>) {
  return () => {
    let { theme, version, assetVersion, signInHref, notice } = handle.props
    let message = notice ? NOTICES[notice] : null
    return (
      <Document title="Connexion" theme={theme} assetVersion={assetVersion}>
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
                <h1>Se connecter à Kentō</h1>
                <p>La review des pull requests de votre organisation.</p>
              </div>
              {message ? (
                <div class={`banner ${message.tone === 'alert' ? 'banner-alert' : 'banner-info'}`} role="alert">
                  <AlertIcon />
                  <p>
                    <strong>{message.title}</strong> {message.text}
                  </p>
                </div>
              ) : null}
              {signInHref ? (
                <a class="button button-primary button-large" href={signInHref}>
                  <GitHubIcon />
                  Continuer avec GitHub
                </a>
              ) : null}
              <p class="signin-note">
                Réservé aux membres des organisations où l’App Kentō est installée. Kentō lit votre identifiant GitHub
                et votre rôle dans l’organisation ; il n’écrit rien en votre nom.
              </p>
            </div>
            <p class="signin-foot">Kentō {version} · par Sakuga</p>
          </div>
        </main>
      </Document>
    )
  }
}
