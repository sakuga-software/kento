// The text of a command in a comment of a pull request: `@kento-review [review] [lite|balanced|heavy] [force]`,
// `@kento-review resolve [lite|balanced|heavy]` or `@kento-review reject [<id>] <reason>` (REV-93).
// `@sakuga-review` is the old name of the bot, and stays an alias. Pure functions: no database, no
// network.
import { levelCost } from '@sakuga-review/engine/levels'
import { SHORT_ID_LENGTH } from '@sakuga-review/engine/render'
import { isLevel, type Level } from '@sakuga-review/protocol'

import { REASON_MAX } from '../findings/store.ts'

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
  | { verb: 'unknown'; text: string }

/** The fewest characters of a short id: the id that the comments of Kentō show (`#3cf454`). */
export const SHORT_ID_MIN = SHORT_ID_LENGTH
/** The key of a finding has 12 hexadecimal characters (`findingKey` of the engine). */
const SHORT_ID_MAX = 12
// An id with `#` (`#3cf454`), or without `#` when it has a digit: `facade` is a word of a reason.
const SHORT_ID = new RegExp(`^(?:#([0-9a-f]{${SHORT_ID_MIN},${SHORT_ID_MAX}})|(?=[a-f]*[0-9])([0-9a-f]{${SHORT_ID_MIN},${SHORT_ID_MAX}}))$`, 'i')

/** The names that start a command. The first one is the name of the bot in the answers. */
export const COMMAND_NAMES = ['kento-review', 'sakuga-review'] as const

// At the start of a line, after at most three spaces (four make a block of code): the name, then
// the end of the word. `@kentobot` and `@sakuga-review-ci` are other accounts. REV-96: so is
// `@kento-review[bot]`, the account of the App: a reply that names it gives no command.
const MENTION = new RegExp(`^ {0,3}@(${COMMAND_NAMES.join('|')})(?![\\w-]|\\[bot\\])`, 'i')
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
function commandLine(body: string): { name: string; rest: string } | null {
  let fence: { char: string; length: number } | null = null
  let inQuote = false
  for (let line of body.split(/\r?\n/)) {
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
    if (mention) return { name: mention[1]!, rest: line.slice(mention[0].length) }
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

export type RejectProblem = 'reason_missing' | 'reason_long' | 'id_missing' | 'id_in_thread'

/**
 * Why a `reject` cannot run, before any read of the findings, or null. In a thread, the thread names
 * the finding: an id there is refused, so that a reply never sets aside another finding than the one
 * of its thread. In the conversation, the id is needed.
 */
export function rejectProblem(command: Extract<CommentCommand, { verb: 'reject' }>, place: PlaceKind): RejectProblem | null {
  if (place === 'thread' && command.id !== null) return 'id_in_thread'
  if (place === 'conversation' && command.id === null) return 'id_missing'
  if (command.reason === '') return 'reason_missing'
  if (command.reason.length > REASON_MAX) return 'reason_long'
  return null
}

/** The short reply to a refused `reject`, after the mention of the person. */
export function rejectProblemText(problem: RejectProblem): string {
  switch (problem) {
    case 'reason_missing':
      return 'La commande `reject` demande une cause, sur la même ligne : `@kento-review reject <cause>`.'
    case 'reason_long':
      return `La cause d'un \`reject\` fait au plus ${REASON_MAX} caractères.`
    case 'id_missing':
      return "Dans la conversation de la PR, `reject` demande l'id du constat, affiché dans la liste de la description : `@kento-review reject #3cf454 <cause>`."
    case 'id_in_thread':
      return "Dans le fil d'un constat, `reject` vise ce constat : écrivez la cause sans id, `@kento-review reject <cause>`."
  }
}

/** The answer to a command that the bot does not know: the list of the commands. */
export const USAGE = [
  'Commandes de Kentō, dans un commentaire de la PR (`@sakuga-review` marche aussi) :',
  '',
  '- `@kento-review [lite|balanced|heavy]` : une review de la PR au niveau donné (`lite` par défaut).',
  "- `@kento-review heavy force` : une nouvelle review à un niveau que ce commit a déjà reçu (elle est payée deux fois).",
  '- `@kento-review resolve [lite|balanced|heavy]` : répondre aux fils ouverts, et résoudre ceux que le code règle.',
  "- `@kento-review reject <cause>`, en réponse dans le fil d'un constat : écarter ce constat, avec sa cause.",
  "- `@kento-review reject #<id> <cause>`, dans la conversation : écarter le constat de cet id (affiché dans la liste de la description).",
  '',
  `\`lite\` : le diff et les définitions qu'il utilise, ${levelCost('lite')}. ` +
    `\`balanced\` : en plus, le code qui appelle le changement, ${levelCost('balanced')}. ` +
    `\`heavy\` : le contexte de \`balanced\` avec plus de réflexion, ${levelCost('heavy')}. ` +
    'Le modèle de chaque niveau se règle dans la config du repo.',
  '',
  `La cause tient sur la ligne de la commande, en ${REASON_MAX} caractères au plus. ` +
    'Seule une personne qui peut écrire dans le repo peut lancer une commande.',
].join('\n')

/**
 * REV-96. The list of the commands, with the link to their page when the service knows its public
 * URL.
 */
export function usage(docsUrl: string | null | undefined): string {
  return docsUrl ? `${USAGE}\n\nToutes les commandes, avec des exemples : [Les commandes de Kentō](${docsUrl}).` : USAGE
}
