// The text of a command in a comment of a pull request: `@kento-review [review] [lite|balanced|heavy] [force]`
// or `@kento-review resolve [lite|balanced|heavy]`. `@sakuga-review` is the old name of the bot, and
// stays an alias. Pure functions: no database, no network.
import { levelCost } from '@sakuga-review/engine/levels'
import { LEVELS, type Level } from '@sakuga-review/protocol'

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

// The name, then the end of the word: `@kentobot` and `@sakuga-review-ci` are other accounts.
const MENTION = /^\s*@(kento-review|sakuga-review)(?![\w-])/i

const isLevel = (word: string): word is Level => (LEVELS as readonly string[]).includes(word)

/**
 * The command of a comment, or null when the comment does not start with a name of the bot. Only
 * the first line counts, and only its first three words: the rest of the comment is free text for
 * the people who read it. The verb `review` is optional: `@kento-review heavy` is
 * `@kento-review heavy`, and `@kento-review` alone asks for a lite review.
 */
export function parseCommentCommand(body: string): CommentCommand | null {
  let mention = MENTION.exec(body)
  if (!mention) return null
  let line = body.slice(mention[0].length).split('\n', 1)[0] ?? ''
  let words = line.trim().split(/[ \t]+/).filter(Boolean).slice(0, 3).map((word) => word.toLowerCase())
  let text = `@${mention[1]!.toLowerCase()}${line.trimEnd()}`.slice(0, 200)

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
