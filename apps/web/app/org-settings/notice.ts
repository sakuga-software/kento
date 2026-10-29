import type { StoreCommand } from '../db/webhook-store.ts'
import type { MintInstallationToken, TokenPermissions } from '../github/installation-token.ts'
import { log } from '../log.ts'
import { createGitHub } from '../publish/github.ts'
import type { CapHit } from './model.ts'

/** The name of the check run that tells a pull request that the limit of its org stopped its review. */
export const CAP_CHECK_NAME = 'Kentō · plafond'

const CHECK_PERMISSIONS: TokenPermissions = { checks: 'write' }

const USD = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const DAY = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' })
const TIME = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })

export function formatUsd(value: number): string {
  return USD.format(value)
}

/** « le 30 oct. à 01:00 (heure de Paris) ». */
export function resetWhen(date: Date): string {
  return `le ${DAY.format(date)} à ${TIME.format(date)} (heure de Paris)`
}

/** What the pull request reads: why no review, until when, and who can change it. */
export function capSentence(hit: CapHit): string {
  let period = hit.period === 'day' ? 'du jour' : 'du mois'
  return (
    `Kentō ne lance pas de review : le plafond de coût ${period} de l’organisation est atteint ` +
    `(${formatUsd(hit.spentUsd)} dépensés sur ${formatUsd(hit.capUsd)}). ` +
    `Les reviews reprennent ${resetWhen(hit.resetsAt)}, ou dès qu’un admin relève le plafond dans les Réglages de Kentō.`
  )
}

/**
 * Posts a check run « Kentō · plafond », neutral, on the head of a push that the limit of the org
 * stopped. One per head: GitHub shows it in the checks of the pull request, and it never blocks a
 * merge. It has its own name so that a required check « Sakuga Review » stays missing.
 */
export function createCapNotice(deps: {
  mintInstallationToken: MintInstallationToken
  apiUrl: string
  /** The settings screen, `https://review.sakuga.dev/settings`. */
  settingsUrl: string
  fetch?: typeof globalThis.fetch
}) {
  return async (command: Extract<StoreCommand, { type: 'enqueue_review' }>, hit: CapHit): Promise<void> => {
    let token = await deps.mintInstallationToken({
      installationId: command.installation.githubInstallationId,
      githubRepoId: command.repository.githubRepoId,
      permissions: CHECK_PERMISSIONS,
    })
    let github = createGitHub({ apiUrl: deps.apiUrl, token: token.token, fetch: deps.fetch })
    await github.rest('POST', `/repos/${command.repository.fullName}/check-runs`, {
      name: CAP_CHECK_NAME,
      head_sha: command.headSha,
      status: 'completed',
      conclusion: 'neutral',
      details_url: deps.settingsUrl,
      output: {
        title: hit.period === 'day' ? 'Plafond du jour atteint : pas de review' : 'Plafond du mois atteint : pas de review',
        summary: capSentence(hit),
      },
    })
    log('info', 'webhook.cap_notice_posted', { repo: command.repository.fullName, pr: command.prNumber, head: command.headSha, period: hit.period })
  }
}
