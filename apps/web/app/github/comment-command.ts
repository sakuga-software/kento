// The text of a command in a comment of a pull request: `@kento-review [review] [lite|balanced|heavy] [force]`,
// `@kento-review resolve [lite|balanced|heavy]`, `@kento-review reject [<id>] <reason>` (REV-93) or
// `@kento-review feedback <text>` (REV-107).
// The names come from the instance (KENTO_COMMAND_NAMES): by default `kento-review`, and
// `sakuga-review`, the old name of the bot, as an alias. Pure functions: no database, no network.
import { levelCost } from '@kento-review/engine/levels'
import { SHORT_ID_LENGTH } from '@kento-review/engine/render'
import { isLevel, type Level } from '@kento-review/protocol'

import { FEEDBACK_TEXT_MAX } from '../feedback/request.ts'
import { REASON_MAX } from '../findings/store.ts'
import { instance, mention } from '../instance.ts'

export type CommentCommand =
  | {
      verb: 'review' | 'resolve'
      level: Level
      /** `force`: a review at a level that the head already has is paid again. Review only. */
      force: boolean
    }
  | {
      /**
       * REV-93. Set a finding aside, with its reason. `id` is the short id of the finding (`3cf454`,
       * lowercase, without `#`), or null when the line gives none. `reason` is the rest of the line,
       * as the person wrote it; it can be empty, and then the bot refuses the command.
       */
      verb: 'reject'
      id: string | null
      reason: string
    }
  | {
      /**
       * REV-107. An opinion about the reviews of Kentō. `text` is the rest of the line and the lines
       * after it, trimmed. It can be empty. The command runs no job.
       */
      verb: 'feedback'
      text: string
    }
  | { verb: 'unknown'; text: string }

/** The fewest characters of a short id: the id that the comments of Kentō show (`#3cf454`). */
export const SHORT_ID_MIN = SHORT_ID_LENGTH
/** The key of a finding has 12 hexadecimal characters (`findingKey` of the engine). */
const SHORT_ID_MAX = 12
// An id with `#` (`#3cf454`), or without `#` when it has a digit: `facade` is a word of a reason.
const SHORT_ID = new RegExp(`^(?:#([0-9a-f]{${SHORT_ID_MIN},${SHORT_ID_MAX}})|(?=[a-f]*[0-9])([0-9a-f]{${SHORT_ID_MIN},${SHORT_ID_MAX}}))$`, 'i')

/** The names that start a command, from the instance. The first one is the name of the bot in the answers. */
export function commandNames(): readonly [string, ...string[]] {
  return instance().commandNames
}

/** The names of `commandNames`, as alternatives of a regular expression. */
export function namesPattern(): string {
  return commandNames()
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
}

