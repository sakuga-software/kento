// The publication of a resolve job on GitHub, as `resolve` of review/sakuga-review.ts posts it: one
// reply in each thread that the model read, the threads that the code settled resolved, and one
// comment that lists them with the cost.
//
// The runner gave the verdict of each thread and whether its file changed since the thread. The
// service reads the threads again here: a thread resolved meanwhile gets no reply, and the opener of
// each thread (a bot or a person) comes from GitHub, not from the runner.
import { costLine, withIcon, type Icons } from '@kento/engine/render'
import { markerResolve } from '@kento/engine/threads'
import { MAX_RESOLVE_PACK_BYTES, MAX_RESOLVE_THREADS, type ResolvePayload } from '@kento/protocol'

import { HINT_MARKER, namesReject, postRejectHint, type HintClaims } from '../commands/hint.ts'
import { resolveReviewThread } from '../github/graphql.ts'
import { mention } from '../instance.ts'
import type { GitHub } from '../publish/github.ts'
import { BY } from '../publish/publish.ts'
import { plural } from '../ui/format.ts'
import { readOpenThreads, type OpenThread } from './threads.ts'

const MAX_PACK_KB = MAX_RESOLVE_PACK_BYTES / 1000

export interface ResolveTarget {
  fullName: string
  pr: number
  /** `https://github.com`, for the links of the summary. */
  webUrl: string
  /** REV-106. The icons of the summary; `text` when absent. */
  icons?: Icons
}

export interface ResolveOutcome {
  replied: number
  resolved: number
  /** Threads that the code settled, which the App could not resolve: no `contents: write`. */
  toResolve: number
  /** REV-116. The hints of `reject` that this resolution posted. */
  hinted: number
}

/**
 * REV-116. The hint of `reject` in the thread of a finding that the model called `answered`: a reply
 * shows that the finding is wrong. Without it, a resolution posts no hint.
 */
export interface ResolveHints extends HintClaims {
  /** The finding of the pull request whose first comment is `commentId`, or null: a thread of a person. */
  findingOf(commentId: number): Promise<string | null>
  docsUrl: string | null
}

/**
 * Posts the answer of a resolve job. `writer` is a GitHub with `contents: write`, which
 * `resolveReviewThread` needs; null when the App does not have that permission: the reply then says
 * that the thread can be resolved. `warn` gets the error of one thread, which does not stop the others.
 */
