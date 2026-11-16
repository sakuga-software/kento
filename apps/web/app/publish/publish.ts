// The publication of a review on GitHub, as review/sakuga-review.ts posts it from the Action: the
// review with its inline comments, the replies on the threads of a finding that is gone, the
// dismissal of the previous REQUEST_CHANGES, the block of the description, the label `review: N/5`
// and the check « Sakuga Review ». The format is the same, so that the scripts that read a review
// (score, level, badges P1/P2) read this one too.
//
// The web service has no checkout. The runner computed where each finding anchors; a call to the
// compare API of GitHub replaces the git diff that tells whether a file changed since a thread.
// The web service imports the two modules that render a review, not the whole engine: it never
// reads a checkout or calls a model.
import {
  BLOCKING_SEVERITIES,
  findingKey,
  isBlocking,
  score,
  toConsider,
  verdict,
  type Answer,
  type Finding,
  type Usage,
} from '@sakuga-review/engine/findings'
import {
  descriptionBlock,
  fileCommentBody,
  FINDING_KEY,
  inlineBody,
  withIcon,
  MARKER_GONE,
  MARKER_VARIANT,
  REVIEW_COUNT,
  reviewBody,
  variantReplyBody,
  withBlock,
  type Icons,
  type Link,
  type Poster,
} from '@sakuga-review/engine/render'
import { SEVERITIES, type ReviewFinding, type ReviewPayload } from '@sakuga-review/protocol'

import type { FindingsLedger, LedgerEntry } from '../findings/ledger.ts'
import {
  adoptThreads,
  fingerprintOf,
  liveThread,
  matchFindings,
  type BotThread,
  type FindingEventDraft,
  type Match,
  type StoredFinding,
} from '../findings/lifecycle.ts'
import { assignmentLine, unreadPathsLine, type JobAssignment } from '../assignment/model.ts'
import { canWrite, REACTION_REASON, thumbsDownBy } from '../findings/reactions.ts'
import { KENTO_ACTOR } from '../findings/store.ts'
import { HINT_MARKER, hintText, namesReject } from '../commands/refutation.ts'
import { COMMAND_NAMES } from '../github/comment-command.ts'
import { resolveReviewThread, reviewThreadPages, unresolveReviewThread } from '../github/graphql.ts'
import { GitHubError, type GitHub } from './github.ts'

/** The name of the check run, as the job of review.yml names it. */
export const CHECK_NAME = 'Sakuga Review'
/** The service that posts the review, in its footer. */
export const BY = 'Kentō'
/** REV-106. Where the service serves the icons of the texts on GitHub: public/assets/pr. */
export const PR_ICONS_PATH = '/assets/pr/'
/** Kentō, the mention that asks it for another review, and its icons on `target` (text without a public URL). */
function posterOf(target: PublishTarget): Poster {
  return { by: BY, handle: `@${COMMAND_NAMES[0]}`, icons: iconsOf(target) }
}

function iconsOf(target: PublishTarget): Icons {
  return target.icons ?? 'text'
}

// Each inline comment is a thread that a person must resolve, so only the sure P2 findings get one.
// REV-103: every P0 and P1 gets a thread, whatever its confidence, and MAX_INLINE does not count it.
const INLINE_CONFIDENCE = 70
const MAX_INLINE = 5
// REV-103. A finding to consider gets a thread when the published score is below this one.
const CONSIDER_SCORE = 4

const SCORE_COLOUR = ['', 'b60205', 'd93f0b', 'fbca04', 'a2d9a5', '0e8a16']
const LABEL_PREFIX = 'review: '

export interface PublishTarget {
  owner: string
  name: string
  pr: number
  /** The login of the App on GitHub, `kento-review[bot]`. */
  botLogin: string
  /** `https://github.com`: the links of the description. */
  webUrl: string
  /**
   * REV-96. The public page of the commands of Kentō, linked in the comment of each finding and in the
   * hint. Null or absent when the service does not know its public URL.
   */
  docsUrl?: string | null
  /** REV-106. The icons of the texts: the files of the service, or `text` when it does not know its public URL. */
  icons?: Icons
}

export interface PublishOutcome {
  reviewId: number
  state: string
  inline: number
  resolved: number
  score: number
  /** REV-16. The open findings that this review shows fixed. */
  fixed: number
  /** REV-16. The findings found again that a person dismissed or kept: the review leaves them out. */
  suppressed: number
  /** REV-99. The replies in the thread of an earlier finding, instead of a new thread. */
  followed: number
  /** REV-96. The threads that the model called refuted and that got the hint of `reject`. */
  hinted: number
  /** REV-103. The comments at the level of the file, for a P0 or P1 outside the diff. */
  fileComments: number
}

type InlineComment = {
  path: string
  line: number
  start_line?: number
  side: 'RIGHT'
  start_side?: 'RIGHT'
  body: string
}

/** The answer of the engine, rebuilt from the review that the runner sent. */
export function answerOf(review: ReviewPayload): Answer {
  return {
    // The runner sends the score that the reader sees. `score()` gives it back: it rounds and caps a
    // score that is already from 1 to 5, and a blocking finding has already capped it at 2.
    confidence_score: review.score,
    risk: review.risk,
    summary: review.summary,
    diagram: review.diagram ?? '',
    findings: review.findings,
    not_reviewed: review.notReviewed,
    deeper_review: { recommended: review.deeperReview !== null, reason: review.deeperReview ?? '' },
  }
}

/** The anchor of a finding, as the runner computed it from the changed lines of the checkout. */
export const anchorOf = (finding: Finding): number | null => (finding as ReviewFinding).anchor ?? null