// At the start of a line, after at most three spaces (four make a block of code): the name, then
// the end of the word. `@kentobot` and `@sakuga-review-ci` are other accounts. REV-96: so is
// `@kento-review[bot]`, the account of the App: a reply that names it gives no command.
function mentionPattern(): RegExp {
  return new RegExp(`^ {0,3}@(${namesPattern()})(?![\\w-]|\\[bot\\])`, 'i')
}
// A fence of code: three backticks or tildes or more, after at most three spaces.
const FENCE = /^ {0,3}(`{3,}|~{3,})/
// A line of a quote: `>` after at most three spaces.
const QUOTE = /^ {0,3}>/

/**
 * The first line of the comment that starts with a name of the bot, out of a block of code and
 * out of a quote, without the name. Null when there is none.
 *
 * - A fence opens a block of code. It closes at a fence of the same character, at least as long,
 *   with nothing after it. A fence that never closes runs to the end of the comment.
 * - A line indented by four spaces or a tab is code, or the rest of the line above it.
 * - A quote runs from a line that starts with `>` to the next blank line: Markdown puts in the
 *   quote the lines that follow it without `>`.
 */
function commandLine(body: string): { name: string; rest: string; after: string } | null {
  let fence: { char: string; length: number } | null = null
  let inQuote = false
  let MENTION = mentionPattern()
  let lines = body.split(/\r?\n/)
  for (let [index, line] of lines.entries()) {
    let open = FENCE.exec(line)
    if (fence) {
      let mark = open?.[1]
      if (mark && mark[0] === fence.char && mark.length >= fence.length && line.slice(open![0].length).trim() === '') fence = null
      continue
    }
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length }
      inQuote = false
      continue
    }
    if (line.trim() === '') {
      inQuote = false
      continue
    }
    if (QUOTE.test(line)) inQuote = true
    if (inQuote) continue
    let mention = MENTION.exec(line)
    if (mention) return { name: mention[1]!, rest: line.slice(mention[0].length), after: lines.slice(index + 1).join('\n') }
  }
  return null
}

/**
 * The command of a comment, or null when no line of the comment starts with a name of the bot.
 * The command is on its own line, anywhere in the comment, out of a block of code and out of a
 * quote (REV-72): a reply can end with `@kento-review heavy`. The first such line counts, and
 * only its first three words: the rest of the comment is free text for the people who read it.
 * The verb `review` is optional: `@kento-review heavy` is `@kento-review review heavy`, and
 * `@kento-review` alone asks for a lite review. A line of the wrong form gives `unknown`, and the
 * bot answers it with the list of the commands.
 */
export function parseCommentCommand(body: string): CommentCommand | null {
  let found = commandLine(body)
  if (!found) return null
  let line = found.rest
  let reject = /^[ \t]+reject(?=[ \t]|$)/i.exec(line)
  if (reject) return rejectCommand(line.slice(reject[0].length))
  let feedback = /^[ \t]+feedback(?=[ \t]|$)/i.exec(line)
  if (feedback) return { verb: 'feedback', text: `${line.slice(feedback[0].length)}\n${found.after}`.trim().slice(0, FEEDBACK_TEXT_MAX) }
  let words = line.trim().split(/[ \t]+/).filter(Boolean).slice(0, 3).map((word) => word.toLowerCase())
  let text = `@${found.name.toLowerCase()}${line.trimEnd()}`.slice(0, 200)

  let verb: 'review' | 'resolve' = 'review'
  if (words[0] === 'review' || words[0] === 'resolve') verb = words.shift() as 'review' | 'resolve'
  else if (words[0] !== undefined && !isLevel(words[0]) && words[0] !== 'force') return { verb: 'unknown', text }
  let [second, third] = words

  let level: Level = 'lite'
  let force = false
  if (second !== undefined) {
    if (isLevel(second)) level = second
    else if (second === 'force' && verb === 'review') force = true
    else return { verb: 'unknown', text }
  }
  // A third word is `force` after a level, or free text.
  if (third === 'force' && verb === 'review' && isLevel(second ?? '')) force = true
  return { verb, level, force }
}

/** `reject [<id>] <reason>`: an id first when its form is one, then the reason. */
function rejectCommand(rest: string): CommentCommand {
  let text = rest.trim()
  let [first = ''] = text.split(/[ \t]+/, 1)
  let id = SHORT_ID.exec(first)
  if (!id) return { verb: 'reject', id: null, reason: text }
  return { verb: 'reject', id: (id[1] ?? id[2])!.toLowerCase(), reason: text.slice(first.length).trim() }
}

/** Where a command was written: the conversation of the pull request, or a reply in a review thread. */
export type PlaceKind = 'conversation' | 'thread'

export type RejectProblem = 'reason_missing' | 'reason_long' | 'id_missing'

/**
 * Why a `reject` cannot run, before any read of the findings, or null. In the conversation, the id is
 * needed. In a thread, the thread names the finding, and an id is optional (KNT-160): the handler
 * checks that it is the id of the finding of the thread, so that a reply never sets aside another
 * finding.
 */
export function rejectProblem(command: Extract<CommentCommand, { verb: 'reject' }>, place: PlaceKind): RejectProblem | null {
  if (place === 'conversation' && command.id === null) return 'id_missing'
  if (command.reason === '') return 'reason_missing'
  if (command.reason.length > REASON_MAX) return 'reason_long'
  return null
}

/** The short reply to a refused `reject`, after the mention of the person. */
export function rejectProblemText(problem: RejectProblem): string {
  switch (problem) {
    case 'reason_missing':
      return `The \`reject\` command needs a cause, on the same line: \`${mention('reject <cause>')}\`.`
    case 'reason_long':
      return `The cause of a \`reject\` has at most ${REASON_MAX} characters.`
    case 'id_missing':
      return `In the conversation of the PR, \`reject\` needs the id of the finding, shown in the list of the description: \`${mention('reject #3cf454 <cause>')}\`.`
  }
}

/** The answer to a command that the bot does not know: the list of the commands, with the names of the instance. */
export function usageText(): string {
  let aliases = commandNames()
    .slice(1)
    .map((name) => `\`@${name}\``)
  return [
    `Kentō commands, in a comment of the PR${aliases.length > 0 ? ` (${aliases.join(', ')} ${aliases.length === 1 ? 'works' : 'work'} too)` : ''}:`,
    '',
    `- \`${mention('[lite|balanced|heavy]')}\`: a review of the PR at the given level (\`lite\` by default).`,
    `- \`${mention('heavy force')}\`: a new review at a level that this commit already got (you pay for it twice).`,
    `- \`${mention('resolve [lite|balanced|heavy]')}\`: answer the open threads, and resolve those that the code settles.`,
    `- \`${mention('reject <cause>')}\`, as a reply in the thread of a finding: dismiss that finding, with its cause.`,
    `- \`${mention('reject #<id> <cause>')}\`, in the conversation: dismiss the finding with this id (shown in the list of the description).`,
    `- \`${mention('feedback <opinion>')}\`: give your opinion on the reviews of Kentō (free).`,
    '',
    `\`lite\`: the diff and the definitions that it uses, ${levelCost('lite')}. ` +
      `\`balanced\`: also the code that calls the change, ${levelCost('balanced')}. ` +
      `\`heavy\`: the context of \`balanced\` with more reasoning, ${levelCost('heavy')}. ` +
      'The config of the repo sets the model of each level.',
    '',
    `The cause goes on the line of the command, in ${REASON_MAX} characters at most. ` +
      'Only a person who can write to the repo can run a command, except `feedback`.',
  ].join('\n')
}

/**
 * REV-96. The list of the commands, with the link to their page when the service knows its public
 * URL.
 */
export function usage(docsUrl: string | null | undefined): string {
  let text = usageText()
  return docsUrl ? `${text}\n\nAll the commands, with examples: [Kentō commands](${docsUrl}).` : text
}
