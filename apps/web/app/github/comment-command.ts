// The text of a command in a comment of a pull request: `@kento-review [review] [lite|balanced|heavy] [force]`
// or `@kento-review resolve [lite|balanced|heavy]`. `@sakuga-review` is the old name of the bot, and
// stays an alias. Pure functions: no database, no network.
import { levelCost } from '@sakuga-review/engine/levels'
import { isLevel, type Level } from '@sakuga-review/protocol'

export type CommentCommand =
  | {
      verb: 'review' | 'resolve'
      level: Level
      /** `force`: a review at a level that the head already has is paid again. Review only. */
      force: boolean
    }
  | { verb: 'unknown'; text: string }

/** The names that start a command. The first one is the name of the bot in the answers. */
export const COMMAND_NAMES = ['kento-review', 'sakuga-review'] as const

// At the start of a line, after at most three spaces (four make a block of code): the name, then
// the end of the word. `@kentobot` and `@sakuga-review-ci` are other accounts.
const MENTION = new RegExp(`^ {0,3}@(${COMMAND_NAMES.join('|')})(?![\\w-])`, 'i')
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

/** The answer to a command that the bot does not know: the list of the commands. */
export const USAGE = [
  'Commandes de Kentō, dans un commentaire de la PR (`@sakuga-review` marche aussi) :',
  '',
  '- `@kento-review [lite|balanced|heavy]` : une review de la PR au niveau donné (`lite` par défaut).',
  "- `@kento-review heavy force` : une nouvelle review à un niveau que ce commit a déjà reçu (elle est payée deux fois).",
  '- `@kento-review resolve [lite|balanced|heavy]` : répondre aux fils ouverts, et résoudre ceux que le code règle.',
  '',
  `\`lite\` : le diff et les définitions qu'il utilise, ${levelCost('lite')}. ` +
    `\`balanced\` : en plus, le code qui appelle le changement, ${levelCost('balanced')}. ` +
    `\`heavy\` : le contexte de \`balanced\` avec plus de réflexion, ${levelCost('heavy')}. ` +
    'Le modèle de chaque niveau se règle dans la config du repo.',
  '',
  'Seule une personne qui peut écrire dans le repo peut lancer une commande.',
].join('\n')
