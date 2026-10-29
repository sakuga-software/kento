// The publication of a resolve job on GitHub, as `resolve` of review/sakuga-review.ts posts it: one
// reply in each thread that the model read, the threads that the code settled resolved, and one
// comment that lists them with the cost.
//
// The runner gave the verdict of each thread and whether its file changed since the thread. The
// service reads the threads again here: a thread resolved meanwhile gets no reply, and the opener of
// each thread (a bot or a person) comes from GitHub, not from the runner.
import { costLine } from '@sakuga-review/engine/render'
import { markerResolve } from '@sakuga-review/engine/threads'
import { MAX_RESOLVE_THREADS, type ResolvePayload } from '@sakuga-review/protocol'

import type { GitHub } from '../publish/github.ts'
import { readOpenThreads } from './threads.ts'

/** The service that answers, in the summary. */
const BY = 'Kentō'
const MAX_PACK_KB = 150

export interface ResolveTarget {
  fullName: string
  pr: number
  /** `https://github.com`, for the links of the summary. */
  webUrl: string
}

export interface ResolveOutcome {
  replied: number
  resolved: number
  /** Threads that the code settled, which the App could not resolve: no `contents: write`. */
  toResolve: number
}

const plural = (n: number, word: string) => `${word}${n > 1 ? 's' : ''}`

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
): Promise<ResolveOutcome> {
  let { fullName, pr } = target
  let marker = markerResolve(payload.head)
  let at = `au commit \`${payload.head.slice(0, 9)}\``
  let outcome: ResolveOutcome = { replied: 0, resolved: 0, toResolve: 0 }

  if (payload.held === 0) {
    let text =
      payload.waiting > 0
        ? `Le premier fil à traiter dépasse à lui seul la taille d'une commande (${MAX_PACK_KB} ko) : aucun fil n'a été relu ${at}.`
        : payload.open > 0
          ? `Les ${payload.open} fils ouverts ont déjà reçu une réponse ${at}. Poussez un commit pour qu'ils soient relus.`
          : `Aucun fil ouvert ${at}.`
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
    let status =
      verdict.verdict === 'fixed' && verdict.changed === null
        ? "Le commit de ce fil est inconnu ou absent de l'historique (un force-push) : le changement depuis ce commit est inconnu, et le fil reste ouvert."
        : ''
    let resolved = false
    if (close) {
      if (writer) {
        try {
          await writer.graphql('mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }', { id: thread.id })
          resolved = true
        } catch (error) {
          warn('resolve.thread_not_resolved', { thread: thread.id, error: String(error).slice(0, 300) })
        }
      }
      status = resolved ? 'Fil résolu.' : "Le fil peut être résolu : l'App n'a pas encore le droit de le faire."
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
    let label = close ? (resolved ? '✅ résolu' : '☑️ à résoudre') : '💬 reste ouvert'
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
      `**${BY} · résolution des fils** ${at}`,
      '',
      ...(lines.length ? lines : unanswered ? [] : ["Aucun des fils relus n'est encore ouvert."]),
      '',
      ...(unanswered
        ? [
            unanswered > 1
              ? `${unanswered} fils relus sans réponse du modèle : ils restent ouverts, et la prochaine commande \`@kento resolve\` les relira.`
              : 'Un fil relu sans réponse du modèle : il reste ouvert, et la prochaine commande `@kento resolve` le relira.',
            '',
          ]
        : []),
      ...(skipped
        ? [
            `${skipped} autre${skipped > 1 ? 's' : ''} ${plural(skipped, 'fil')} ${plural(skipped, 'ouvert')} attend${skipped > 1 ? 'ent' : ''} : ` +
              `une commande traite au plus ${MAX_RESOLVE_THREADS} fils et ${MAX_PACK_KB} ko. Relancez \`@kento resolve\`.`,
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
