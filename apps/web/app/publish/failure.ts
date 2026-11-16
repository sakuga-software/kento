// The comment that a job failed for good: no review and no resolution will come. The publisher
// posts it once on the pull request (`jobs.failure_noticed_at`).

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
  if (line === '') return 'raison inconnue'
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

/** The body of the comment that tells the pull request why the job failed, and how to run it again. */
export function failureComment(job: FailedJob): string {
  let review = job.kind === 'review'
  let what = review ? 'review' : 'thread resolution'
  let command = review ? `@kento-review ${job.level}` : `@kento-review resolve ${job.level}`
  let mention = job.commenter ? `@${job.commenter} ` : ''
  let retry = `To run it again: \`${command}\`.`
  if (job.configUrl) retry += ` If the error comes from a model or a provider, check the [config of the repo](${job.configUrl}).`
  return [
    `**Kentō · ${what} failed** at commit \`${job.headSha.slice(0, 9)}\``,
    `${mention}The \`${job.level}\` ${what} of this commit failed. Kentō will not run it again by itself.`,
    `Reason: \`${sanitizeReason(job.failureReason)}\``,
    retry,
    failureMarker(job.id),
  ].join('\n\n')
}
