import type { Level } from '@sakuga-review/protocol'
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
  /**
   * REV-13. The cost limits of the whole org, in dollars: the reviews and resolutions of all its
   * repositories since the start of the UTC day, and of the UTC calendar month. At a limit, a new job
   * is not queued (a push gets the check « Kentō · plafond », a command a reply); a job already queued
   * or running finishes. Null: no limit.
   */
  dailyCapUsd: numeric('daily_cap_usd', { precision: 10, scale: 2 }),
  monthlyCapUsd: numeric('monthly_cap_usd', { precision: 10, scale: 2 }),
  /** The settings screen warns when the cost of the day or of the month reaches this percentage of its limit. */
  capAlertPct: smallint('cap_alert_pct').notNull().default(80),
  /**
   * REV-13. The lowercase bot logins whose pull requests, pushes and commands count as a person's.
   * It replaces the variable KENTO_TRUSTED_BOTS. An admin edits it in the settings.
   */
  trustedBots: text('trusted_bots').array().notNull().default(sql`'{sakuga-agent[bot]}'::text[]`),
  /** Each change of the settings of the org writes the next version; a form sent from an older one is refused. */
  settingsVersion: integer('settings_version').notNull().default(0),
  settingsUpdatedBy: uuid('settings_updated_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  settingsUpdatedAt: timestamp('settings_updated_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  check('orgs_cap_alert_pct_range', sql`${table.capAlertPct} between 1 and 100`),
  check('orgs_caps_not_negative', sql`coalesce(${table.dailyCapUsd}, 0) >= 0 and coalesce(${table.monthlyCapUsd}, 0) >= 0`),
])

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
export type ProviderModels = Partial<Record<Level, string[]>>

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
     * The provider of the org that the last claim gave the job (REV-11): with the key that the
     * service holds, or with the key of the runner for a runner-held provider (REV-31). Null: the key
     * of the service, or the provider was removed since. A result marks its state (valid, key refused).
     */
    providerId: uuid('provider_id').references(() => providers.id, { onDelete: 'set null' }),
    /** `X-GitHub-Delivery` of the webhook that created the job. A redelivery creates no job. */
    githubDeliveryId: text('github_delivery_id').unique(),
    /**
     * The comment of the pull request whose command created the job (`@kento-review heavy`), or null
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
    /** When the publisher took the failed job to post its comment on the pull request. Once per job. */
    failureNoticedAt: timestamp('failure_noticed_at', { withTimezone: true }),
    /**
     * REV-12. The config that the job applies, resolved (org, then repository) when it was queued: a
     * change of the config after that never changes a job in the queue. Null on a job queued before
     * the column: the runner then uses the levels of the engine.
     */
    config: jsonb('config'),
    /**
     * REV-19. The rules that the last claim sent to its runner (`JobRule[]` of the protocol), as they
     * were then. A finding of the result can cite one of these only, and keeps its title even when
     * the rule is changed or removed since. Null: no rule sent (a runner without the feature `rules`,
     * a resolve job, or a job claimed before the column).
     */
    sentRules: jsonb('sent_rules'),
    /**
     * REV-21. What chose the level of the job: `rule` (an assignment rule of the repository),
     * `preference` (the level of the author, REV-22), `repo` (the level of the config), `command` (a
     * command or « Relancer » on the screen of the pull request), `retry` (a retry from the
     * dashboard). Null on a job queued before the column.
     */
    levelSource: text('level_source'),
    /** REV-21. The assignment rule that chose the level, with `level_source` `rule`; null once it is removed. */
    assignmentRuleId: uuid('assignment_rule_id').references((): AnyPgColumn => assignmentRules.id, { onDelete: 'set null' }),
    /**
     * REV-59. An admin hid this failure on the dashboard: it leaves the banner and the list « Échecs
     * récents ». The counts of the week keep it. Null: shown.
     */
    failureDismissedAt: timestamp('failure_dismissed_at', { withTimezone: true }),
    /** REV-59. The login of the admin who hid the failure. */
    failureDismissedBy: text('failure_dismissed_by'),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    // A runner claims the oldest queued job.
    index('jobs_state_created_at_idx').on(table.state, table.createdAt),
    index('jobs_repo_pr_idx').on(table.repoId, table.prNumber),
    // The Runners screen (REV-54) counts the jobs of each runner finished in the last 24 hours. The
    // prefix runner_id also serves each read by runner and the `on delete set null` of a runner (REV-65).
    index('jobs_runner_finished_idx').on(table.runnerId, table.finishedAt),
    // The removal of a provider sets the provider of its jobs to null.
    index('jobs_provider_id_idx').on(table.providerId),
    // The sweep of the expired leases reads the running jobs only.
    index('jobs_running_lease_idx').on(table.leaseExpiresAt).where(sql`${table.state} = 'running'`),
    // The dashboard (REV-14) reads the recent failures of the repositories of an org.
    index('jobs_failed_repo_finished_idx').on(table.repoId, table.finishedAt).where(sql`${table.state} = 'failed'`),
    check('jobs_pr_number_positive', sql`${table.prNumber} > 0`),
    check('jobs_attempts_not_negative', sql`${table.attempts} >= 0`),
    check('jobs_level_source', sql`${table.levelSource} in ('rule', 'preference', 'repo', 'command', 'retry')`),
    // The removal of an assignment rule sets the rule of its jobs to null.
    index('jobs_assignment_rule_id_idx').on(table.assignmentRuleId).where(sql`${table.assignmentRuleId} is not null`),
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
    // The dashboard (REV-14): the last reviews and the cost of the day and the month of an org.
    index('reviews_repo_created_at_idx').on(table.repoId, table.createdAt),
    // The Repos list (REV-53): the last published reviews of each repo of a page, read in order.
    // NULLS FIRST is the default of DESC in Postgres: the index then gives the order of the query.
    index('reviews_repo_published_idx')
      .on(table.repoId, table.publishedAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(sql`${table.githubReviewId} is not null`),
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
  (table) => [
    uniqueIndex('resolutions_job_id_idx').on(table.jobId),
    index('resolutions_repo_pr_idx').on(table.repoId, table.prNumber),
    // The dashboard (REV-14): the cost of the day and the month of an org.
    index('resolutions_repo_created_at_idx').on(table.repoId, table.createdAt),
  ],
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

/**
 * REV-13. One webhook delivery that passed the signature: what the settings show as the last event
 * and the failures of the last 24 hours. A delivery with a bad signature has no row: nothing in it
 * can be trusted, not even its installation. Rows older than 30 days are deleted at each insert.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `X-GitHub-Delivery`. A redelivery from the page of the App has the same id: it gets a row too. */
    deliveryId: text('delivery_id').notNull(),
    /** From `installation.id` of the payload. Null: an event without an installation (`ping`). */
    githubInstallationId: bigint('github_installation_id', { mode: 'number' }),
    event: text('event').notNull(),
    action: text('action'),
    /** The HTTP status of the answer: 2xx applied or ignored, 400 invalid, 500 failed. */
    status: smallint('status').notNull(),
    /** `queued`, `skipped`, `ignored`, `invalid`, `failed`… */
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('webhook_deliveries_installation_idx').on(table.githubInstallationId, table.receivedAt),
    index('webhook_deliveries_received_at_idx').on(table.receivedAt),
  ],
)