export function usageOf(review: ReviewPayload): Usage {
  return {
    model: review.model,
    ...(review.provider ? { provider: review.provider } : {}),
    ...(review.costUsd !== null ? { cost: review.costUsd } : {}),
    // REV-11: a model without a price counts 0, and the cost line says that the cost is not known.
    ...(review.costSource ? { cost_source: review.costSource } : {}),
  }
}

/**
 * Publishes the review. Every step before the review itself can throw: nothing is posted yet, and the
 * caller can try again. The write of the findings (REV-16) can throw too, before the review is
 * marked: the next try finds the review by its marker and writes them again. The steps after it
 * (dismissal, description, label, check) are logged when they fail and do not throw: the review is
 * on GitHub, and a second one would repeat it.
 */
export async function publishReview(
  github: GitHub,
  target: PublishTarget,
  review: ReviewPayload,
  options: {
    /** A client whose token can write the checks, or null when the App cannot. */
    checks?: GitHub | null
    /**
     * A unique id of the stored review, written in a hidden comment of the review body. A review of
     * the bot that already carries it is not posted again.
     */
    marker?: string
    /** Called once the review is on GitHub, before the steps that follow it. */
    onPosted?: (reviewId: number) => Promise<void>
    /**
     * REV-16. The findings of the pull request in the database. Without it, the findings live in the
     * threads of the bot only, as before the table.
     */
    findings?: FindingsLedger
    /**
     * REV-21. The assignment rule that set the level of the job of a push. The review says it, and
     * mentions the person that the rule names.
     */
    assignment?: JobAssignment | null
    /** REV-21. The rules with paths that the push could not test: GitHub did not list the files. */
    assignmentUnread?: readonly number[]
    warn?: (event: string, fields: Record<string, unknown>) => void
  } = {},
): Promise<PublishOutcome> {
  let { owner, name, pr } = target
  let warn = options.warn ?? (() => {})
  let repo = `/repos/${owner}/${name}`
  let usage = usageOf(review)
  let level = review.level
  let head = review.head
  let threads = await botThreads(github, target)
  let threadUrl = (commentId: number) => `${target.webUrl}/${owner}/${name}/pull/${pr}#discussion_r${commentId}`

  // REV-16. The findings of the pull request: those of the database, and the open threads of an
  // earlier release that the database does not hold yet.
  let ledger = options.findings ?? null
  let known = ledger ? await ledger.load() : []
  let stored = [...known, ...adoptThreads(known, threads)]
  // A 👎 of a person on the comment of an open finding dismisses it before the review: GitHub sends
  // no webhook for a reaction. An error leaves the finding open.
  let reacted = new Map<StoredFinding, string>()
  let writers = new Map<string, boolean>()
  if (ledger) {
    for (let s of stored) {
      if (s.status !== 'open' || s.githubCommentId === null) continue
      try {
        let login = await thumbsDownBy(github, `${owner}/${name}`, s.githubCommentId, writers)
        if (!login) continue
        reacted.set(s, login)
        s.status = 'dismissed'
        s.statusReason = REACTION_REASON
      } catch (error) {
        warn('publish.reaction_failed', { finding: s.id, error: String(error) })
      }
    }
  }
  let { matches, unmatched } = matchFindings(review.findings, stored, threads)
  let changedSince = filesChangedSince(github, repo, head)
  // REV-99. A follower of a finding that a person dismissed or kept comes back only when the file of
  // that finding changed since its last review, as the runner checked: GitHub says it again, so that
  // a `follows` alone never opens a decision of a person again. A failure keeps the decision.
  for (let m of matches) {
    let s = m.stored
    if (!m.followed || !s || (s.status !== 'dismissed' && s.status !== 'wontfix')) continue
    let changed: boolean | null = null
    try {
      changed = await changedSince(s.lastSeenSha || undefined, s.path)
    } catch (error) {
      warn('publish.follow_check_failed', { finding: s.id, error: String(error) })
    }
    if (changed === true) continue
    Object.assign(m, { suppressed: true, reopened: false, carrier: null, followIn: null })
  }
  // A finding that a person dismissed or kept gets no comment, and the review leaves it out.
  let shown = matches.filter((m) => !m.suppressed)
  let matchOf = new Map<Finding, Match>(shown.map((m) => [m.finding as Finding, m]))
  let answer: Answer = { ...answerOf(review), findings: shown.map((m) => m.finding) }

  let ordered = [...answer.findings].sort(
    (a, b) =>
      Number(isBlocking(b, anchorOf)) - Number(isBlocking(a, anchorOf)) ||
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      b.confidence - a.confidence,
  )
  let value = score(answer, anchorOf)
  let raiseConsidered = raisesToConsider(ordered, value, (f) => matchOf.get(f)?.carrier != null)
  let inline: Finding[] = []
  let comments: InlineComment[] = []
  let outsideDiff: Finding[] = []
  for (let f of ordered) {
    // A finding that an open thread already carries is not posted again.
    if (matchOf.get(f)?.carrier) continue
    // REV-100. A new finding on code already read, not critical, gets no thread: the block lists it.
    // REV-103: a P1 to consider gets one when raisesToConsider() says so.
    if (toConsider(f) && !(raiseConsidered && BLOCKING_SEVERITIES.has(f.severity))) continue
    let line = anchorOf(f)
    if (BLOCKING_SEVERITIES.has(f.severity)) {
      if (line === null) {
        outsideDiff.push(f)
        continue
      }
    } else if (line === null || f.confidence < INLINE_CONFIDENCE || inline.length >= MAX_INLINE) continue
    let range = line === f.line ? (f as ReviewFinding).suggestion_range : null
    let comment: InlineComment = { path: f.path.replace(/^\/+/, ''), line, side: 'RIGHT', body: inlineBody(f, range !== null, target.docsUrl, iconsOf(target)) }
    if (range && range[0] < range[1]) Object.assign(comment, { start_line: range[0], start_side: 'RIGHT' })
    inline.push(f)
    comments.push(comment)
  }

  // An open finding that this review did not find again is fixed only when its file changed since
  // the review that last found it: the same code can be read twice, and a model can miss a finding.
  // A finding whose commit a force-push removed stays open: nothing tells what changed since.
  // The threads to close are found before the review, for its note on a force-push; they are closed
  // only once the review is on GitHub, so that a review that fails to post closes nothing.
  let fixed: StoredFinding[] = []
  let toClose: BotThread[] = []
  let gone = 0
  // An error on one finding (the compare API) leaves it open and never stops the review.
  for (let s of unmatched) {
    // A stale finding of a reopened pull request is fixed the same way, and its thread closed.
    if (s.status !== 'open' && s.status !== 'stale') continue
    let thread = liveThread(s, threads)
    try {
      let changed = await changedSince(s.lastSeenSha || undefined, s.path)
      if (changed === null && thread) gone++
      if (changed) {
        fixed.push(s)
        if (thread) toClose.push(thread)
      }
    } catch (error) {
      warn('publish.thread_failed', { thread: thread?.id ?? null, finding: s.id, error: String(error) })
    }
  }

  let reviewsPath = `${repo}/pulls/${pr}/reviews`
  let marker = options.marker ? `\n\n<!-- kento:review ${options.marker} -->` : ''
  let body =
    reviewBody(answer, anchorOf, level, usage, posterOf(target), raiseConsidered) +
    goneNote(gone, review.base, iconsOf(target)) + assignmentNote(options.assignment ?? null, options.assignmentUnread ?? []) + marker
  let event = verdict(answer, anchorOf, level)
  // A review that an earlier try posted, and could not mark (a restart, a lost connection): it is
  // not posted again. The steps after it run once more.
  let posted: { id: number; state: string } | undefined = marker
    ? (await listReviews(github, reviewsPath)).find((r) => r.user?.login === target.botLogin && r.body?.includes(marker.trim()))
    : undefined
  let alreadyPosted = posted !== undefined
  if (posted) {
    warn('publish.already_posted', { githubReviewId: posted.id })
  } else {
    try {
      posted = await github.rest('POST', reviewsPath, { commit_id: head, body, event, comments })
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 422) || !comments.length) throw error
      // A line that the API refuses drops the inline comments, never the review.
      warn('publish.inline_refused', { error: String(error) })
      comments.length = 0
      inline.length = 0
      posted = await github.rest('POST', reviewsPath, { commit_id: head, body, event, comments: [] })
    }
  }
  let found = posted!

  // From here the review is on GitHub: a failure is logged, and the next step still runs.
  let step = async (stepName: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      warn('publish.step_failed', { step: stepName, error: String(error) })
    }
  }

  // REV-16. The comments and the findings are written before the review is marked as posted, and
  // their failure throws: the review stays unmarked, and the next try finds it by its marker, posts
  // nothing, and writes them again. A finding is never left out of the database by a lost write.
  //
  // The comment of each new finding of this review: by the key in its marker, and by its line when
  // two findings of one file share a title (and so a key).
  let newThreads = new Map<Finding, number>()
  if (inline.length) {
    let posted: { id: number; body: string; line?: number | null }[] =
      (await github.rest('GET', `${reviewsPath}/${found.id}/comments?per_page=100`)) ?? []
    let free = posted.flatMap((c) => {
      let key = FINDING_KEY.exec(c.body)?.[1]
      return key ? [{ id: c.id, key, line: c.line ?? null }] : []
    })
    for (let f of inline) {
      let key = findingKey(f)
      let hit = free.find((c) => c.key === key && c.line === anchorOf(f)) ?? free.find((c) => c.key === key)
      if (!hit) continue
      newThreads.set(f, hit.id)
      free.splice(free.indexOf(hit), 1)
    }
  }
  // REV-103. GitHub takes no comment on a file in the comments of a review: each one is a call of its
  // own, after the review. A retry does not post it twice. The comment of the earlier try is an open
  // thread of the bot with the key of the finding, so it carries the finding (adoptThreads). If that
  // thread carries nothing (a person resolved it), the search by its key at this head finds it.
  let fileComments = 0
  for (let f of outsideDiff) {
    let path = f.path.replace(/^\/+/, '')
    let key = findingKey(f)
    let earlier = threads.find((t) => t.key === key && t.path === path && t.line === null && t.commit === head)
    if (earlier) {
      newThreads.set(f, earlier.commentId)
      continue
    }
    let lines = f.start_line && f.start_line < f.line ? `L${f.start_line}-L${f.line}` : `L${f.line}`
    let lineUrl = `${target.webUrl}/${owner}/${name}/blob/${head}/${path}#${lines}`
    try {
      let out: { id: number } = await github.rest('POST', `${repo}/pulls/${pr}/comments`, {
        body: fileCommentBody(f, lineUrl, target.docsUrl, iconsOf(target)),
        commit_id: head,
        path,
        subject_type: 'file',
      })
      newThreads.set(f, out.id)
      fileComments++
    } catch (error) {
      // GitHub refuses a file that the pull request does not change: the block lists the finding.
      if (!(error instanceof GitHubError && error.status === 422)) throw error
      warn('publish.file_comment_refused', { path, error: String(error) })
    }
  }
  if (ledger) await ledger.save(ledgerEntries(matches, fixed, unmatched, newThreads, head, reacted))

  // The caller marks the review as posted. A failure there must not skip the description, the
  // label and the check of a review that is already on GitHub.
  let onPosted = options.onPosted
  if (onPosted) await step('mark', () => onPosted(found.id))

  // The threads of the findings that are gone. A failure on one thread (a comment deleted meanwhile)
  // leaves it open.
  let resolved = 0
  for (let t of toClose) {
    await step('thread', async () => {
      try {
        await resolveReviewThread(github, t.id)
      } catch (error) {
        // GitHub refuses this mutation to an App that cannot write the contents. The reply tells the
        // person who resolves the thread why it can go.
        warn('publish.thread_not_resolved', { thread: t.id, error: String(error) })
        await github.rest('POST', `${repo}/pulls/${pr}/comments/${t.commentId}/replies`, {
          body:
            `Ce constat n'apparaît plus au commit \`${head.slice(0, 9)}\`, et le fichier a changé depuis. ` +
            `Le fil peut être résolu.\n\n${MARKER_GONE}`,
        })
      }
      resolved++
    })
  }

  // REV-99. A finding that follows an earlier one is answered in the thread of that one, opened again
  // when it was resolved. A thread that already holds the reply of this head is not answered twice.
  let followed = 0
  for (let m of shown) {
    let thread = m.followIn
    if (!thread) continue
    let key = findingKey(m.finding)
    if (thread.variants?.includes(`${head} ${key}`)) continue
    await step('follow', async () => {
      if (thread.resolved) {
        try {
          await unresolveReviewThread(github, thread.id)
        } catch (error) {
          // The reply still says that the defect is back: a person can open the thread.
          warn('publish.thread_not_unresolved', { thread: thread.id, error: String(error) })
        }
      }
      await github.rest('POST', `${repo}/pulls/${pr}/comments/${thread.commentId}/replies`, {
        body: variantReplyBody(m.finding, head, m.stored?.status ?? 'open', iconsOf(target)),
      })
      followed++
    })
  }

  // REV-96. A thread that the model called refuted (REV-71) gets the hint of `reject` once, as a reply
  // that the pattern of the webhook reads as a refutation. Only an open thread of an open finding, in
  // which a person who can write to the repository replied: the hint names a command that only such
  // a person can run.
  let hinted = 0
  for (let id of new Set(review.refutedThreads ?? [])) {
    let thread = threads.find((t) => t.id === id)
    // A thread whose replies already name `reject` knows the command.
    if (!thread || thread.resolved || thread.hinted || thread.namesReject) continue
    // The finding of the thread in the database: by its first comment, or by its key when a later
    // thread carries it. A thread that the database does not know is a finding of an earlier release.
    let finding =
      known.find((s) => s.githubCommentId === thread.commentId) ??
      known.find((s) => s.key === thread.key) ??
      stored.find((s) => s.githubCommentId === thread.commentId)
    // A finding that a 👎 dismissed, or that this review shows fixed (its thread is closed above).
    if (finding && (finding.status !== 'open' || fixed.includes(finding))) continue
    if (toClose.includes(thread)) continue
    await step('hint', async () => {
      let replier = false
      for (let login of thread.repliers ?? []) {
        if (await canWrite(github, `${owner}/${name}`, login, writers)) {
          replier = true
          break
        }
      }
      if (!replier) return
      // One hint per finding: the claim in the database before the post (REV-96), as the webhook does.
      // A finding with no row (a thread of an earlier release) cannot be claimed: it gets no hint.
      let claimed = finding?.id && ledger?.claimHint ? finding.id : null
      if (!claimed || !(await ledger!.claimHint!(claimed))) return
      try {
        await github.rest('POST', `${repo}/pulls/${pr}/comments/${thread.commentId}/replies`, { body: hintText(null, target.docsUrl ?? null) })
      } catch (error) {
        // As in the webhook: only an answer of GitHub proves that the hint did not go.
        if (error instanceof GitHubError) await ledger!.releaseHint?.(claimed)
        throw error
      }
      hinted++
    })
  }

  // A COMMENT does not lift an earlier REQUEST_CHANGES, so the review of the previous head would keep
  // the pull request blocked after its findings are fixed. The dismissal clears it.
  await step('dismiss', async () => {
    // GitHub lists the reviews oldest first, 100 at most per page: the previous one can be on a
    // later page.
    let previous = await listReviews(github, reviewsPath)
    for (let p of previous) {
      if (p.user?.login === target.botLogin && p.state === 'CHANGES_REQUESTED' && p.id !== found.id) {
        await github.rest('PUT', `${reviewsPath}/${p.id}/dismissals`, {
          message: 'Remplacée par la review du dernier commit.',
          event: 'DISMISS',
        })
      }
    }
  })

  await step('description', async () => {
    // Each finding links to its thread: a new comment of this review, or the open thread that carries it.
    let links: Link[] = ordered.map((f) => {
      let id = newThreads.get(f) ?? matchOf.get(f)?.carrier?.commentId
      return { finding: f, url: id ? threadUrl(id) : null }
    })
    let commit: { commit?: { message?: string } } = await github.rest('GET', `${repo}/commits/${head}`)
    let subject = (commit?.commit?.message ?? '').split('\n')[0]!.trim()
    // The block goes at the end of the description, read again just before the write: the author can
    // edit the description while the review runs.
    let prPath = `${repo}/pulls/${pr}`
    let current: string = (await github.rest('GET', prPath))?.body ?? ''
    let previousCount = Number(REVIEW_COUNT.exec(current)?.[1] ?? 0)
    // A review found again may already have written its block: that block counts it once.
    let counted = alreadyPosted && current.includes(`/commit/${head})`)
    let count = counted ? previousCount : previousCount + 1
    let block = descriptionBlock(answer, links, review.skipped, resolved, usage, anchorOf, {
      count,
      head,
      subject,
      commitUrl: `${target.webUrl}/${owner}/${name}/commit/${head}`,
      level,
      poster: posterOf(target),
      docsUrl: target.docsUrl ?? null,
      ...(review.delta ? { delta: review.delta } : {}),
    })
    await github.rest('PATCH', prPath, { body: withBlock(current, block) })
  })

  await step('label', () => setScoreLabel(github, repo, pr, value))

  if (options.checks) {
    let checks = options.checks
    await step('check', async () => {
      await checks.rest('POST', `${repo}/check-runs`, {
        name: CHECK_NAME,
        head_sha: head,
        status: 'completed',
        conclusion: 'success',
        details_url: `${target.webUrl}/${owner}/${name}/pull/${pr}`,
        output: { title: `Score de confiance : ${value}/5`, summary: body.slice(0, 60_000) },
      })
    })
  }

  return {
    reviewId: found.id,
    state: found.state,
    inline: alreadyPosted ? 0 : comments.length,
    resolved,
    score: value,
    fixed: fixed.length,
    suppressed: matches.length - shown.length,
    followed,
    hinted,
    fileComments,
  }
}

