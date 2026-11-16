// REV-52. The comment that a job of a pull request waits in the queue for too long: no runner is
// online, or none takes it. One comment per pull request (`queue_notices`), written by the
// publisher while a job waits, and deleted once no job of the pull request waits for too long: the
// job left the queue (a runner took it, it was cancelled or it failed; a failure gets its own
// comment, REV-35).

/**
 * A job queued for this long gets the comment and the alert of the dashboard. A runner long-polls a
 * claim every 30 s, and a job queued again after an expired lease waits up to 1 min (backoff): ten
 * minutes is far above both, and still well before a person gives up on the review.
 */
export const QUEUE_STALL_MINUTES = 10
/** A job that began to wait longer ago than this gets no comment: the deploy does not post on old jobs. */
export const QUEUE_NOTICE_MAX_AGE = '1 day'

/** The hidden marker of the comment of a pull request: a comment posted with no answer is found again. */
export const queuedMarker = (repoId: string, prNumber: number) => `<!-- kento:queued ${repoId}#${prNumber} -->`

/** Why the job waits. */
export type StallCause =
  /** No runner that can run the jobs of the repository has called the service for 90 s. */
  | { kind: 'no_runner'; lastSeenAt: Date | null }
  /** Runners are online, and none took the job: they are busy, or none can call its provider. */
  | { kind: 'not_taken'; online: number }

export interface QueuedPull {
  repoId: string
  prNumber: number
  /** The job that waits the longest on the pull request. */
  kind: 'review' | 'resolve'
  level: string
  headSha: string
  /** Since when it waits: its creation, or the end of its backoff after an expired lease. */
  waitingSince: Date
  /** The jobs of the pull request that wait for too long, it included. */
  count: number
  cause: StallCause
  /** The Runners screen, or null when the public URL of Kentō is not set. */
  runnersUrl: string | null
}

/**
 * "30 Oct 14:02 UTC". The body holds no "for N min": it changes only when the job, the cause or
 * the last runner change, so the publisher does not edit the comment at each run.
 */
export function utcTime(date: Date): string {
  let pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "no Kentō runner is online …", or why the online ones do not take it. */
export function causeText(cause: StallCause): string {
  if (cause.kind === 'no_runner') {
    return cause.lastSeenAt
      ? `no Kentō runner is online (last signal on ${utcTime(cause.lastSeenAt)})`
      : 'no Kentō runner is online, and no runner ever called Kentō'
  }
  return cause.online === 1
    ? '1 runner is online, but it does not take the job. It is busy, or it cannot call the provider of this repo'
    : `${cause.online} runners are online, but none takes the job. They are busy, or they cannot call the provider of this repo`
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** The body of the comment that tells the pull request that its job waits, and why. */
export function queuedComment(pull: QueuedPull): string {
  let what = pull.kind === 'review' ? 'review' : 'thread resolution'
  let others = pull.count > 1 ? ` (and ${pull.count - 1} other ${pull.count === 2 ? 'job' : 'jobs'} of this PR)` : ''
  let action = pull.cause.kind === 'no_runner' ? 'For the team: start a runner' : 'For the team: check the runners'
  action += pull.runnersUrl ? ` on the [Runners](${pull.runnersUrl}) screen.` : ' on the Runners screen of Kentō.'
  return [
    `**Kentō · ${what} waiting** at commit \`${pull.headSha.slice(0, 9)}\``,
    `The \`${pull.level}\` ${what} of this commit${others} waits for a runner. It entered the queue on ${utcTime(pull.waitingSince)}. ${sentence(causeText(pull.cause))}.`,
    `It starts by itself when a runner takes it. There is nothing to run again. This comment then goes away. ${action}`,
    queuedMarker(pull.repoId, pull.prNumber),
  ].join('\n\n')
}
