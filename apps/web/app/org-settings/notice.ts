import type { StoreCommand } from '../db/webhook-store.ts'
import type { MintInstallationToken, TokenPermissions } from '../github/installation-token.ts'
import { CAP_CHECK_NAME } from '../instance.ts'
import { log } from '../log.ts'
import { createGitHub } from '../publish/github.ts'
import { usd, when } from '../ui/format.ts'
import type { CapHit } from './model.ts'

export { CAP_CHECK_NAME }

const CHECK_PERMISSIONS: TokenPermissions = { checks: 'write' }

/** "on 30 Oct at 01:00 (Paris time)". */
export function resetWhen(date: Date): string {
  return `${when(date)} (Paris time)`
}

/** What the pull request reads: why no review, until when, and who can change it. */
export function capSentence(hit: CapHit): string {
  let period = hit.period === 'day' ? 'daily' : 'monthly'
  return (
    `Kentō does not start a review: the organization reached its ${period} cost cap ` +
    `(${usd(hit.spentUsd)} spent of ${usd(hit.capUsd)}). ` +
    `The reviews start again ${resetWhen(hit.resetsAt)}, or as soon as an admin raises the cap in the Kentō Settings.`
  )
}

/**
 * Posts a check run "Kentō · cap", neutral, on the head of a push that the limit of the org
 * stopped. One per head: GitHub shows it in the checks of the pull request, and it never blocks a
 * merge. It has its own name so that a required review check (KENTO_CHECK_NAME) stays missing.
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
        title: hit.period === 'day' ? 'Daily cap reached: no review' : 'Monthly cap reached: no review',
        summary: capSentence(hit),
      },
    })
    log('info', 'webhook.cap_notice_posted', { repo: command.repository.fullName, pr: command.prNumber, head: command.headSha, period: hit.period })
  }
}
