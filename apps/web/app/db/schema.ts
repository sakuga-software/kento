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
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

// The tables of milestone M2 only: orgs, repos, runners, jobs, reviews. Later tickets add their own tables
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
  /**
   * The config of the org: what its repositories inherit (`ConfigOverrides` of app/repo-config). A
   * key that it does not hold takes the value of Kentō. The settings of the org (REV-13) write it.
   */
  config: jsonb('config').notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/**
 * The review workflow that a repository still runs, as the Repos screen reads it on GitHub: none, a
 * workflow that calls `review.yml` of sakuga-review (`reusable`), or a copy of its job (`copy`).
 */
export const workflowMode = pgEnum('workflow_mode', ['none', 'reusable', 'copy'])

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
    /**
     * No job is created for a repository that is not enabled. An admin sets it on the Repos screen
     * (REV-9); an event of GitHub never changes it.
     */
    enabled: boolean('enabled').notNull().default(false),
    defaultLevel: reviewLevel('default_level').notNull().default('lite'),
    /** From GitHub, at the last check of the Repos screen. Null before the first one. */
    private: boolean('private'),
    defaultBranch: text('default_branch'),
    /** The review workflow of the repository at the last check. Null before the first one. */
    workflow: workflowMode('workflow'),
    /** The path of that workflow file, `.github/workflows/sakuga-review.yml`. */
    workflowPath: text('workflow_path'),
    /** The ref after `review.yml@` in a calling workflow: `stable`, or a SHA. */
    workflowRef: text('workflow_ref'),
    workflowCheckedAt: timestamp('workflow_checked_at', { withTimezone: true }),
    /**
     * The label that a runner must carry to run the jobs of this repository. Null: any runner of the
     * org, or of the service.
     */
    defaultRunnerPool: text('default_runner_pool'),
    /**
     * REV-12. What the repository sets itself on its Config screen (`ConfigOverrides` of
     * app/repo-config): a key that it does not hold is inherited from the org. Each change writes the
     * next version, its author and its date; a form sent from an older version is refused.
     */
    config: jsonb('config').notNull().default({}),
    configVersion: integer('config_version').notNull().default(0),
    configUpdatedBy: uuid('config_updated_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    configUpdatedAt: timestamp('config_updated_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('repos_org_id_idx').on(table.orgId)],
)

/**
 * A machine that runs jobs. It registers once with a registration token, and gets a runner token
 * that the service shows once and keeps only as a hash. Setting `revoked_at` refuses the token at
 * the next call.
 */
export const runners = pgTable(
  'runners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The org whose admin made its registration token in the Runners screen: the runner runs the
     * jobs of this org only. Null: a runner of the service, registered with
     * KENTO_RUNNER_REGISTRATION_TOKEN; it runs the jobs of every org, and only an operator manages it.
     */
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    /** The name that the runner gave at its registration. Two runners can have the same name. */
    name: text('name').notNull(),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    /** The version of the runner, at its registration. */
    version: text('version'),
    /** SHA-256 of the runner token, in hex. The token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    /**
     * A trusted runner without its own model key gets the key of the service with each job. An
     * admin of its org sets it in the Runners screen, or its registration token sets it (key mode
     * « app »). A runner of the service: only an operator sets it, in the database.
     */
    trusted: boolean('trusted').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('runners_org_id_idx').on(table.orgId)],
)

/**
 * A registration token made in the Runners screen. It is shown once, kept only as a hash, works
 * once, and ends after one hour. The name, the labels and the key mode of the runner are fixed in
 * it: the runner cannot choose them.
 */
