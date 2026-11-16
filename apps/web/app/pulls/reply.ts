// REV-17. The reply of the bot in the thread of a finding that a person reopens in Kentō. A dismissal
// and a wontfix reply with the words of REV-18 (`replyText` of app/findings/dismiss.ts), through the
// same replier (`createThreadReplier`, `pull_requests: write` on the repository only).

/** The reply in the thread of a finding that a person reopened. */
export function reopenText(login: string): string {
  return `Finding reopened by @${login} on Kentō. The next review reports it again if it is still there.`
}
