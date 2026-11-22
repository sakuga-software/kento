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

/** What a count answers. */
export type AskOutcome =
  /** Within the limit: the form asks GitHub. */
  | 'allowed'
  /** The person asked `limit` times in the window already: the form must not ask GitHub. */
  | 'over'
  /** The person, their membership or the org is gone: nothing is written, and GitHub is not asked. */
  | 'gone'

/**
 * Counts one question of a person, in a scope that belongs to them alone (`MOVES_SCOPE`). A window
 * starts at the first question after the end of the one before.
 */
export async function takePersonAsk(
  sql: postgres.Sql,
  input: { userId: string; scope: typeof MOVES_SCOPE; action: GitHubAsk } & AskLimit & AskClock,
): Promise<AskOutcome> {
  return take(sql, { ...input, org: null })
}

/**
 * KNT-198. Counts one question of a person about an org (the take-back of the owner role). The
 * scope of the row is the id of the org, set here, so the lock and the scope cannot differ. The
 * count locks the key of the org and writes nothing for an org that is gone: a move that deletes the
 * org waits for it, or it waits for the move and answers `gone`. The move deletes the rows of the
 * org it deletes (`organizations/store.ts`), so no row outlives its org. It also reads, in the same
 * statement (on its snapshot, not after the lock), that the person is a member of the org: a person
 * removed before the count gets `gone`. A removal while the count waits on the org is not seen;
 * `reclaim` then refuses under the lock of the members, and no role is gained.
 */
export async function takeOrgAsk(
  sql: postgres.Sql,
  input: { userId: string; orgId: string; action: GitHubAsk } & AskLimit & AskClock,
): Promise<AskOutcome> {
  return take(sql, { userId: input.userId, scope: input.orgId, action: input.action, limit: input.limit, windowMs: input.windowMs, offsetMs: input.offsetMs, org: input.orgId })
}

async function take(
  sql: postgres.Sql,
  input: { userId: string; scope: string; action: GitHubAsk; org: string | null } & AskLimit & AskClock,
): Promise<AskOutcome> {
  let now = sql`(now() + ${input.offsetMs ?? 0}::float8 * interval '1 millisecond')`
  let windowStart = sql`(now() + ${(input.offsetMs ?? 0) - input.windowMs}::float8 * interval '1 millisecond')`
  try {
    let [row] = await sql<{ count: number }[]>`
      ${
        input.org === null
          ? sql``
          : sql`with org as (
              select o.id from orgs o
              where o.id = ${input.org}
                and exists (select 1 from memberships m where m.org_id = o.id and m.user_id = ${input.userId})
              for key share of o)`
      }
      insert into github_asks (user_id, scope, action, window_start, count)
      select ${input.userId}, ${input.scope}, ${input.action}, ${now}, 1
      ${input.org === null ? sql`` : sql`from org`}
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
export async function shortenOrgAsk(
  sql: postgres.Sql,
  input: { userId: string; orgId: string; action: GitHubAsk; windowMs: number; retryMs: number } & AskClock,
) {
  await sql`
    update github_asks set window_start = least(window_start, now() + ${(input.offsetMs ?? 0) + input.retryMs - input.windowMs}::float8 * interval '1 millisecond')
    where user_id = ${input.userId} and scope = ${input.orgId} and action = ${input.action}`
}
