// KNT-173. The limits on the questions to GitHub that a person asks through a form of an org: the
// take-back of the owner role (`members/controller.tsx`) and the moves of installations
// (`organizations/controller.tsx`). Each question spends the API quota of an installation, the one
// of the reviews. The counts are in Postgres (`github_asks`): the limit holds for every process of
// the service, and after a restart. The time is the one of the app (`now`), as the screens read it.
import type postgres from 'postgres'

/** The kinds of questions that a form asks. */
export type GitHubAsk = 'reclaim' | 'move'

/** A limit: at most `limit` questions in a window of `windowMs`. */
export interface AskLimit {
  limit: number
  windowMs: number
}

/**
 * Counts one question of a person in an org. False: the person asked `limit` times in the window
 * already, and the form must not ask GitHub. A window starts at the first question after the end
 * of the one before.
 */
export async function takeGitHubAsk(sql: postgres.Sql, input: { orgId: string; userId: string; action: GitHubAsk; now: number } & AskLimit): Promise<boolean> {
  let now = new Date(input.now).toISOString()
  let windowStart = new Date(input.now - input.windowMs).toISOString()
  let [row] = await sql<{ count: number }[]>`
    insert into github_asks (org_id, user_id, action, window_start, count)
    values (${input.orgId}, ${input.userId}, ${input.action}, ${now}::timestamptz, 1)
    on conflict (org_id, user_id, action) do update set
      count = case when github_asks.window_start <= ${windowStart}::timestamptz then 1 else least(github_asks.count + 1, ${input.limit + 1}) end,
      window_start = case when github_asks.window_start <= ${windowStart}::timestamptz then ${now}::timestamptz else github_asks.window_start end
    returning count`
  return row!.count <= input.limit
}

/**
 * GitHub failed for a question: the window of the person ends `retryMs` after `now` at the latest,
 * so a failure of GitHub does not cost them the whole window.
 */
export async function shortenGitHubAsk(sql: postgres.Sql, input: { orgId: string; userId: string; action: GitHubAsk; now: number; windowMs: number; retryMs: number }) {
  let start = new Date(input.now + input.retryMs - input.windowMs).toISOString()
  await sql`
    update github_asks set window_start = least(window_start, ${start}::timestamptz)
    where org_id = ${input.orgId} and user_id = ${input.userId} and action = ${input.action}`
}