export async function publishResolution(
  github: GitHub,
  writer: GitHub | null,
  target: ResolveTarget,
  payload: ResolvePayload,
  warn: (event: string, fields: Record<string, unknown>) => void,
  hints?: ResolveHints,
): Promise<ResolveOutcome> {
  let { fullName, pr } = target
  let marker = markerResolve(payload.head)
  let at = `at commit \`${payload.head.slice(0, 9)}\``
  let outcome: ResolveOutcome = { replied: 0, resolved: 0, toResolve: 0, hinted: 0 }
  let writers = new Map<string, boolean>()

  if (payload.held === 0) {
    let text =
      payload.waiting > 0
        ? `The first thread to read is larger than one command by itself (${MAX_PACK_KB} KB). No thread was read ${at}.`
        : payload.open > 0
          ? `The ${payload.open} open threads already got an answer ${at}. Push a commit to have them read again.`
          : `No open thread ${at}.`
    await github.rest('POST', `/repos/${fullName}/issues/${pr}/comments`, { body: `${text}\n\n${marker}` })
    return outcome
  }

  let open = new Map((await readOpenThreads(github, fullName, pr)).map((t) => [t.id, t]))
  let lines: string[] = []
  for (let verdict of payload.threads) {
    let thread = open.get(verdict.id)
    // Resolved meanwhile, or not a thread of this pull request.
    if (!thread) continue
    let opener = thread.comments[0]!
    // A thread of a person closes only on a change of its file: an answer of the bot is not enough.
    // A finding of a bot that the file did not change since is not fixed. A force-push that removed
    // the commit of the thread gives null: the thread stays open.
    let close = verdict.verdict === 'fixed' ? verdict.changed === true : verdict.verdict === 'answered' && opener.isBot
    let hintFailed = false
    if (hints && verdict.verdict === 'answered' && opener.isBot) {
      try {
        if (await hint(github, hints, { fullName, pr, thread, writers })) outcome.hinted++
      } catch (error) {
        // The thread stays open: a later resolve reads it again and can post the hint.
        hintFailed = true
        close = false
        warn('resolve.hint_failed', { thread: thread.id, error: String(error).slice(0, 300) })
      }
    }
    let status =
      verdict.verdict === 'fixed' && verdict.changed === null
        ? 'The commit of this thread is unknown or gone from the history (a force-push). The change since that commit is unknown, and the thread stays open.'
        : hintFailed
          ? `Kentō could not post the \`reject\` command in this thread. The thread stays open, and the next \`${mention('resolve')}\` command after a push tries again. To close it now, comment \`${mention('reject <cause>')}\` or resolve it.`
          : ''
    let resolved = false
    if (close) {
      if (writer) {
        try {
          await resolveReviewThread(writer, thread.id)
          resolved = true
        } catch (error) {
          warn('resolve.thread_not_resolved', { thread: thread.id, error: String(error).slice(0, 300) })
        }
      }
      status = resolved ? 'Thread resolved.' : 'The thread can be resolved. The App does not have the permission to do it yet.'
      if (resolved) outcome.resolved++
      else outcome.toResolve++
    }
    try {
      await github.rest('POST', `/repos/${fullName}/pulls/${pr}/comments/${opener.id}/replies`, {
        body: [verdict.reply.trim(), status, marker].filter(Boolean).join('\n\n'),
      })
      outcome.replied++
    } catch (error) {
      warn('resolve.reply_failed', { thread: thread.id, error: String(error).slice(0, 300) })
    }
    let url = `${target.webUrl}/${fullName}/pull/${pr}#discussion_r${opener.id}`
    let icons = target.icons ?? 'text'
    let label = close ? (resolved ? withIcon('resolved', icons, 'resolved') : withIcon('to-resolve', icons, 'to resolve')) : withIcon('stays-open', icons, 'stays open')
    lines.push(`- ${label} · [\`${thread.path}:${thread.line ?? '?'}\`](${url}) · ${opener.author}`)
  }

  let skipped = Math.max(0, payload.waiting - payload.held)
  // Threads that the model read and gave no verdict for: the runner leaves them out.
  let unanswered = Math.max(0, payload.held - payload.threads.length)
  let usage = {
    model: payload.model ?? '?',
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.costUsd !== null ? { cost: payload.costUsd } : {}),
    // REV-11: a model without a price counts 0, and the cost line says that the cost is not known.
    ...(payload.costSource ? { cost_source: payload.costSource } : {}),
  }
  await github.rest('POST', `/repos/${fullName}/issues/${pr}/comments`, {
    body: [
      `**${BY} · thread resolution** ${at}`,
      '',
      ...(lines.length ? lines : unanswered ? [] : ['None of the threads that Kentō read is still open.']),
      '',
      ...(unanswered
        ? [
            unanswered > 1
              ? `${unanswered} threads got no answer from the model. They stay open, and the next \`${mention('resolve')}\` command reads them again.`
              : `One thread got no answer from the model. It stays open, and the next \`${mention('resolve')}\` command reads it again.`,
            '',
          ]
        : []),
      ...(skipped
        ? [
            `${skipped} other open ${plural(skipped, 'thread')} ${plural(skipped, 'waits', 'wait')}. ` +
              `One command reads at most ${MAX_RESOLVE_THREADS} threads and ${MAX_PACK_KB} KB. Run \`${mention('resolve')}\` again.`,
            '',
          ]
        : []),
      `<sub>${costLine(payload.level, usage, BY)}</sub>`,
      '',
      marker,
    ].join('\n'),
  })
  return outcome
}

/**
 * The hint in a thread of a finding that a reply refutes. A thread whose replies already name `reject`
 * or hold a hint gets none.
 */
async function hint(
  github: GitHub,
  hints: ResolveHints,
  input: { fullName: string; pr: number; thread: OpenThread; writers: Map<string, boolean> },
): Promise<boolean> {
  let [opener, ...replies] = input.thread.comments
  if (!opener || replies.some((c) => c.body.includes(HINT_MARKER) || (!c.isBot && namesReject(c.body)))) return false
  let findingId = await hints.findingOf(opener.id)
  if (!findingId) return false
  let repliers = [...new Set(replies.filter((c) => !c.isBot).map((c) => c.author))]
  return postRejectHint(
    github,
    { fullName: input.fullName, pr: input.pr, commentId: opener.id, findingId, repliers, docsUrl: hints.docsUrl, writers: input.writers },
    hints,
  )
}
