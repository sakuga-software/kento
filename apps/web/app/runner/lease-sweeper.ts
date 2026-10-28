import { errorMessage, log } from '../log.ts'
import type { ExpiredLeases, RunnerStore } from './store.ts'

/** How often the service looks for expired leases. A dead runner's job waits at most this much more. */
export const LEASE_SWEEP_SECONDS = 15

/** Runs one sweep and logs each job that it queued again or failed. */
export async function sweepExpiredLeases(store: Pick<RunnerStore, 'expireLeases'>): Promise<ExpiredLeases> {
  let swept = await store.expireLeases()
  for (let job of swept.requeued) {
    log('warn', 'job.lease_expired', { jobId: job.id, runnerId: job.runnerId, attempts: job.attempts, state: 'queued' })
  }
  for (let job of swept.failed) {
    log('error', 'job.lease_expired', { jobId: job.id, runnerId: job.runnerId, attempts: job.attempts, state: 'failed' })
  }
  return swept
}

/**
 * Sweeps the expired leases every `intervalMs`, one sweep at a time. An error of the database is
 * logged, and the next tick tries again. Returns the function that stops it and waits for the sweep
 * in progress.
 */
export function startLeaseSweeper(
  store: Pick<RunnerStore, 'expireLeases'>,
  intervalMs = LEASE_SWEEP_SECONDS * 1000,
): () => Promise<void> {
  let running: Promise<unknown> | null = null
  let timer = setInterval(() => {
    if (running) return
    running = sweepExpiredLeases(store)
      .catch((error) => log('error', 'job.lease_sweep_failed', { error: errorMessage(error) }))
      .finally(() => {
        running = null
      })
  }, intervalMs)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await running
  }
}
