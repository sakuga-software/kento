// The comment that a job failed for good: no review and no resolution will come. The publisher
// posts it once on the pull request (`jobs.failure_noticed_at`).

import { usageLimitOfReason } from '@kento-review/engine/providers'

import { mention } from '../instance.ts'

/** The longest reason that the comment shows. */
const MAX_REASON = 300

/**
 * The secrets that a provider or a tool can echo in an error: API keys (`sk-…`), tokens of GitHub,
 * a bearer token, a JWT, and any long run of base64 or hex that holds a digit.
 */
const SECRETS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g,
  /\bBearer\s+\S+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  /(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{32,}/g,
]

/** The first line of `reason`, at most 300 characters, with each secret masked. Safe in a code span. */
export function sanitizeReason(reason: string | null): string {
  let line = (reason ?? '').split('\n').find((l) => l.trim() !== '') ?? ''
  for (let secret of SECRETS) line = line.replace(secret, '***')
  line = line.replaceAll('`', "'").replace(/\s+/g, ' ').trim()
  if (line === '') return 'unknown reason'
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line
}

export interface FailedJob {
  id: string
  kind: 'review' | 'resolve'
  level: string
  headSha: string
  failureReason: string | null
  /** The author of the command comment, or null for the review of a push. */
  commenter: string | null
  /** The Config screen of the repository, or null when the public URL of Kentō is not set. */
  configUrl: string | null
}

export const failureMarker = (jobId: string) => `<!-- kento:failure ${jobId} -->`

/** "2026-12-01 00:00 UTC": the reset time of a usage limit, as the comment and the check show it. */
function utcText(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/** The body of the comment that tells the pull request why the job failed, and how to run it again. */
export function failureComment(job: FailedJob): string {
  let review = job.kind === 'review'
  let what = review ? 'review' : 'thread resolution'
  let command = review ? mention(job.level) : mention(`resolve ${job.level}`)
  let commenter = job.commenter ? `@${job.commenter} ` : ''
  let limit = usageLimitOfReason(job.failureReason)
  if (limit) {
    // KNT-161. The provider refused the call on its usage limit: no model read the code.
    let until = limit.resetAt ? ` until ${utcText(limit.resetAt)}` : ''
    let retry = `To run it again${limit.resetAt ? ' after that time' : ''}: \`${command}\`.`
    if (job.configUrl) retry += ` To use another provider for this level, change its provider or set its fallback provider in the [config of the repo](${job.configUrl}).`
    return [
      `**Kentō · ${what} did not happen** at commit \`${job.headSha.slice(0, 9)}\``,
      `${commenter}The \`${job.level}\` ${what} of this commit did not happen: the model provider refused the call on its usage limit${until}. ` +
        'No model read the code, and Kentō will not run it again by itself.',
      `Reason: \`${sanitizeReason(job.failureReason)}\``,
      retry,
      failureMarker(job.id),
    ].join('\n\n')
  }
  let retry = `To run it again: \`${command}\`.`
  if (job.configUrl) retry += ` If the error comes from a model or a provider, check the [config of the repo](${job.configUrl}).`
  return [
    `**Kentō · ${what} failed** at commit \`${job.headSha.slice(0, 9)}\``,
    `${commenter}The \`${job.level}\` ${what} of this commit failed. Kentō will not run it again by itself.`,
    `Reason: \`${sanitizeReason(job.failureReason)}\``,
    retry,
    failureMarker(job.id),
  ].join('\n\n')
}

/**
 * KNT-161. The check run of Kentō for a review that failed, on a head that has no check of Kentō yet:
 * never `success`, since no review approved the head. A usage limit gives `action_required` (a person
 * runs the review again after the limit); another failure gives `failure`. Both keep a required check
 * from passing.
 */
export function failedCheck(job: FailedJob): { conclusion: 'action_required' | 'failure'; title: string; summary: string } {
  let summary = failureComment({ ...job, commenter: null }).replace(failureMarker(job.id), '').trim()
  let limit = usageLimitOfReason(job.failureReason)
  if (limit) {
    let until = limit.resetAt ? `, retry after ${utcText(limit.resetAt)}` : ''
    return { conclusion: 'action_required', title: `Usage limit of the provider: no review${until}`, summary }
  }
  return { conclusion: 'failure', title: `The ${job.level} review failed`, summary }
}
