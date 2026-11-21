// KNT-173. The limits on the questions to GitHub that a person asks through a form: the take-back of
// the owner role (`members/controller.tsx`) and the moves of installations
// (`organizations/controller.tsx`). Each question spends the API quota of an installation, the one
// of the reviews. The counts are in Postgres (`github_asks`): the limit holds for every process of
// the service, and after a restart. The window runs on the clock of Postgres, one clock for every
// process.
import type postgres from 'postgres'

/** The kinds of questions that a form asks. */
export type GitHubAsk = 'reclaim' | 'move'

/** The scope of the count of the moves: one per person, whatever the org. */
export const MOVES_SCOPE = 'moves'

/** A limit: at most `limit` questions in a window of `windowMs`. */
export interface AskLimit {
  limit: number
  windowMs: number
}

/**
 * `offsetMs`: added to the clock of Postgres. Zero in the service; the tests move the clock with it.
 */
export interface AskClock {
  offsetMs?: number
}

/**
 * Counts one question of a person. `allowed`: within the limit. `over`: the person asked `limit`
 * times in the window already, and the form must not ask GitHub. `gone`: the person is gone, as a
 * request that was under way when the account went, or the org of `org` is gone. A window starts
 * at the first question after the end of the one before.
 *
 * `org`: the org whose count this is (the scope of the take-back). The count locks the key of the
 * org, and writes nothing for an org that is gone: a move that deletes the org waits for it, or it
 * waits for the move and finds no org. The move deletes the rows of the org it deletes
 * (`organizations/store.ts`), so no row outlives its org.
 */
export async function takeGitHubAsk(
  sql: postgres.Sql,
  input: { userId: string; scope: string; action: GitHubAsk; org?: string } & AskLimit & AskClock,
): Promise<'allowed' | 'over' | 'gone'> {
  let now = sql`(now() + ${input.offsetMs ?? 0}::float8 * interval '1 millisecond')`
  let windowStart = sql`(now() + ${(input.offsetMs ?? 0) - input.windowMs}::float8 * interval '1 millisecond')`
  try {
    let [row] = await sql<{ count: number }[]>`
      ${input.org === undefined ? sql`` : sql`with org as (select id from orgs where id = ${input.org} for key share)`}
      insert into github_asks (user_id, scope, action, window_start, count)
      select ${input.userId}, ${input.scope}, ${input.action}, ${now}, 1
      ${input.org === undefined ? sql`` : sql`from org`}
      on conflict (user_id, scope, action) do update set
        count = case when github_asks.window_start <= ${windowStart} then 1 else least(github_asks.count + 1, ${input.limit + 1}) end,
        window_start = case when github_asks.window_start <= ${windowStart} then ${now} else github_asks.window_start end
      returning count`
    if (!row) return 'gone'
    return row.count <= input.limit ? 'allowed' : 'over'
  } catch (error) {
    // 23503: the user was deleted in between.
    if ((error as { code?: string }).code === '23503') return 'gone'
    throw error
  }
}

/**
 * GitHub failed for a question: the window of the person ends `retryMs` from now at the latest, so a
 * failure of GitHub does not cost them the whole window.
 */
export async function shortenGitHubAsk(
  sql: postgres.Sql,
  input: { userId: string; scope: string; action: GitHubAsk; windowMs: number; retryMs: number } & AskClock,
) {
  await sql`
    update github_asks set window_start = least(window_start, now() + ${(input.offsetMs ?? 0) + input.retryMs - input.windowMs}::float8 * interval '1 millisecond')
    where user_id = ${input.userId} and scope = ${input.scope} and action = ${input.action}`
}