/**
 * REV-16. The status of a finding on its pull request.
 *
 * - `open`: the last review found it, or no review since showed that it is gone.
 * - `fixed`: a review did not find it again, and its file changed since the review that last found it.
 * - `stale`: the pull request closed while the finding was open.
 * - `dismissed`: a person said that it is wrong (with a reason, or a 👎 on its comment). It never
 *   gets a comment again, even when a review finds it again.
 * - `wontfix`: a person said that it is right, and that it stays.
 */
export const findingStatus = pgEnum('finding_status', ['open', 'fixed', 'stale', 'dismissed', 'wontfix'])

/** What changed the status of a finding. `reopened`: back to `open`, by a review or by a person. */
export const findingEventType = pgEnum('finding_event_type', ['opened', 'reopened', 'fixed', 'stale', 'dismissed', 'wontfix'])

/**
 * REV-16. A finding of a pull request, from the first review that found it to its last status. The
 * reviews of the next pushes find it again by its fingerprint: the path, the rule or the title, and
 * the code around its line (packages/engine/src/fingerprint.ts). Its fields (line, severity, title)
 * are those of the last review that found it.
 */
export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number').notNull(),
    /** 16 hexadecimal characters. A review finds the finding again by it first. */
    fingerprint: text('fingerprint').notNull(),
    /**
     * The key of the finding in the hidden marker of its comment (`findingKey` of the engine: the
     * path and the title). A review finds the finding again by it when the fingerprint changed.
     */
    key: text('key').notNull(),
    /**
     * REV-19. The rule that the finding applies, when it has one: the fingerprint then reads it instead
     * of the title. The removal of the rule keeps the finding and sets this to null (REV-55).
     */
    ruleId: uuid('rule_id').references((): AnyPgColumn => rules.id, { onDelete: 'set null' }),
    path: text('path').notNull(),
    line: integer('line').notNull(),
    title: text('title').notNull(),
    severity: text('severity').notNull(),
    category: text('category').notNull(),
    confidence: smallint('confidence').notNull(),
    status: findingStatus('status').notNull().default('open'),
    /** Why a person dismissed the finding, or said that it stays. */
    statusReason: text('status_reason'),
    firstReviewId: uuid('first_review_id').references(() => reviews.id, { onDelete: 'set null' }),
    lastReviewId: uuid('last_review_id').references(() => reviews.id, { onDelete: 'set null' }),
    /** The head of the first review that found it. */
    firstSeenSha: text('first_seen_sha').notNull(),
    /** The head of the last review that found it: a file that changed since then can show it fixed. */
    lastSeenSha: text('last_seen_sha').notNull(),
    /** The first comment of its thread on GitHub, or null when the finding has no inline comment. */
    githubCommentId: bigint('github_comment_id', { mode: 'number' }),
    /** The node id of its review thread (`PRRT_…`). */
    githubThreadId: text('github_thread_id'),
    /** When the sweep last read the reactions of its comment (a 👎 dismisses it). */
    reactionsCheckedAt: timestamp('reactions_checked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // A review reads the findings of its pull request.
    index('findings_repo_pr_idx').on(table.repoId, table.prNumber),
    // The lists of findings (REV-17, REV-18) page by creation, newest first.
    index('findings_repo_created_at_idx').on(table.repoId, table.createdAt, table.id),
    // The sweep of the reactions reads the open findings that have a comment.
    index('findings_open_comment_idx')
      .on(table.reactionsCheckedAt)
      .where(sql`${table.status} = 'open' and ${table.githubCommentId} is not null`),
    // The removal of a review sets these to null; REV-18 reads the findings of a review.
    index('findings_first_review_idx').on(table.firstReviewId),
    index('findings_last_review_idx').on(table.lastReviewId),
    // The removal of a rule sets the rule of its findings to null.
    index('findings_rule_idx').on(table.ruleId).where(sql`${table.ruleId} is not null`),
    check('findings_pr_number_positive', sql`${table.prNumber} > 0`),
    check('findings_severity', sql`${table.severity} in ('critical', 'major', 'minor')`),
    check('findings_confidence_range', sql`${table.confidence} between 0 and 100`),
    check('findings_reason_with_status', sql`${table.statusReason} is null or ${table.status} in ('dismissed', 'wontfix')`),
  ],
)