/**
 * REV-103. Whether the P1 findings to consider (REV-100) get a thread: only when the published score
 * is below CONSIDER_SCORE, and when no other new P0 or P1 is in the review. A P0 or P1 that is not to
 * consider explains a low score, and a finding that a thread already carries (`carried`) is not new.
 */
export function raisesToConsider(findings: readonly Finding[], published: number, carried: (finding: Finding) => boolean): boolean {
  if (published >= CONSIDER_SCORE) return false
  return !findings.some((f) => BLOCKING_SEVERITIES.has(f.severity) && !toConsider(f) && !carried(f))
}

/**
 * REV-106. `raisesToConsider` for a review shown again (REV-89), with the open threads (`carried`)
 * as `publishReview` reads them. Without the threads, it counts every P0 and P1 as new: the count of
 * points to check can then differ, but the head keeps its state.
 */
function raisedIn(answer: Answer, carried: (finding: Finding) => boolean = () => false): boolean {
  return raisesToConsider(answer.findings, score(answer, anchorOf), carried)
}

/**
 * REV-89. What the review `id` of the bot is on the pull request, for a reused review that links to it:
 *
 * - `stands`: it is the last review of the bot, and nobody dismissed it. The copy writes the block.
 * - `replaced`: a later review of the bot came after it (another head, or a command). The copy is
 *   not published: the block, the label and the check are those of that later review.
 * - `gone`: it is not on the pull request any more, or a person dismissed it. The copy is posted as a
 *   review of its own.
 */
