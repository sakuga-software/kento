// REV-38. The jobs, reviews and resolutions leave the database after RETENTION_DAYS: without it they
// grow with every push (about 1.1 KB per review, most of it the JSON of the model).
import type postgres from 'postgres'

import { errorMessage, log } from '../log.ts'
import { SWITCH_TARGET } from '../repos/store.ts'

/** A job that ended before this many days leaves the database, with its review or its resolution. */
export const RETENTION_DAYS = 180

/** The jobs that one statement deletes: each batch is a short transaction, and the next one waits for it. */
export const PURGE_BATCH = 2000

/** The purge runs once an hour. The first run after the deploy deletes the backlog in batches. */
export const PURGE_INTERVAL_MS = 60 * 60 * 1000

/**
 * Deletes the jobs that ended (`done`, `failed`, `cancelled`) and were created more than `days` days
 * ago, `batch` at a time, until none is left. The foreign keys do the rest: the review or the
 * resolution of a job goes with it (`on delete cascade`), and a finding or a finding event that names
 * the review keeps its row with no review (`on delete set null`). A queued or running job stays.
 *
 * The Repos screen reads, for each repository, its last SWITCH_TARGET published reviews and its last
 * failed job, whatever their age: their jobs stay, so the streak and the last review on screen do
 * not change when a repository had no push for months. Returns the number of jobs deleted. An
 * aborted `signal` stops it before the next batch.
 */
export async function purgeOldJobs(
  sql: postgres.Sql,
  { days = RETENTION_DAYS, batch = PURGE_BATCH, signal }: { days?: number; batch?: number; signal?: AbortSignal } = {},
): Promise<number> {
  let deleted = 0
  for (;;) {
    // The shutdown of the server stops the purge between two batches: the backlog of a first run
    // takes many batches, and the next run deletes the rest.
    if (signal?.aborted) return deleted
    let rows = await sql`
      with kept as (
        select last.job_id as id from repos
        cross join lateral (
          select job_id from reviews
          where reviews.repo_id = repos.id and reviews.github_review_id is not null
          order by published_at desc, id desc
          limit ${SWITCH_TARGET}
        ) last
        union all
        select failed.id from repos
        cross join lateral (
          select id from jobs
          where jobs.repo_id = repos.id and jobs.state = 'failed'
          order by coalesce(finished_at, updated_at) desc, id desc
          limit 1
        ) failed
      ),
      old as (
        select id from jobs
        where jobs.state in ('done', 'failed', 'cancelled')
          and jobs.created_at < now() - make_interval(days => ${days})
          and not exists (select 1 from kept where kept.id = jobs.id)
        limit ${batch}
        for update skip locked
      )
      delete from jobs where id in (select id from old)
      returning 1`
    deleted += rows.length
    if (rows.length < batch) return deleted
  }
}

/**
 * Runs `purgeOldJobs` every `intervalMs`, one run at a time, and once at the start. An error of the
 * database is logged, and the next tick tries again. Returns the function that stops it: the run in
 * progress ends after its current batch, and the function waits for it.
 */
export function startJobsPurge(sql: postgres.Sql, intervalMs = PURGE_INTERVAL_MS): () => Promise<void> {
  let running: Promise<unknown> | null = null
  let stop = new AbortController()
  let run = () => {
    if (running) return
    let started = Date.now()
    running = purgeOldJobs(sql, { signal: stop.signal })
      .then((deleted) => {
        if (deleted > 0) log('info', 'jobs.purged', { deleted, days: RETENTION_DAYS, durationMs: Date.now() - started })
      })
      .catch((error) => log('error', 'jobs.purge_failed', { error: errorMessage(error) }))
      .finally(() => {
        running = null
      })
  }
  let timer = setInterval(run, intervalMs)
  timer.unref()
  run()
  return async () => {
    clearInterval(timer)
    stop.abort()
    await running
  }
}