export const runnerRegistrations = pgTable(
  'runner_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    /** Key mode « app »: the runner is trusted, and gets the model key of the service. */
    trusted: boolean('trusted').notNull(),
    /** SHA-256 of the registration token, in hex. The token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set by the registration of the runner: the token never works twice. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    runnerId: uuid('runner_id').references(() => runners.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [index('runner_registrations_org_id_idx').on(table.orgId)],
)

/** The API of a provider of models (packages/engine/src/providers.ts). */
export const providerKind = pgEnum('provider_kind', ['openrouter', 'anthropic', 'openai_compatible', 'ollama'])

/** The models of a provider at each level, the first one first. A level that is not here: the defaults of the kind. */
export type ProviderModels = Partial<Record<'lite' | 'balanced' | 'heavy', string[]>>

/**
 * A provider of models of an org, with its key encrypted (REV-11). The key is AES-256-GCM under the
 * master key of the environment (`app/providers/secrets.ts`), bound to the id and the org of the
 * row: a ciphertext copied to another row does not decrypt. The service decrypts it only to give
 * it to a trusted runner of the org for one job, or to test it from the screen; the browser and the
 * logs never get it.
 */
export const providers = pgTable(
  'providers',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    kind: providerKind('kind').notNull(),
    label: text('label').notNull(),
    /** Null: the URL of the kind. A server of the OpenAI API needs one. */
    baseUrl: text('base_url'),
    /** `v1:<key id>:<iv>:<ciphertext and tag>`. Null when the runner holds the key or the server. */
    keyCiphertext: text('key_ciphertext'),
    /** The last 4 characters of the key: what the screen shows. */
    keyLast4: text('key_last4'),
    keySetAt: timestamp('key_set_at', { withTimezone: true }),
    /** The runner holds the key (or the server, for Ollama): the service never has it. */
    runnerHeld: boolean('runner_held').notNull().default(false),
    /** The provider of the jobs of the org. One per org at most; none: the key of the service. */
    isDefault: boolean('is_default').notNull().default(false),
    models: jsonb('models').$type<ProviderModels>().notNull().default({}),
    /** The last call that the provider answered: a job, or a test from the screen. */
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    /** The first refusal of the key (401, 403) since the last call that worked. */
    refusedAt: timestamp('refused_at', { withTimezone: true }),
    refusedStatus: smallint('refused_status'),
    refusedMessage: text('refused_message'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('providers_org_id_idx').on(table.orgId),
    uniqueIndex('providers_org_default_idx').on(table.orgId).where(sql`${table.isDefault}`),
    // A key held by the service, or none: never both, never a half.
    check('providers_key_or_runner', sql`(${table.runnerHeld} and ${table.keyCiphertext} is null) or (not ${table.runnerHeld} and ${table.keyCiphertext} is not null)`),
    check('providers_last4_with_key', sql`(${table.keyCiphertext} is null) = (${table.keyLast4} is null)`),
    check('providers_ollama_on_runner', sql`${table.kind} <> 'ollama' or ${table.runnerHeld}`),
  ],
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
    /**
     * The base branch of the pull request: the runner diffs the head from its merge base with it.
     * Null on a job created before the column; a runner never claims such a job.
     */
    baseRef: text('base_ref'),
    /** The runner that claimed the job. */
    runnerId: uuid('runner_id').references(() => runners.id, { onDelete: 'set null' }),
    /**
     * The provider of the org that the last claim gave the job (REV-11). Null: the key of the
     * service, or the provider was removed since. A result marks its state (valid, key refused).
     */
    providerId: uuid('provider_id').references(() => providers.id, { onDelete: 'set null' }),
    /** `X-GitHub-Delivery` of the webhook that created the job. A redelivery creates no job. */
    githubDeliveryId: text('github_delivery_id').unique(),
    /**
     * The comment of the pull request whose command created the job (`@kento review heavy`), or null
     * for the review of a push. One comment creates one job at most, whatever its deliveries.
     */
    githubCommentId: bigint('github_comment_id', { mode: 'number' }).unique(),
    /** When the comment of the command got its last reaction: 🚀 after the publication, 😕 on a failure. */
    commandAnsweredAt: timestamp('command_answered_at', { withTimezone: true }),
    /** The number of claims of the job. Each claim is one attempt; the runner sends its number back. */
    attempts: smallint('attempts').notNull().default(0),
    /** While `running`: the end of the lease of the runner. With no heartbeat after it, the job goes back to the queue. */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    /** A job queued again after an expired lease waits until then before a runner can claim it (backoff). */
    notBefore: timestamp('not_before', { withTimezone: true }),
    failureReason: text('failure_reason'),
    /**
     * REV-12. The config that the job applies, resolved (org, then repository) when it was queued: a
     * change of the config after that never changes a job in the queue. Null on a job queued before
     * the column: the runner then uses the levels of the engine.
     */
    config: jsonb('config'),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    // A runner claims the oldest queued job.
    index('jobs_state_created_at_idx').on(table.state, table.createdAt),
    index('jobs_repo_pr_idx').on(table.repoId, table.prNumber),
    index('jobs_runner_id_idx').on(table.runnerId),
    // The removal of a provider sets the provider of its jobs to null.
    index('jobs_provider_id_idx').on(table.providerId),
    // The sweep of the expired leases reads the running jobs only.
    index('jobs_running_lease_idx').on(table.leaseExpiresAt).where(sql`${table.state} = 'running'`),
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

/**
 * The result of a resolve job, before and after its publication on GitHub: the verdict of the model
 * on each thread. The publisher posts the replies, resolves the threads and posts the summary once:
 * it sets `published_at` before it writes, so a failure in the middle never posts twice.
 */
export const resolutions = pgTable(
  'resolutions',
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
    /** Null when no thread waited: no model call. */
    model: text('model'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
    /** The result of the runner, as the protocol gives it (`ResolvePayload`). */
    result: jsonb('result').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('resolutions_job_id_idx').on(table.jobId), index('resolutions_repo_pr_idx').on(table.repoId, table.prNumber)],
)

/** The role of a person in an org, as GitHub gives it: an admin edits, a member reads. */
export const orgRole = pgEnum('org_role', ['admin', 'member'])

/** A person who signed in with GitHub. Kentō keeps no GitHub token of theirs. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The id of the GitHub account: it never changes, unlike the login. */
  githubId: bigint('github_id', { mode: 'number' }).notNull().unique(),
  login: text('login').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/**
 * The role of a user in an org, read from GitHub at sign-in and again when `checked_at` is older
 * than a few minutes. GitHub is the source: a row is a cache, deleted when GitHub says the person
 * left the org.
 */
export const memberships = pgTable(
  'memberships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.orgId] }), index('memberships_org_id_idx').on(table.orgId)],
)

/**
 * A browser session. The cookie holds a random id, signed; the table keeps only its SHA-256, so a
 * copy of the table opens no session. A row ends at `expires_at`, at sign-out, or with its user.
 */
export const sessions = pgTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** The data of `remix/session`: the signed-in user, the CSRF token, the org on screen. */
    data: jsonb('data').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId), index('sessions_expires_at_idx').on(table.expiresAt)],
)