export async function botReviewState(github: GitHub, target: PublishTarget, id: number): Promise<'stands' | 'replaced' | 'gone'> {
  let reviews = await listReviews(github, `/repos/${target.owner}/${target.name}/pulls/${target.pr}/reviews`)
  // GitHub lists the reviews oldest first. REV-101: a copy of this review on a later head does not
  // replace it.
  let copy = sameAsMarker(id)
  let ours = reviews.filter((r) => r.user?.login === target.botLogin && !r.body?.includes(copy))
  let source = ours.find((r) => r.id === id)
  if (!source) return 'gone'
  if (ours.at(-1) !== source) return 'replaced'
  return source.state === 'DISMISSED' ? 'gone' : 'stands'
}

/** REV-101. The hidden comment of a review that copies the review `id` of the bot on a later head. */
function sameAsMarker(id: number): string {
  return `<!-- kento:same-as ${id} -->`
}

/** REV-101. The line of a copied review that names the commit of its source. */
export function sameScoreLine(reusedFrom: string): string {
  return `Même score que le commit \`${reusedFrom.slice(0, 9)}\` : aucun fichier relu n'a changé depuis.`
}

/**
 * REV-89. Whether the check of Kentō is already on the head: a second try posts no second one. Only
 * a check of this App counts: the job « Sakuga Review » of the Action has the same name.
 */
