// REV-107. The request for feedback that Kentō posts on a pull request after its third published
// review, and how a reply that quotes it is found. Pure functions: no database, no network.

/** The published reviews of a pull request that start the request. */
export const FEEDBACK_AFTER_REVIEWS = 3

/** The longest text of an answer that Kentō keeps. */
export const FEEDBACK_TEXT_MAX = 4000

// Two parts of the request. A quote of the request holds one of them: GitHub drops the hidden
// marker of a comment from a quote.
const OPENING = 'Kentō reviewed this PR'
const ASK = 'Your opinion on these reviews'

/** Hidden in the request: the comment of the App that asks. */
export const FEEDBACK_MARKER = '<!-- kento:feedback-request -->'

/** The comment that asks the author of the pull request for their opinion. */
export function requestText(author: string, reviews: number): string {
  return (
    `@${author} ${OPENING} ${reviews} times. ${ASK} helps us make it better: what helped you, a false positive, a useless thread, ` +
    'a missed defect. To answer, write `@kento-review feedback <your opinion>`, quote this message, or react with 👍 or 👎. ' +
    `Kentō will not ask again on this PR.\n\n${FEEDBACK_MARKER}`
  )
}

// A line of a quote: `>` after at most three spaces. A quote runs to the next blank line, as in
// comment-command.ts.
const QUOTE = /^ {0,3}>/

function split(body: string): { quoted: string[]; own: string[] } {
  let quoted: string[] = []
  let own: string[] = []
  let inQuote = false
  for (let line of body.split(/\r?\n/)) {
    if (line.trim() === '') {
      inQuote = false
      own.push(line)
      continue
    }
    if (QUOTE.test(line)) inQuote = true
    if (inQuote) quoted.push(line.replace(/^(?:\s*>)+/, ''))
    else own.push(line)
  }
  return { quoted, own }
}

const flat = (text: string) => text.replaceAll('`', '').replace(/\s+/g, ' ').trim()

/** The comment quotes the request for feedback, in full or in part. */
export function quotesRequest(body: string): boolean {
  let quoted = flat(split(body).quoted.join(' '))
  return [OPENING, ASK].some((part) => quoted.includes(part))
}

/** The text of a reply without its quotes, trimmed. Empty when the reply is only a quote. */
export function replyText(body: string): string {
  return split(body).own.join('\n').trim().slice(0, FEEDBACK_TEXT_MAX)
}
