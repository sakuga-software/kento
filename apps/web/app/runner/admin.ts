import type postgres from 'postgres'

import type { JobKind } from '@sakuga-review/protocol'

/** A registration token lives this long. */
export const REGISTRATION_TTL_MINUTES = 60
/** A revoked runner stays on the screen this long, then leaves the list (its row stays). */
export const REVOKED_SHOWN_DAYS = 30
/** A registration token that expired without a runner stays on the screen this long. */
export const EXPIRED_SHOWN_DAYS = 7

/** A runner as the Runners screen shows it to a member of `orgId`. */
export interface RunnerView {
  id: string
  name: string
  labels: string[]
  version: string | null
  trusted: boolean
  /** Null: a runner of the service. The screen shows it, and only an operator manages it. */
  orgId: string | null
  revokedAt: Date | null
  lastSeenAt: Date | null
  createdAt: Date
  /** The job that it runs now, when that job belongs to the org on screen. */
  currentJob: { kind: JobKind; repo: string; prNumber: number; startedAt: Date | null } | null
  /** The jobs of the org that it ended in the last 24 hours. */
  jobs24h: number
}

/** A registration token of the org that no runner has used yet. */
export interface RegistrationView {
  id: string
  name: string
  labels: string[]
  trusted: boolean
  expiresAt: Date
  createdAt: Date
}

export interface RunnersScreen {
  /** The time of the database, so that every age on the screen has one clock. */
  now: Date
  runners: RunnerView[]
  registrations: RegistrationView[]
}

/** What the Runners screen reads and writes. Every write is for one org: an admin of another org changes nothing. */
export interface RunnersAdminStore {
  screen(orgId: string): Promise<RunnersScreen>
  createRegistration(input: {
    orgId: string
    userId: string | null
    name: string
    labels: string[]
    trusted: boolean
    tokenHash: string
  }): Promise<{ id: string; expiresAt: Date }>
  /**
   * Replaces an unused registration token of the org with a new one, with the same name, labels
   * and key mode. Null when there is no such token (used, or of another org).
   */
  renewRegistration(input: { orgId: string; registrationId: string; userId: string | null; tokenHash: string }): Promise<
    { id: string; name: string; labels: string[]; trusted: boolean; expiresAt: Date } | null
  >
  /** Deletes an unused registration token of the org: it stops working at once. */
  discardRegistration(orgId: string, registrationId: string): Promise<boolean>
  /** Sets the trust of a runner of the org that is not revoked. False when there is none. */
  setTrusted(orgId: string, runnerId: string, trusted: boolean): Promise<boolean>
  /**
   * Revokes a runner of the org: its token stops working at the next call, and its running jobs go
   * back to the queue at once, without spending an attempt. Null when there is no such runner, or
   * it is already revoked.
   */
  revoke(orgId: string, runnerId: string): Promise<{ name: string; requeued: string[] } | null>
}

function toDate(value: Date | string): Date
function toDate(value: Date | string | null): Date | null
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null
  return value instanceof Date ? value : new Date(value)
}