/**
 * REV-16. Each change of the status of a finding: the review that made it (null for a person or the
 * sweep), its type, and who: `kento`, or the GitHub login of a person.
 */
export const findingEvents = pgTable(
  'finding_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    findingId: uuid('finding_id')
      .notNull()
      .references(() => findings.id, { onDelete: 'cascade' }),
    reviewId: uuid('review_id').references(() => reviews.id, { onDelete: 'set null' }),
    type: findingEventType('type').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    /**
     * REV-94. Where the change of a person came from: `command` for `@kento-review reject` on
     * GitHub. Null for the other events: a screen of Kentō, a 👎, a review.
     */
    source: text('source'),
    createdAt: createdAt(),
  },
  (table) => [
    index('finding_events_finding_created_at_idx').on(table.findingId, table.createdAt, table.id),
    index('finding_events_review_idx').on(table.reviewId),
  ],
)

/**
 * REV-19. A rule of a repository (`repo_id` set) or of its whole org (`repo_id` null). An admin writes
 * it on the Config screen of the repository or in the settings of the org. The claim of a review job
 * sends the active rules of the repository and of its org to a runner that reads them; the engine
 * keeps those whose paths the diff touches. A rule never comes from the code of a pull request.
 *
 * - `paths`: globs of the paths that it covers (`**` style). Empty: every path.
 * - `severity_floor`: a finding that cites the rule has at least this severity. Null: no floor.
 * - `active`: false stops sending the rule. `disabled_by` and `disabled_at` say who and when.
 * - `version`: each change writes the next one; a form sent from an older version is refused.
 */
export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    paths: text('paths').array().notNull().default(sql`'{}'::text[]`),
    severityFloor: text('severity_floor'),
    active: boolean('active').notNull().default(true),
    disabledBy: uuid('disabled_by').references(() => users.id, { onDelete: 'set null' }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // The rules of a repository, and the rules of an org (no repository): the two reads of a claim.
    index('rules_repo_id_idx').on(table.repoId).where(sql`${table.repoId} is not null`),
    index('rules_org_id_idx').on(table.orgId).where(sql`${table.repoId} is null`),
    check('rules_title_length', sql`char_length(${table.title}) between 1 and 200`),
    check('rules_body_length', sql`char_length(${table.body}) between 1 and 4000`),
    check('rules_paths_count', sql`cardinality(${table.paths}) <= 20`),
    check('rules_severity_floor', sql`${table.severityFloor} is null or ${table.severityFloor} in ('critical', 'major', 'minor')`),
    check('rules_disabled_when_inactive', sql`${table.active} = (${table.disabledAt} is null)`),
  ],
)