async function hasCheck(checks: GitHub, repo: string, head: string, botLogin: string): Promise<boolean> {
  let slug = botLogin.replace(/\[bot\]$/, '')
  let out: { check_runs?: { name: string; app?: { slug?: string } | null }[] } = await checks.rest(
    'GET',
    `${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}`,
  )
  return (out?.check_runs ?? []).some((c) => c.name === CHECK_NAME && c.app?.slug === slug)
}

/**
 * REV-89. The review of an earlier head, published again on a head with the same input (a merge of
 * the base branch, a rebase with no conflict): the block of the description, the label and the
 * check. REV-101: also a review on the head, with the same score and verdict and no inline comment.
 * The findings and their threads are already on GitHub, and the findings of the database do not
 * change. The block keeps the count of the reviews. Every step up to the review of the head throws,
 * so the caller can try again; the label and the check do not.
 */
export async function publishUnchanged(
  github: GitHub,
  target: PublishTarget,
  review: ReviewPayload,
  reusedFrom: string,
  options: {
    checks?: GitHub | null
    findings?: FindingsLedger
    /**
     * REV-101. The review on GitHub to copy on the head, and the id of the stored review (`marker`). A
     * review of the bot that already carries the marker is not posted again. Without it, the head
     * gets no review.
     */
    headReview?: { sourceId: number; marker: string }
    warn?: (event: string, fields: Record<string, unknown>) => void
  } = {},
): Promise<{ score: number; shown: number; headReviewId: number | null }> {
  let { owner, name, pr } = target
  let warn = options.warn ?? (() => {})
  let repo = `/repos/${owner}/${name}`
  let usage = usageOf(review)
  let head = review.head
  let threads = await botThreads(github, target)
  let known = options.findings ? await options.findings.load() : []
  let stored = [...known, ...adoptThreads(known, threads)]
  // The same matching as a review: a finding that a person dismissed or kept stays out of the block.
  let { matches } = matchFindings(review.findings, stored, threads)
  // REV-99. The publication of the source opened again a follower that could come back: one still
  // dismissed or kept here was set aside since, and stays out.
  for (let m of matches) {
    if (m.followed && (m.stored?.status === 'dismissed' || m.stored?.status === 'wontfix')) Object.assign(m, { suppressed: true, carrier: null, followIn: null })
  }
  let shown = matches.filter((m) => !m.suppressed)
  let answer: Answer = { ...answerOf(review), findings: shown.map((m) => m.finding) }
  let ordered = [...answer.findings].sort(
    (a, b) =>
      Number(isBlocking(b, anchorOf)) - Number(isBlocking(a, anchorOf)) ||
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      b.confidence - a.confidence,
  )
  let carrier = new Map<Finding, number>(shown.flatMap((m) => (m.carrier ? [[m.finding as Finding, m.carrier.commentId] as const] : [])))
  let value = score(answer, anchorOf)
  let step = async (stepName: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      warn('publish.step_failed', { step: stepName, error: String(error) })
    }
  }
  // The block is the only text of this publication: a failure throws, the row stays to publish, and
  // the next try writes it again. The label and the check after it are logged when they fail.
  {
    let links: Link[] = ordered.map((f) => {
      let id = carrier.get(f)
      return { finding: f, url: id ? `${target.webUrl}/${owner}/${name}/pull/${pr}#discussion_r${id}` : null }
    })
    let commit: { commit?: { message?: string } } = await github.rest('GET', `${repo}/commits/${head}`)
    let subject = (commit?.commit?.message ?? '').split('\n')[0]!.trim()
    let prPath = `${repo}/pulls/${pr}`
    let current: string = (await github.rest('GET', prPath))?.body ?? ''
    // No new review: the count stays.
    let count = Math.max(1, Number(REVIEW_COUNT.exec(current)?.[1] ?? 0))
    let block = descriptionBlock(answer, links, review.skipped, 0, usage, anchorOf, {
      count,
      head,
      subject,
      commitUrl: `${target.webUrl}/${owner}/${name}/commit/${head}`,
      level: review.level,
      poster: posterOf(target),
      docsUrl: target.docsUrl ?? null,
      reusedFrom,
    })
    await github.rest('PATCH', prPath, { body: withBlock(current, block) })
  }
  // REV-101. The head gets a review of its own, with the score and the verdict of the block: a merge
  // policy reads the score of the review on the head. A failure throws, as for the block.
  let raised = raisedIn(answer, (f) => carrier.has(f))
  let headReviewId = options.headReview ? await postHeadReview(github, target, review, reusedFrom, answer, raised, options.headReview) : null
  await step('label', () => setScoreLabel(github, repo, pr, value))
  if (options.checks) {
    let checks = options.checks
    await step('check', () => postReusedCheck(checks, target, review, reusedFrom, answer, raised))
  }
  return { score: value, shown: shown.length, headReviewId }
}