export function createRunnersAdminStore(sql: postgres.Sql): RunnersAdminStore {
  return {
    async screen(orgId) {
      let [clock] = await sql<{ now: Date | string }[]>`select now() as now`
      let runners = await sql<
        {
          id: string
          name: string
          labels: string[]
          version: string | null
          trusted: boolean
          orgId: string | null
          revokedAt: Date | string | null
          lastSeenAt: Date | string | null
          createdAt: Date | string
          jobKind: JobKind | null
          jobRepo: string | null
          jobPr: number | null
          jobStartedAt: Date | string | null
          jobs24h: string
        }[]
      >`
        select runners.id, runners.name, runners.labels, runners.version, runners.trusted,
          runners.org_id as "orgId", runners.revoked_at as "revokedAt", runners.last_seen_at as "lastSeenAt",
          runners.created_at as "createdAt",
          current.kind as "jobKind", current.full_name as "jobRepo", current.pr_number as "jobPr",
          current.started_at as "jobStartedAt",
          (select count(*) from jobs join repos on repos.id = jobs.repo_id
            where jobs.runner_id = runners.id and repos.org_id = ${orgId}
              and jobs.finished_at > now() - interval '24 hours') as "jobs24h"
        from runners
        left join lateral (
          select jobs.kind, repos.full_name, jobs.pr_number, jobs.started_at from jobs
          join repos on repos.id = jobs.repo_id
          where jobs.runner_id = runners.id and jobs.state = 'running' and repos.org_id = ${orgId}
          order by jobs.started_at desc nulls last
          limit 1
        ) current on true
        where (runners.org_id = ${orgId} or runners.org_id is null)
          and (runners.revoked_at is null or runners.revoked_at > now() - ${`${REVOKED_SHOWN_DAYS} days`}::interval)
        order by runners.revoked_at is not null, runners.name, runners.created_at`
      let registrations = await sql<
        { id: string; name: string; labels: string[]; trusted: boolean; expiresAt: Date | string; createdAt: Date | string }[]
      >`
        select id, name, labels, trusted, expires_at as "expiresAt", created_at as "createdAt"
        from runner_registrations
        where org_id = ${orgId} and used_at is null
          and expires_at > now() - ${`${EXPIRED_SHOWN_DAYS} days`}::interval
        order by created_at desc`
      return {
        now: toDate(clock!.now),
        runners: runners.map((row) => ({
          id: row.id,
          name: row.name,
          labels: row.labels,
          version: row.version,
          trusted: row.trusted,
          orgId: row.orgId,
          revokedAt: toDate(row.revokedAt),
          lastSeenAt: toDate(row.lastSeenAt),
          createdAt: toDate(row.createdAt),
          currentJob:
            row.jobKind && row.jobRepo && row.jobPr !== null
              ? { kind: row.jobKind, repo: row.jobRepo, prNumber: Number(row.jobPr), startedAt: toDate(row.jobStartedAt) }
              : null,
          jobs24h: Number(row.jobs24h),
        })),
        registrations: registrations.map((row) => ({
          ...row,
          expiresAt: toDate(row.expiresAt),
          createdAt: toDate(row.createdAt),
        })),
      }
    },

    async createRegistration({ orgId, userId, name, labels, trusted, tokenHash }) {
      let [row] = await sql<{ id: string; expiresAt: Date | string }[]>`
        insert into runner_registrations (org_id, name, labels, trusted, token_hash, created_by, expires_at)
        values (${orgId}, ${name}, ${labels}, ${trusted}, ${tokenHash}, ${userId},
          now() + ${`${REGISTRATION_TTL_MINUTES} minutes`}::interval)
        returning id, expires_at as "expiresAt"`
      return { id: row!.id, expiresAt: toDate(row!.expiresAt) }
    },

    async renewRegistration({ orgId, registrationId, userId, tokenHash }) {
      return sql.begin(async (tx) => {
        let [old] = await tx<{ name: string; labels: string[]; trusted: boolean }[]>`
          delete from runner_registrations
          where id = ${registrationId} and org_id = ${orgId} and used_at is null
          returning name, labels, trusted`
        if (!old) return null
        let [row] = await tx<{ id: string; expiresAt: Date | string }[]>`
          insert into runner_registrations (org_id, name, labels, trusted, token_hash, created_by, expires_at)
          values (${orgId}, ${old.name}, ${old.labels}, ${old.trusted}, ${tokenHash}, ${userId},
            now() + ${`${REGISTRATION_TTL_MINUTES} minutes`}::interval)
          returning id, expires_at as "expiresAt"`
        return { id: row!.id, ...old, expiresAt: toDate(row!.expiresAt) }
      })
    },

    async discardRegistration(orgId, registrationId) {
      let rows = await sql`
        delete from runner_registrations
        where id = ${registrationId} and org_id = ${orgId} and used_at is null
        returning id`
      return rows.length > 0
    },

    async setTrusted(orgId, runnerId, trusted) {
      let rows = await sql`
        update runners set trusted = ${trusted}, updated_at = now()
        where id = ${runnerId} and org_id = ${orgId} and revoked_at is null
        returning id`
      return rows.length > 0
    },

    async revoke(orgId, runnerId) {
      return sql.begin(async (tx) => {
        // The update locks the runner: a claim that holds it (FOR SHARE, in claimJob) ends first, and
        // its job is then running here and goes back to the queue. A later claim sees the revocation.
        let [runner] = await tx<{ name: string }[]>`
          update runners set revoked_at = now(), updated_at = now()
          where id = ${runnerId} and org_id = ${orgId} and revoked_at is null
          returning name`
        if (!runner) return null
        // The attempt of the revoked runner does not count: the job did nothing wrong. The runner
        // id stays, as the last runner of the job; its heartbeat and its result now get 401, and a
        // result already in flight finds the job queued (lease_lost).
        let requeued = await tx<{ id: string }[]>`
          update jobs set
            state = 'queued',
            attempts = greatest(attempts - 1, 0),
            lease_expires_at = null,
            not_before = null,
            started_at = null,
            updated_at = now()
          where runner_id = ${runnerId} and state = 'running'
          returning id`
        return { name: runner.name, requeued: requeued.map((row) => row.id) }
      })
    },
  }
}
