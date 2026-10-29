import type { Handle } from 'remix/component'

import { Document } from './document.tsx'
import { AlertIcon, ExternalIcon, GitHubIcon, MarkGlyph } from './icons.tsx'
import type { Theme } from './theme.ts'

/** Why the sign-in page is shown again. Each one has its sentence below. */
export type SignInNotice = 'not_member' | 'failed' | 'signed_out' | 'expired' | 'disabled' | 'unavailable'

const NOTICES: Record<SignInNotice, { tone: 'alert' | 'info'; title: string; text: string }> = {
  not_member: {
    tone: 'alert',
    title: 'Accès refusé.',
    text: 'Ce compte GitHub n’est membre d’aucune organisation où Kentō est installé. Changez de compte, demandez à un admin de l’organisation de vous inviter, ou installez Kentō sur votre organisation.',
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
  /** REV-32. The GitHub account that the refused sign-in read, from a signed cookie. */
  refusedLogin?: string | null
  /** The sign-in that asks GitHub to pick an account. */
  switchHref?: string | null
  /** The page of GitHub that installs the App on an org. Null when the service does not know it. */
  installHref?: string | null
}

/** « Se connecter à Kentō »: one button, GitHub. */
export function SignInPage(handle: Handle<SignInPageProps>) {
  return () => {
    let { theme, version, assetVersion, signInHref, notice, refusedLogin, switchHref, installHref } = handle.props
    let message = notice ? NOTICES[notice] : null
    // REV-32: after a refusal, the same button would sign in the same account again.
    let refused = notice === 'not_member' && signInHref !== null
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
                    <strong>{message.title}</strong>{' '}
                    {refused && refusedLogin ? (
                      <>
                        Connecté à GitHub en tant que <strong class="mono">@{refusedLogin}</strong>.{' '}
                      </>
                    ) : null}
                    {message.text}
                  </p>
                </div>
              ) : null}
              {refused ? (
                <div class="signin-actions">
                  <a class="button button-primary button-large" href={switchHref ?? signInHref!}>
                    <GitHubIcon />
                    Changer de compte GitHub
                  </a>
                  {installHref ? (
                    <a class="button button-large" href={installHref} rel="noreferrer" target="_blank">
                      Installer Kentō sur une organisation
                      <ExternalIcon />
                      <span class="visually-hidden">(GitHub, nouvel onglet)</span>
                    </a>
                  ) : null}
                  <p class="signin-note">
                    Un admin vous a invité ? <a href={signInHref!}>Réessayer avec {refusedLogin ? `@${refusedLogin}` : 'ce compte'}</a>.
                  </p>
                </div>
              ) : signInHref ? (
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
