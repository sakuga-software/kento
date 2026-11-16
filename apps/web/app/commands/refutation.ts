// REV-96. Whether a reply in the thread of a finding sets the finding aside in words: "Not applied:
// the value is validated by the schema", "Kept as is", "Risk accepted".
// The pattern reads the start of the reply only, in English, with no call to a model.
// A wrong hint on a reply that applied the fix is noise: the pattern prefers to miss a refutation.
// The verdict `refuted` of the next review (REV-71) catches the turns of phrase that it misses.
//
// It was built on 1,051 replies in the threads of Kentō, in the repositories of the org from 2026-09-01,
// labelled by hand. refutation.cases.ts holds 174 of their starts, the replies in English: on them,
// precision 100 %, recall 68.8 %.

import { COMMAND_NAMES } from '../github/comment-command.ts'
import { docsRoutes } from '../routes.ts'

/** The pattern reads this many characters of the reply, after its cleaning. */
export const HEAD_LENGTH = 160

// The end of a word, for the letters outside ASCII too: `\b` of a regular expression reads only ASCII
// letters.
const END = '(?![\\p{L}\\p{N}_])'

/** An opening that agrees with the finding, then says that nothing changes: "Agreed, no change". */
const NOTHING = '(?:[,:;.]? (?:and )?(?:no change|nothing to (?:change|fix|do)))'

/**
 * A reply that says the fix went in, even in part: never a refutation, whatever follows ("Partially
 * applied: the rest is out of scope").
 */
const APPLIED = new RegExp(
  '^(?:' +
    [
      '(?:partly |partially |now )?(?:applied|fixed|addressed|done|resolved|implemented|corrected|handled|updated|changed|added|removed|reworked|moved|renamed)',
      'good (?:catch|point|call)',
      `agreed(?!${NOTHING})`,
      'valid (?:point|finding)',
    ].join('|') +
    `)${END}`,
  'iu',
)

/** The starts of a reply that sets the finding aside. Each one comes from real replies. */
const REFUTES = new RegExp(
  '^(?:' +
    [
      'not (?:applied|applying|changed|changing|fixed|fixing|addressed|adopted|taken|done|real|right|the case|a (?:bug|defect|regression|problem|real issue|valid finding)|an issue|valid|relevant|reachable|live|needed|necessary)',
      "(?:won'?t|will not|didn'?t|did not|do not|don'?t) (?:fix|apply|change)",
      'wontfix',
      'no(?:t a)? (?:change|code change|fix|action)',
      'no[ -]change',
      'nothing to (?:fix|change|do)',
      '(?:kept|keeping|keep|left|leaving|leave) (?:it )?(?:as[ -]is|unchanged|as it is)',
      'kept(?:[,:.;]| on purpose| deliberately| intentionally)',
      'skipped',
      'declined',
      'moot',
      'out of scope',
      '(?:this is a )?false positive',
      'by design',
      'intentional',
      '(?:this is )?(?:deliberate|intended|on purpose|working as intended|works as intended|expected behaviou?r)',
      '(?:verified,? (?:and )?)?deliberately not',
      'known and (?:wanted|accepted|intended|left)',
      '(?:risk )?accepted(?: risk)?',
      'disagree',
      `agreed${NOTHING}`,
      "(?:the|this) (?:one|premise|finding|claim) (?:does not|doesn'?t) hold",
      '(?:checked|verified|measured)[,:;.]? (?:and )?(?:no defect|nothing to change|not real)',
      '(?:same|duplicate) (?:finding|issue|defect|request|point) (?:as|of)',
      'still no change',
      'refuted',
    ].join('|') +
    `)${END}`,
  'iu',
)

/**
 * The start of a reply as the pattern reads it: without the hidden comments (the marker of an
 * agent, `<!-- claude-reply -->`), the quotes, the mentions and the emphasis that open it.
 */
export function replyHead(body: string): string {
  let text = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split(/\r?\n/)
    // A quote of the finding, or of an earlier reply, is not what the person says.
    .filter((line) => !/^ {0,3}>/.test(line))
    .join(' ')
  text = text
    .replace(/\s+/g, ' ')
    .trim()
    // Mentions, emphasis, a heading mark, a list mark or an emoji before the first word.
    .replace(/^(?:(?:@[\w-]+(?:\[bot\])?[,:]?|[*_#>`~-]+|[\p{Extended_Pictographic}️]+)\s*)+/u, '')
  return text.slice(0, HEAD_LENGTH)
}

/** The command `reject`, anywhere in a reply: in a quote or a block of code too. */
const REJECT_WRITTEN = new RegExp(`@(?:${COMMAND_NAMES.join('|')})\\s+reject\\b`, 'i')

/** Whether a reply names the command `reject`, anywhere: its author knows the command. */
export function namesReject(body: string): boolean {
  return REJECT_WRITTEN.test(body)
}

/**
 * Whether a reply sets the finding of its thread aside, from its start. A reply that names the
 * command `reject` already knows it: no.
 */
export function looksRefuted(body: string): boolean {
  if (namesReject(body)) return false
  let head = replyHead(body)
  if (head === '' || APPLIED.test(head)) return false
  return REFUTES.test(head)
}

/** The hidden marker of a hint. A thread that holds it gets no second hint. */
export const HINT_MARKER = '<!-- kento:reject-hint -->'

/** The path of the page of the commands, under the public URL of the service. */
export const DOCS_PATH = docsRoutes.commands.href()

/**
 * The text of the hint. `login`: the person who wrote the reply, mentioned first; null at a review,
 * where the model read every reply of the thread. `docsUrl`: the page of the commands, or null when
 * the service does not know its public URL.
 */
export function hintText(login: string | null, docsUrl: string | null): string {
  let lead = login ? `@${login} ` : ''
  let link = docsUrl ? ` [Kentō commands](${docsUrl})` : ''
  return (
    `${lead}This reply seems to set the finding aside. To count it as rejected (it will not come back and will not lower the score again), comment ` +
    `\`@${COMMAND_NAMES[0]} reject <cause>\`.${link}\n\n${HINT_MARKER}`
  )
}