/**
 * REV-52. The comment « Kentō · review en attente » of a pull request: one per pull request, found
 * on GitHub by `<!-- kento:queued <repo id>#<number> -->`. The publisher writes it while a job of
 * the pull request waits in the queue for too long, and deletes it, then this row, once no job
 * waits for too long.
 *
 * - `github_comment_id`: null until GitHub answered the comment. A row without it looks for the
 *   marker first: a comment posted with no answer (a restart, a lost answer) is reused.
 * - `body`: the body that GitHub has. The publisher edits the comment only when it changes.
 * - `gone_at`: a person deleted the comment. It is not posted again while this row lives.
 */
export const queueNotices = pgTable(
  'queue_notices',
  {
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number').notNull(),
    githubCommentId: bigint('github_comment_id', { mode: 'number' }),
    body: text('body'),
    goneAt: timestamp('gone_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.prNumber] })],
)

/**
 * REV-22. The author of each pull request that Kentō saw: the event of a push or the comment of a
 * command writes it. The screen of a user reads « Mes PR reviewées » and « Findings reçus » from it,
 * and the Findings screen filters on it.
 */
export const pullAuthors = pgTable(
  'pull_authors',
  {
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number').notNull(),
    /** The id of the GitHub account: it never changes, unlike the login. */
    githubId: bigint('github_id', { mode: 'number' }).notNull(),
    /** The login when Kentō last saw the pull request. */
    login: text('login').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.repoId, table.prNumber] }),
    // The pull requests of one person, for the screen of a user and the filter of the Findings screen.
    index('pull_authors_github_id_idx').on(table.githubId),
  ],
)

/**
 * REV-22. What a person sets for the reviews of their own pull requests, for every repository (no
 * `repo_id`) or for one repository, which wins. `auto_review` false: a push of their pull request
 * queues no job, a command still does. `level` null: the level of the repository.
 *
 * The order: a rule of assignment of the repository (REV-21) before these, these before the
 * level of the repository.
 */
export const userPrefs = pgTable(
  'user_prefs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    autoReview: boolean('auto_review').notNull().default(true),
    level: reviewLevel('level'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One row for every repository, and one per repository.
    uniqueIndex('user_prefs_global_idx').on(table.userId).where(sql`${table.repoId} is null`),
    uniqueIndex('user_prefs_repo_idx').on(table.userId, table.repoId).where(sql`${table.repoId} is not null`),
  ],
)

/**
 * REV-21. The assignment rules of a repository: who and what sets the level of the review of a push.
 * The webhook reads them in `position` order, and the first one that matches wins; with none, the
 * level of the config applies. A condition holds when every list that is not empty has a match:
 * the author (a GitHub login), a changed path (a glob, as the paths of the config), a label of the
 * pull request. `action` `command_only`: no job for a push, only a command creates one.
 */
export const assignmentRules = pgTable(
  'assignment_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    authors: text('authors').array().notNull().default(sql`'{}'::text[]`),
    paths: text('paths').array().notNull().default(sql`'{}'::text[]`),
    labels: text('labels').array().notNull().default(sql`'{}'::text[]`),
    action: text('action').notNull(),
    level: reviewLevel('level'),
    /** A GitHub login that the published review mentions, or null. */
    mention: text('mention'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One rule per place of a repository: the order has no tie.
    uniqueIndex('assignment_rules_repo_position_idx').on(table.repoId, table.position),
    check('assignment_rules_action', sql`${table.action} in ('review', 'command_only')`),
    check('assignment_rules_level', sql`(${table.action} = 'review') = (${table.level} is not null)`),
    check('assignment_rules_condition', sql`cardinality(${table.authors}) + cardinality(${table.paths}) + cardinality(${table.labels}) > 0`),
    check('assignment_rules_counts', sql`cardinality(${table.authors}) <= 20 and cardinality(${table.paths}) <= 20 and cardinality(${table.labels}) <= 20`),
    // 1 to 20, the places of the screen. 0: the place of a rule that moves, inside one transaction only.
    check('assignment_rules_position', sql`${table.position} between 0 and 20`),
  ],
)

/**
 * REV-59. The last close of each pull request that Kentō saw, merged or not. The dashboard shows no
 * failure of a job created before it: the pull request is done. A reopen queues a new job, created
 * after the close, and its failure shows again.
 */
export const pullClosures = pgTable(
  'pull_closures',
  {
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.prNumber] })],
)
