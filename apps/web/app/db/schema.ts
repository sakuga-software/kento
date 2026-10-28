import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// The tables of milestone M2 only: orgs, repos, jobs, reviews. Later tickets add their own tables
// and columns with new migrations (`pnpm -F @sakuga-review/web db:generate`).

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

/** The level of a review, as in `@sakuga-review review [lite|balanced|heavy]`. */
export const reviewLevel = pgEnum('review_level', ['lite', 'balanced', 'heavy'])

/** What a job does: review a pull request, or resolve its review threads. */
export const jobKind = pgEnum('job_kind', ['review', 'resolve'])

/** The life of a job: queued → running → done | failed, or cancelled by a newer push. */
export const jobState = pgEnum('job_state', ['queued', 'running', 'done', 'failed', 'cancelled'])

/** One installation of the GitHub App, on an organization or a user account. */
export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  githubInstallationId: bigint('github_installation_id', { mode: 'number' }).notNull().unique(),
  githubAccountId: bigint('github_account_id', { mode: 'number' }).notNull(),
  login: text('login').notNull(),
  /** Set when GitHub reports the installation as suspended or deleted. */
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** A repository that the installation of an org can see. */
export const repos = pgTable(
  'repos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    githubRepoId: bigint('github_repo_id', { mode: 'number' }).notNull().unique(),
    /** `owner/name`. It changes when the repository is renamed or moved. */
    fullName: text('full_name').notNull(),
    /** No job is created for a repository that is not enabled. */
    enabled: boolean('enabled').notNull().default(false),
    defaultLevel: reviewLevel('default_level').notNull().default('lite'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('repos_org_id_idx').on(table.orgId)],
)

/** A unit of work for a runner: one review or one resolve on one head of a pull request. */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    kind: jobKind('kind').notNull().default('review'),
    level: reviewLevel('level').notNull(),
    state: jobState('state').notNull().default('queued'),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    /** `X-GitHub-Delivery` of the webhook that created the job. A redelivery creates no job. */
    githubDeliveryId: text('github_delivery_id').unique(),
    attempts: smallint('attempts').notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    // A runner claims the oldest queued job.
    index('jobs_state_created_at_idx').on(table.state, table.createdAt),
    index('jobs_repo_pr_idx').on(table.repoId, table.prNumber),
    check('jobs_pr_number_positive', sql`${table.prNumber} > 0`),
    check('jobs_attempts_not_negative', sql`${table.attempts} >= 0`),
  ],
)

/** The result of a review job, before and after its publication on GitHub. */
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    /** From 1 to 5, as in the label `review: N/5`. */
    score: smallint('score').notNull(),
    model: text('model').notNull(),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    /** The result of the engine (summary, findings), as the runner sent it. */
    result: jsonb('result').notNull(),
    githubReviewId: bigint('github_review_id', { mode: 'number' }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('reviews_job_id_idx').on(table.jobId),
    index('reviews_repo_pr_idx').on(table.repoId, table.prNumber),
    check('reviews_score_range', sql`${table.score} between 1 and 5`),
  ],
)
