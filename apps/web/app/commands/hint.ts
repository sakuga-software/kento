// REV-96, REV-116. The hint of `reject`: one reply in the thread of a finding that the model called
// refuted, with the command and a link to the page of the commands. The hint changes no status: only
// `reject` sets the finding aside.
//
// The model gives the verdict, in any language of the replies, and Kentō reads no keyword:
// - at a review, the verdict `refuted` on a thread of its `Answered threads` section (REV-71,
//   publish/publish.ts);
// - at a `resolve` command, the verdict `answered` on the thread of a finding (resolve/publish.ts).
//
// One hint per finding: `findings.reject_hint_at` holds the claim before the post.

import { canWrite } from '../findings/reactions.ts'
import { COMMAND_NAMES } from '../github/comment-command.ts'
import { GitHubError, type GitHub } from '../publish/github.ts'
import { docsRoutes } from '../routes.ts'

/** The command `reject`, anywhere in a reply: in a quote or a block of code too. */
const REJECT_WRITTEN = new RegExp(`@(?:${COMMAND_NAMES.join('|')})\\s+reject\\b`, 'i')

/** Whether a reply names the command `reject`, anywhere: its author knows the command. */
export function namesReject(body: string): boolean {
  return REJECT_WRITTEN.test(body)
}

/** The hidden marker of a hint. A thread that holds it gets no second hint. */
export const HINT_MARKER = '<!-- kento:reject-hint -->'

/** The path of the page of the commands, under the public URL of the service. */
export const DOCS_PATH = docsRoutes.commands.href()

/** The text of the hint. `docsUrl`: the page of the commands, or null when the service does not know its public URL. */
export function hintText(docsUrl: string | null): string {
  let link = docsUrl ? ` [Kentō commands](${docsUrl})` : ''
  return (
    `This reply seems to set the finding aside. To count it as rejected (it will not come back and will not lower the score again), comment ` +
    `\`@${COMMAND_NAMES[0]} reject <cause>\`.${link}\n\n${HINT_MARKER}`
  )
}

/** The claim of the one hint of a finding in `findings.reject_hint_at` (findings/ledger.ts). */
export interface HintClaims {
  claim(findingId: string): Promise<boolean>
  release(findingId: string): Promise<void>
}

export interface HintTarget {
  fullName: string
  pr: number
  /** The first comment of the thread. */
  commentId: number
  findingId: string
  /** The people who replied in the thread. Bots are not in this list: a bot does not run the command. */
  repliers: string[]
  docsUrl: string | null
  /** The permissions that the run already read, by login. */
  writers?: Map<string, boolean>
}

/**
 * Posts the hint in the thread of a finding, and returns whether it posted it. It posts nothing when
 * no replier can write to the repository: only such a person can run the command. It posts nothing
 * when the finding is not open or already has its hint: the claim decides.
 */
export async function postRejectHint(github: GitHub, target: HintTarget, claims: HintClaims): Promise<boolean> {
  let replier = false
  for (let login of target.repliers) {
    if (await canWrite(github, target.fullName, login, target.writers)) {
      replier = true
      break
    }
  }
  if (!replier) return false
  if (!(await claims.claim(target.findingId))) return false
  try {
    await github.rest('POST', `/repos/${target.fullName}/pulls/${target.pr}/comments/${target.commentId}/replies`, { body: hintText(target.docsUrl) })
  } catch (error) {
    // Only an answer of GitHub proves that the hint did not go. After a timeout the hint can be on
    // GitHub: the claim stays, because a missed hint costs less than a second one.
    if (error instanceof GitHubError) await claims.release(target.findingId)
    throw error
  }
  return true
}