/**
 * REV-101. The review of a reused head: the body of a review with the score of `answer`, a line that
 * names the commit of the source, and no inline comment (the threads of the source stay). A second
 * try finds it by its marker and posts nothing.
 */
async function postHeadReview(
  github: GitHub,
  target: PublishTarget,
  review: ReviewPayload,
  reusedFrom: string,
  answer: Answer,
  raised: boolean,
  copy: { sourceId: number; marker: string },
): Promise<number> {
  let reviewsPath = `/repos/${target.owner}/${target.name}/pulls/${target.pr}/reviews`
  let marker = `<!-- kento:review ${copy.marker} -->`
  let posted = (await listReviews(github, reviewsPath)).find((r) => r.user?.login === target.botLogin && r.body?.includes(marker))
  if (posted) return posted.id
  let body =
    reviewBody(answer, anchorOf, review.level, usageOf(review), posterOf(target), raised) +
    `\n\n${sameScoreLine(reusedFrom)}\n\n${sameAsMarker(copy.sourceId)}\n${marker}`
  let event = verdict(answer, anchorOf, review.level)
  let out: { id: number } = await github.rest('POST', reviewsPath, { commit_id: review.head, body, event, comments: [] })
  return out.id
}

/**
 * REV-89. The check « Sakuga Review » of a reused head, when the head has none of Kentō yet: a second
 * try posts no second one. `answer`: the findings that the block shows; all of them when not given.
 */
