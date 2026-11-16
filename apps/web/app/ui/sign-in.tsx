import type { Handle } from 'remix/component'

import { Document } from './document.tsx'
import { AlertIcon, ExternalIcon, GitHubIcon, Logo } from './icons.tsx'
import type { Theme } from './theme.ts'

/** Why the sign-in page is shown again. Each one has its sentence below. */
export type SignInNotice = 'not_member' | 'failed' | 'signed_out' | 'expired' | 'disabled' | 'unavailable'

const NOTICES: Record<SignInNotice, { tone: 'alert' | 'info'; title: string; text: string }> = {
  not_member: {
    tone: 'alert',
    title: 'Access refused.',
    text: 'This GitHub account is not a member of an organization where Kentō is installed. Switch accounts, ask an admin of the organization to invite you, or install Kentō on your organization.',
  },
  failed: {
    tone: 'alert',
    title: 'The sign-in failed.',
    text: 'GitHub did not confirm the sign-in. Try again. If it happens again, tell an admin.',
  },
  expired: {
    tone: 'info',
    title: 'Session ended.',
    text: 'Your session expired, or your rights on the organization changed. Sign in again.',
  },
  signed_out: {
    tone: 'info',
    title: 'You are signed out.',
    text: 'See you soon.',
  },
  unavailable: {
    tone: 'alert',
    title: 'GitHub does not answer.',
    text: 'Kentō cannot confirm your role in the organization. Kentō keeps your session. Try again in a minute.',
  },
  disabled: {
    tone: 'alert',
    title: 'Sign-in unavailable.',
    text: 'The GitHub sign-in is not configured on this server yet.',
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

/** « Sign in to Kentō »: one button, GitHub. */
export function SignInPage(handle: Handle<SignInPageProps>) {
  return () => {
    let { theme, version, assetVersion, signInHref, notice, refusedLogin, switchHref, installHref } = handle.props
    let message = notice ? NOTICES[notice] : null
    // REV-32: after a refusal, the same button would sign in the same account again.
    let refused = notice === 'not_member' && signInHref !== null
    return (
      <Document title="Sign in" theme={theme} assetVersion={assetVersion}>
        <main class="signin">
          <div class="signin-wrap">
            <div class="signin-card">
              <div class="signin-main">
                <span class="mark">
                  <Logo />
                </span>
                <div>
                  <h1>Sign in to Kentō</h1>
                  <p class="signin-lead">
                    The review of the pull requests of your organization. Kentō follows each finding from one push to the
                    next, with the cost of each review and the precision of each repo.
                  </p>
                </div>
                {message ? (
                  <div class={`banner ${message.tone === 'alert' ? 'banner-alert' : 'banner-info'}`} role="alert">
                    <AlertIcon />
                    <p>
                      <strong>{message.title}</strong>{' '}
                      {refused && refusedLogin ? (
                        <>
                          Signed in to GitHub as <strong class="mono">@{refusedLogin}</strong>.{' '}
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
                      Switch GitHub account
                    </a>
                    {installHref ? (
                      <a class="button button-large" href={installHref} rel="noreferrer" target="_blank">
                        Install Kentō on an organization
                        <ExternalIcon />
                        <span class="visually-hidden">(GitHub, new tab)</span>
                      </a>
                    ) : null}
                    <p class="signin-note">
                      An admin invited you? <a href={signInHref!}>Try again with {refusedLogin ? `@${refusedLogin}` : 'this account'}</a>.
                    </p>
                  </div>
                ) : signInHref ? (
                  <a class="button button-primary button-large" href={signInHref}>
                    <GitHubIcon />
                    Continue with GitHub
                  </a>
                ) : null}
                <p class="signin-note">
                  For the members of the organizations where the Kentō App is installed. Kentō reads your GitHub login
                  and your role in the organization. It writes nothing in your name.
                </p>
              </div>
              {/* REV-91: the facts of the design, without a price: none is known before the sign-in. */}
              <dl class="signin-facts">
                <div>
                  <dt>Precision of a repo</dt>
                  <dd class="mono">fixed ÷ (fixed + dismissed) · n shown</dd>
                </div>
                <div>
                  <dt>Where the reviews run</dt>
                  <dd class="mono">your runners, with your key, or the runner of the service</dd>
                </div>
              </dl>
            </div>
            <p class="signin-foot">Kentō {version} · by Sakuga</p>
          </div>
        </main>
      </Document>
    )
  }
}