export async function postReusedCheck(
  checks: GitHub,
  target: PublishTarget,
  review: ReviewPayload,
  reusedFrom: string,
  answer: Answer = answerOf(review),
  raised = raisedIn(answer),
) {
  let { owner, name, pr } = target
  let repo = `/repos/${owner}/${name}`
  if (await hasCheck(checks, repo, review.head, target.botLogin)) return
  let value = score(answer, anchorOf)
  let body =
    reviewBody(answer, anchorOf, review.level, usageOf(review), posterOf(target), raised) +
    `\n\nAucun fichier relu n'a changé depuis le commit \`${reusedFrom.slice(0, 9)}\` : sa review vaut pour ce commit.`
  await checks.rest('POST', `${repo}/check-runs`, {
    name: CHECK_NAME,
    head_sha: review.head,
    status: 'completed',
    conclusion: 'success',
    details_url: `${target.webUrl}/${owner}/${name}/pull/${pr}`,
    output: { title: `Score de confiance : ${value}/5`, summary: body.slice(0, 60_000) },
  })
}

/**
 * The changes of a review to the findings of its pull request: each finding of the review (new,
 * found again, or open again), each open finding that it shows fixed, and the threads of an earlier
 * release that the database does not hold yet.
 */
export function ledgerEntries(
  matches: readonly Match[],
  fixed: readonly StoredFinding[],
  unmatched: readonly StoredFinding[],
  newThreads: ReadonlyMap<Finding, number>,
  head: string,
  /** The findings that a 👎 dismissed before this review, with the login of the person. */
  reacted: ReadonlyMap<StoredFinding, string> = new Map(),
): LedgerEntry[] {
  let entries: LedgerEntry[] = []
  let opened: FindingEventDraft = { type: 'opened', actor: KENTO_ACTOR }
  let byReaction = (s: StoredFinding | null): FindingEventDraft[] => {
    let login = s ? reacted.get(s) : undefined
    return login ? [{ type: 'dismissed', actor: login, reason: REACTION_REASON }] : []
  }
  for (let m of matches) {
    let f = m.finding
    let s = m.stored
    if (m.followed && m.suppressed && s && s.id !== null) {
      // REV-99. A follower that a decision of a person keeps out: the row keeps the words that the
      // person set aside, and only the head of its last review moves.
      let { id, ...values } = s
      entries.push({ id, values: { ...values, lastSeenSha: head }, events: byReaction(s) })
      continue
    }
    let key = findingKey(f)
    let comment = newThreads.get(f) ?? null
    let ruleId = (f as { rule_id?: string }).rule_id ?? s?.ruleId ?? null
    entries.push({
      id: s?.id ?? null,
      values: {
        fingerprint: fingerprintOf(f),
        key,
        ruleId,
        path: f.path.replace(/^\/+/, ''),
        line: f.anchor ?? f.line,
        title: f.title,
        severity: f.severity,
        category: f.category,
        confidence: f.confidence,
        status: s && !m.reopened ? s.status : 'open',
        statusReason: s && !m.reopened ? s.statusReason : null,
        loadedStatus: s?.loadedStatus ?? null,
        lastSeenSha: head,
        githubCommentId: comment ?? s?.githubCommentId ?? null,
        githubThreadId: comment ? null : (m.carrier?.id ?? s?.githubThreadId ?? null),
      },
      events: [
        ...(s === null || s.id === null ? [opened] : m.reopened ? [{ type: 'reopened', actor: KENTO_ACTOR } as const] : []),
        ...byReaction(s),
      ],
    })
  }
  let fixedSet = new Set(fixed)
  for (let s of fixed) {
    let { id, ...values } = s
    entries.push({
      id,
      values: { ...values, status: 'fixed' },
      events: [...(id === null ? [opened] : []), { type: 'fixed', actor: KENTO_ACTOR }],
    })
  }
  for (let s of unmatched) {
    if (fixedSet.has(s) || (s.id !== null && !reacted.has(s))) continue
    let { id, ...values } = s
    entries.push({ id, values, events: [...(id === null ? [opened] : []), ...byReaction(s)] })
  }
  return entries
}

/**
 * REV-21. The assignment rule of the job, and the person that it asks to read the review; and the
 * rules with paths that GitHub kept from being tested.
 */
export function assignmentNote(assignment: JobAssignment | null, unread: readonly number[] = []): string {
  let unreadLine = unread.length > 0 ? `\n\n<sub>${unreadPathsLine(unread)}</sub>` : ''
  if (!assignment) return unreadLine
  let mention = assignment.mention ? `\n\nRelecture demandée par la règle : @${assignment.mention}` : ''
  // The rule that applied first, then the rules before it that could not be tested.
  return `\n\n<sub>${assignmentLine(assignment)}</sub>${unreadLine}${mention}`
}

/**
 * The note of a review when a force-push removed the commit of open threads: their diff starts at
 * the merge base, and they stay open.
 */
function goneNote(gone: number, base: string, icons: Icons): string {
  if (!gone) return ''
  let threads = gone > 1 ? `${gone} fils ouverts` : 'un fil ouvert'
  return (
    `\n\n> ${withIcon('warning', icons, `Un force-push a retiré de l'historique le commit relu par ${threads}.`)} ` +
    `Le diff depuis ce commit est impossible : cette review relit toute la PR depuis la base \`${base.slice(0, 9)}\`, ` +
    `et ${gone > 1 ? 'ces fils restent ouverts' : 'ce fil reste ouvert'}.`
  )
}

// GitHub lists at most this many files in a comparison.
const COMPARE_MAX_FILES = 300

/**
 * Whether a file changed between the commit of a thread and the head, from the compare API: the
 * same answer as `fileChangedSince` of the engine on a checkout.
 *
 * - null: the commit is not in the history of the head (a force-push removed it, or GitHub no longer
 *   has it). Nobody can tell what changed since the comment.
 * - false: the file did not change, or GitHub lists too many files to tell. A thread stays open
 *   when the answer is not sure.
 */
function filesChangedSince(github: GitHub, repo: string, head: string) {
  let cache = new Map<string, Promise<{ ancestor: boolean; files: Set<string> } | null>>()
  let compare = (commit: string) => {
    let hit = cache.get(commit)
    if (hit) return hit
    let promise = (async () => {
      try {
        let out: { status: string; files?: { filename: string; previous_filename?: string }[] } = await github.rest(
          'GET',
          `${repo}/compare/${commit}...${head}?per_page=${COMPARE_MAX_FILES}`,
        )
        let files = out.files ?? []
        return {
          // `ahead` or `identical`: the commit is an ancestor of the head. `diverged` or `behind`: not.
          ancestor: out.status === 'ahead' || out.status === 'identical',
          // GitHub lists at most COMPARE_MAX_FILES files: a file past the list reads as unchanged.
          files: new Set(files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])])),
        }
      } catch (error) {
        // GitHub answers 404 for a commit that it does not have.
        if (error instanceof GitHubError && error.status === 404) return null
        throw error
      }
    })()
    cache.set(commit, promise)
    return promise
  }
  return async (commit: string | undefined, path: string): Promise<boolean | null> => {
    if (!commit) return false
    let out = await compare(commit)
    if (!out || !out.ancestor) return null
    return out.files.has(path)
  }
}

type ListedReview = { id: number; state: string; body: string | null; user: { login: string } | null }

/** Every review of the pull request. GitHub lists them oldest first, 100 at most per page. */
async function listReviews(github: GitHub, reviewsPath: string): Promise<ListedReview[]> {
  let reviews: ListedReview[] = []
  for (let page = 1; ; page++) {
    let batch: ListedReview[] = (await github.rest('GET', `${reviewsPath}?per_page=100&page=${page}`)) ?? []
    reviews.push(...batch)
    if (batch.length < 100) return reviews
  }
}

type ThreadNode = {
  id: string
  isResolved: boolean
  path: string
  line: number | null
  comments: { nodes: { databaseId: number; body: string; author: { login: string; __typename?: string } | null; commit: { oid: string } | null }[] }
}

/** The review threads that the bot opened on the pull request. */
async function botThreads(github: GitHub, target: PublishTarget): Promise<BotThread[]> {
  // GraphQL gives the login of an App without `[bot]`.
  let logins = new Set([target.botLogin, target.botLogin.replace(/\[bot\]$/, '')])
  let threads: BotThread[] = []
  let fields = 'id isResolved path line comments(first: 50) { nodes { databaseId body author { login __typename } commit { oid } } }'
  for await (let nodes of reviewThreadPages<ThreadNode>(github, target, fields)) {
    for (let node of nodes) {
      let first = node.comments.nodes[0]
      if (!first || !logins.has(first.author?.login ?? '')) continue
      let key = FINDING_KEY.exec(first.body)
      if (!key) continue
      let later = node.comments.nodes.slice(1)
      // The last word of the bot in the thread: its reply that the finding is gone, or (REV-99) its
      // reply that a later review found the defect again, which makes the thread live again.
      // REV-96. The hint of `reject` is no last word: the finding stays live in its thread.
      let lastWord = later
        .filter((c) => !c.body.includes(HINT_MARKER))
        .filter((c) => c.body.includes(MARKER_GONE) || logins.has(c.author?.login ?? ''))
        .at(-1)
      threads.push({
        id: node.id,
        resolved: node.isResolved,
        path: node.path,
        line: node.line ?? null,
        key: key[1]!,
        commit: first.commit?.oid,
        commentId: first.databaseId,
        body: first.body,
        // A later comment of the bot in the thread is its reply that the finding is gone, unless its
        // last one says that the defect is back.
        answered: lastWord !== undefined && !MARKER_VARIANT.test(lastWord.body),
        variants: later.flatMap((c) => {
          let mark = MARKER_VARIANT.exec(c.body)
          return mark ? [`${mark[1]} ${mark[2]}`] : []
        }),
        hinted: later.some((c) => c.body.includes(HINT_MARKER)),
        // REV-96. A person already named `reject` in a reply, in a quote or a block of code too.
        namesReject: later.some((c) => !logins.has(c.author?.login ?? '') && namesReject(c.body)),
        // The people who replied: a bot never runs the hint's command on its own.
        repliers: [
          ...new Set(
            later
              .filter((c) => c.author && c.author.__typename !== 'Bot' && !logins.has(c.author.login) && !c.author.login.endsWith('[bot]'))
              .map((c) => c.author!.login),
          ),
        ],
      })
    }
  }
  return threads
}

/** One label `review: N/5` on the pull request, created on the first use in a repository. */
async function setScoreLabel(github: GitHub, repo: string, pr: number, value: number) {
  let label = `${LABEL_PREFIX}${value}/5`
  try {
    await github.rest('GET', `${repo}/labels/${encodeURIComponent(label)}`)
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) throw error
    await github.rest('POST', `${repo}/labels`, {
      name: label,
      color: SCORE_COLOUR[value],
      description: `Score de confiance de ${BY} (5 : prête à fusionner)`,
    })
  }
  let current: { name: string }[] = (await github.rest('GET', `${repo}/issues/${pr}/labels`)) ?? []
  for (let old of current) {
    if (old.name.startsWith(LABEL_PREFIX) && old.name !== label) {
      await github.rest('DELETE', `${repo}/issues/${pr}/labels/${encodeURIComponent(old.name)}`)
    }
  }
  await github.rest('POST', `${repo}/issues/${pr}/labels`, { labels: [label] })
}
