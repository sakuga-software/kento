/**
 * The messages between the Kentō web service and its runners, and their checks. The web service
 * checks every body that a runner sends; the runner checks every job that the service sends.
 *
 * A runner speaks to the service in HTTPS, outbound only:
 *
 * 1. `POST /api/runner/register` with the registration token → a runner token, shown once.
 * 2. `POST /api/runner/jobs/claim` → 200 with a job, or 204 after the long poll with no job.
 * 3. `POST /api/runner/jobs/:id/heartbeat` every 30 s while it works → the new end of the lease, or
 *    `cancel: true` when the job is no longer wanted.
 * 4. `POST /api/runner/jobs/:id/result` → the review, or the reason of the failure.
 *
 * Each claim of a job is one attempt, with its number in `Job.attempt`. The heartbeat and the result
 * send it back. When a lease ends with no heartbeat, the service queues the job again for a new
 * attempt: the runner of the old attempt then gets 409 `lease_lost`, and its result is never stored.
 *
 * Every call after the registration sends `Authorization: Bearer <runner token>`.
 *
 * Node 26 or later runs this code as is: no build. Keep to erasable TypeScript syntax.
 */
import { arr, bool, int, nullable, num, obj, oneOf, optional, run, str, tagged, tuple2, type Checked } from './check.ts';

export type { Checked } from './check.ts';

/** The paths of the API, under the URL of the service. */
export const PATHS = {
  register: '/api/runner/register',
  claim: '/api/runner/jobs/claim',
  heartbeat: (jobId: string) => `/api/runner/jobs/${jobId}/heartbeat`,
  result: (jobId: string) => `/api/runner/jobs/${jobId}/result`,
} as const;

/** How long the service holds a claim open when no job is queued. */
export const CLAIM_WAIT_SECONDS = 30;
/** A claim or a heartbeat gives the runner the job for this long. */
export const LEASE_SECONDS = 120;
/** A job is claimed at most this many times. The service fails it when the last lease ends. */
export const MAX_ATTEMPTS = 2;
/** The runner sends a heartbeat this often while it works on a job. */
export const HEARTBEAT_SECONDS = 30;
/** The largest body that the service reads from a runner. */
export const MAX_BODY_BYTES = 1_000_000;

/** A runner token starts with this prefix, so that a secret scanner can find a leaked one. */
export const RUNNER_TOKEN_PREFIX = 'kento_rt_';

/**
 * True when `value` is one of `list`. It narrows a string read from a form, a URL, a comment or the
 * environment to the type of the list.
 */
export function isOneOf<const T extends readonly string[]>(list: T, value: unknown): value is T[number] {
  return typeof value === 'string' && list.includes(value);
}

export const LEVELS = ['lite', 'balanced', 'heavy'] as const;
export type Level = (typeof LEVELS)[number];
export const isLevel = (value: unknown): value is Level => isOneOf(LEVELS, value);

/** The severities of a finding, the most severe first. */
export const SEVERITIES = ['critical', 'major', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const CATEGORIES = ['bug', 'security', 'data', 'contract', 'test'] as const;
export type Category = (typeof CATEGORIES)[number];
export const VERDICTS = ['REQUEST_CHANGES', 'APPROVE', 'COMMENT'] as const;

/**
 * The providers of models that a runner can call (packages/engine/src/providers.ts). A runner of an
 * earlier release knows `openrouter` only.
 */
export const PROVIDER_KINDS = ['openrouter', 'anthropic', 'openai_compatible', 'ollama'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export const isProviderKind = (value: unknown): value is ProviderKind => isOneOf(PROVIDER_KINDS, value);

/**
 * What a runner can read in a job beyond the first release. A runner of an earlier release sends
 * none, and gets jobs of the first shape only: `obj()` refuses a key that it does not know.
 *
 * - `providers`: the job can carry `providers` (several kinds of provider, their base URL and their
 *   models), and the result of a failure can carry `providerStatus`, and a review its `costSource`.
 * - `models`: the job can carry `models`, the provider and the models that the config of its
 *   repository chose for its level (REV-12).
 * - `rules`: a review job can carry `rules`, the active rules of its repository and of its org
 *   (REV-19), and a finding of the result can cite one with `rule_id`.
 * - `threads`: a review job can carry `threads`, the open threads of the bot that someone answered
 *   (REV-71). The review reads their replies as data.
 * - `reuse`: a review job carries `reuse`, the reuse key of the last review of the pull request
 *   (REV-89). The runner then sends `diffHash`, `reuseKey` and `cachedTokens` with a review, and the
 *   outcome `unchanged` when the key of the head is the same: no model call.
 * - `rejected-severity`: each rejected finding of the job can carry its `severity`. A runner of REV-95
 *   reads `rejected` strictly and would refuse the key: the service sends it only with this feature.
 * - `rejected`: a review job can carry `rejected`, the findings of the pull request that a person set
 *   aside (REV-95). The review reads their causes as data.
 * - `delta`: `reuse` can carry `delta` (REV-88), and the runner then reviews only the files that
 *   changed since that head, and sends `delta` with its review.
 * - `earlier`: a review job can carry `earlier`, every finding of the pull request whatever its
 *   status (REV-99). A finding of the result can then name the finding that it continues with
 *   `follows`.
 * - `reviewed`: a review job can carry `reviewed`, the last commit that a review of Kentō read on the
 *   pull request (REV-100). A finding of the result can then say with `seen` that its code did not
 *   change since.
 * - `refuted`: a review can carry `refutedThreads`, the answered threads of the job that the model
 *   called refuted (REV-96). A service of an earlier release refuses the claim of this feature, and
 *   so never receives the field.
 * - `patch`: a finding of the result can carry `patch`, a short diff of its fix (REV-104), and so can
 *   a finding of `delta`. A service of an earlier release refuses the claim of this feature, and so
 *   never receives the field.
 */
export const FEATURES = ['providers', 'models', 'rules', 'threads', 'reuse', 'rejected', 'delta', 'rejected-severity', 'earlier', 'reviewed', 'refuted', 'patch'] as const;
export type Feature = (typeof FEATURES)[number];

/** Where the cost of a call comes from: the provider, the price table, a free local model, or nowhere (0). */
export const COST_SOURCES = ['provider', 'table', 'free', 'unknown'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

/** A uuid as Postgres writes it: lower case. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** REV-89. The hash of the reviewed files of a diff, and the key of the whole input of a review (packages/engine/src/reuse.ts). */
export const DIFF_HASH = /^[0-9a-f]{16}$/;
export const REUSE_KEY = /^[0-9a-f]{64}$/;
/** The id of a git commit: SHA-1 (40 characters) or SHA-256 (64), lower case. */
export const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** The id of a provider in a job: `service`, or the uuid of a provider of the org. */
const PROVIDER_ID = new RegExp(`^(service|${UUID.source.slice(1, -1)})$`);

const uuid = str({ max: 36, pattern: UUID });
const sha = str({ max: 64, pattern: SHA });
const label = str({ min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
const isoDate = str({ max: 40, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/ });
const text = (max: number) => str({ max });

// --- Register ---------------------------------------------------------------------------------

export type RegisterRequest = { name: string; labels: string[]; version: string };
export type RegisterResponse = { runnerId: string; token: string };

const registerRequest = obj({
  name: str({ min: 1, max: 100, pattern: /^[A-Za-z0-9._-]+$/ }),
  labels: arr(label, { max: 20 }),
  version: str({ min: 1, max: 50 }),
});
const registerResponse = obj({ runnerId: uuid, token: str({ min: 20, max: 200 }) });

export const parseRegisterRequest = (value: unknown): Checked<RegisterRequest> => run(registerRequest, value);
export const parseRegisterResponse = (value: unknown): Checked<RegisterResponse> => run(registerResponse, value);

// --- Claim ------------------------------------------------------------------------------------

/** What a job does: review a pull request, or answer and resolve its open review threads. */
export const JOB_KINDS = ['review', 'resolve'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** A job `resolve` holds at most this many threads, as the Action. */
export const MAX_RESOLVE_THREADS = 20;
/** The pack of a job `resolve` holds at most this many bytes (packages/engine/src/resolve.ts). */
export const MAX_RESOLVE_PACK_BYTES = 150_000;

/**
 * - `hasProviderKey`: the runner has its own key for the model. The service then never sends its
 *   own key, even to a trusted runner.
 * - `kinds`: the kinds of job that the runner can run. A runner of an earlier release does not send
 *   it, and gets only `review` jobs.
 * - `features`: what the runner can read in a job (FEATURES). Not sent by an earlier release.
 * - `ownProvider`: the kind of the provider of the runner's own key, or of its own server (Ollama,
 *   which needs no key). Null when the runner has neither. Not sent by an earlier release: its own
 *   key, when `hasProviderKey`, is an OpenRouter key.
 */
export type ClaimRequest = { hasProviderKey: boolean; kinds?: JobKind[]; features?: Feature[]; ownProvider?: ProviderKind | null };

/**
 * One comment of an open review thread, as the service read it on GitHub. `body` is already cleaned
 * (no HTML comment, no `<details>`, no image) and cut. `commit`: the commit that the comment was
 * written on, or null when GitHub does not know it.
 */
export type ResolveComment = { id: number; author: string; isBot: boolean; body: string; commit: string | null };
export type ResolveThread = { id: string; path: string; line: number | null; comments: ResolveComment[] };

/**
 * What a job `resolve` answers: the open threads that no `resolve` answered at this head yet, the
 * first MAX_RESOLVE_THREADS of them. `open`: all the open threads; `waiting`: those not answered at
 * this head. The runner gives both back in its result, for the summary comment.
 */
export type ResolveInput = { threads: ResolveThread[]; open: number; waiting: number };

/**
 * A provider that the job may call, with the feature `providers`.
 *
 * - `id`: the provider of the org (a uuid), or `service` for the key of the service.
 * - `apiKey`: the key, given only to a trusted runner; null when the runner calls with its own key
 *   or its own server (`ownProvider` of its claim is this kind). The runner never logs it.
 * - `baseUrl`: where to call; null for the default URL of the kind, or the runner's own URL.
 * - `models`: the models of the level, the first one first. Empty: the defaults of the kind.
 */
export type JobProvider = { id: string; kind: ProviderKind; apiKey: string | null; baseUrl: string | null; models: string[] };

/**
 * The models of a job, with the feature `models` (REV-12): what the config of its repository chose
 * for its level, resolved (org, then repository) when the job was queued. `provider` is the `id` of
 * an entry of `providers`, or `service`; `fallback` is a second model of the same provider, that
 * takes over when the call of `model` fails. They replace the models of the provider for the level;
 * the other settings of the level (reasoning, limits, context) stay.
 */
export type JobModels = { provider: string; model: string; fallback: string | null };

/** A job carries at most this many rules. */
export const MAX_JOB_RULES = 50;

/**
 * A rule of the repository or of its org (REV-19), with the feature `rules`. An admin writes it in
 * the screens of Kentō: it never comes from the code of the pull request.
 *
 * - `paths`: globs of the paths that the rule covers (`db/migrations/**`). The engine sends the rule
 *   to the model only when a changed file matches one of them. Empty: every path.
 * - `severityFloor`: a finding that cites the rule has at least this severity. Null: no floor.
 */
export type JobRule = {
  id: string;
  scope: 'repo' | 'org';
  title: string;
  text: string;
  paths: string[];
  severityFloor: Severity | null;
};

/**
 * A job, as the runner receives it.
 *
 * - `installationToken`: a GitHub token for this repository only, with `contents: read`, valid one
 *   hour. It clones the code; it cannot write. The runner never logs it.
 * - `provider`: for a runner of an earlier release only: the OpenRouter key of the service. Only a
 *   trusted runner without its own key gets it; otherwise it is null and the runner uses its own key.
 *   A runner with the feature `providers` gets null here, and reads `providers`.
 * - `providers`: with the feature `providers` only. The runner calls the first one, or the one that
 *   `models` names.
 * - `models`: with the feature `models` only, and only for a job queued with a config (REV-12).
 * - `rules`: with the feature `rules` only, on a review job (REV-19). Absent: the review has no rule.
 * - `attempt`: the number of this claim of the job, from 1. The heartbeat and the result send it.
 */
type JobBase = {
  id: string;
  attempt: number;
  level: Level;
  repo: { fullName: string; cloneUrl: string };
  pullRequest: { number: number; headSha: string; baseRef: string };
  installationToken: { token: string; expiresAt: string };
  leaseExpiresAt: string;
  provider: { kind: 'openrouter'; apiKey: string } | null;
  providers?: JobProvider[];
  models?: JobModels;
  rules?: JobRule[];
};

/** A review job holds at most this many rejected findings, the newest first. */
export const MAX_REJECTED_FINDINGS = 50;

/**
 * REV-95. A finding of the pull request that a person set aside: `dismissed` (the command `reject`,
 * the screens, a 👎) or `wontfix`. `reason`: the cause that the person wrote, or null. `commit`: the
 * head of the last review that reported it, from which the review tells whether its file changed.
 */
export type RejectedFinding = {
  path: string;
  line: number;
  title: string;
  /** The category of the finding (`CATEGORIES`): a finding near it must share it to be the same. */
  category: Category;
  /**
   * The severity of the finding: a finding near it that is more severe is another defect. Only with
   * the feature `rejected-severity`; without it, the engine does not compare the severities.
   */
  severity?: Severity;
  status: 'dismissed' | 'wontfix';
  reason: string | null;
  commit: string;
};

/**
 * REV-89. The last review of the pull request that the runner may reuse: its head and its reuse key.
 * Only a review job of a push carries one; a command or a manual rerun always gets a new review.
 */
export type JobReuse = { head: string; key: string; delta?: JobDelta };

/** REV-88. The statuses of a finding that a review does not raise again. */
export const SETTLED_STATUSES = ['fixed', 'dismissed', 'wontfix'] as const;
/** REV-88. A job carries at most this many settled findings, and this many open findings of the last review. */
export const MAX_SETTLED = 200;
export const MAX_DELTA_FINDINGS = 100;

/**
 * REV-88, with the feature `delta`. What the runner needs to review only the change since the head
 * of `JobReuse`, sent only when that review is of the level of the job:
 *
 * - `score`: the score of that review. Without a new finding, the review keeps at least this score.
 * - `findings`: its findings that are still open (not fixed, dismissed or kept). Those on a file that
 *   did not change since come back in the result as they are.
 * - `settled`: the findings of the pull request that a review showed fixed, or that a person
 *   dismissed (`dismissed`) or kept (`wontfix`). The model is told not to raise them again, and the
 *   runner drops a dismissed or kept one that it raises again.
 */
export type JobDelta = {
  score: number;
  findings: ReviewFinding[];
  settled: { path: string; line: number; title: string; status: (typeof SETTLED_STATUSES)[number]; key: string; fingerprint: string }[];
};

/** REV-99. A review job holds at most this many earlier findings. */
export const MAX_EARLIER_FINDINGS = 100;
/** REV-99. The statuses of an earlier finding. */
export const EARLIER_STATUSES = ['open', 'fixed', 'dismissed', 'wontfix', 'stale'] as const;
/** The key of a finding (`findingKey` of packages/engine): 12 hexadecimal characters. */
export const FINDING_KEY_PATTERN = /^[0-9a-f]{12}$/;

/**
 * REV-99. A finding that an earlier review of the pull request reported, whatever its status.
 *
 * - `key`: its key, which a finding of the result names in `follows`.
 * - `commit`: the head of the last review that reported it, from which the engine tells whether its
 *   file changed since.
 * - `reason`: the cause that a person wrote when it is `dismissed` or `wontfix`, else null.
 */
export type EarlierFinding = {
  key: string;
  path: string;
  line: number;
  title: string;
  severity: Severity;
  category: Category;
  status: (typeof EARLIER_STATUSES)[number];
  reason: string | null;
  commit: string;
};

/**
 * REV-99, with the feature `earlier`. What the pull request already knows:
 *
 * - `findings`: its findings, the open ones first, then the newest.
 * - `last`: the head and the score of the last review of the pull request at the level of the job,
 *   or null. When that head is in the history of the head of the job, a review whose findings all
 *   continue earlier findings keeps at least this score: a defect counts once, not once per wording.
 */
export type JobEarlier = { findings: EarlierFinding[]; last: { head: string; score: number } | null };

/**
 * A review job has no `resolve` key: a runner of an earlier release reads it as before. `threads`:
 * with the feature `threads` only (REV-71), the open threads of the bot that someone answered, the
 * first MAX_RESOLVE_THREADS of them, cleaned as for a resolve job. `reuse`: with the feature `reuse`
 * only (REV-89); null when no review can be reused. Its presence tells the runner that the service
 * reads the keys of REV-89 in the result. `rejected`: with the feature `rejected` only (REV-95).
 * `earlier`: with the feature `earlier` only (REV-99). Its presence tells the runner that the service
 * reads `follows` in the result. `reviewed`: with the feature `reviewed` only (REV-100), the head of
 * the last review of Kentō on the pull request, of any level, or null before the first one. Its
 * presence tells the runner that the service reads `seen` in the result.
 */
export type Job =
  | (JobBase & { kind: 'review'; threads?: ResolveThread[]; reuse?: JobReuse | null; rejected?: RejectedFinding[]; earlier?: JobEarlier; reviewed?: string | null })
  | (JobBase & { kind: 'resolve'; resolve: ResolveInput });

const claimRequest = obj({
  hasProviderKey: bool,
  kinds: optional(arr(oneOf(JOB_KINDS), { max: 10 })),
  features: optional(arr(oneOf(FEATURES), { max: 20 })),
  ownProvider: optional(nullable(oneOf(PROVIDER_KINDS))),
});
/** A model id at a provider: `claude-opus-5-5`, `anthropic/claude-haiku-5.5`, `qwen3:32b`. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const jobProvider = obj({
  id: str({ min: 1, max: 36, pattern: PROVIDER_ID }),
  kind: oneOf(PROVIDER_KINDS),
  apiKey: nullable(str({ min: 1, max: 500 })),
  // HTTPS, or HTTP for a server on a private network (Ollama): the runner checks it again.
  baseUrl: nullable(str({ max: 300, pattern: /^https?:\/\/[^\s@]+$/ })),
  models: arr(str({ min: 1, max: 200, pattern: MODEL_ID }), { max: 5 }),
});
const attempt = int({ min: 1, max: 1000 });
// The limits of the table `rules` of the service.
export const RULE_TITLE_MAX = 200;
export const RULE_TEXT_MAX = 4000;
export const RULE_PATHS_MAX = 20;
export const RULE_PATH_MAX = 300;
const jobRule = obj({
  id: uuid,
  scope: oneOf(['repo', 'org'] as const),
  title: str({ min: 1, max: RULE_TITLE_MAX }),
  text: str({ min: 1, max: RULE_TEXT_MAX }),
  paths: arr(str({ min: 1, max: RULE_PATH_MAX }), { max: RULE_PATHS_MAX }),
  severityFloor: nullable(oneOf(SEVERITIES)),
});
const jobBase = {
  id: uuid,
  attempt,
  level: oneOf(LEVELS),
  repo: obj({
    fullName: str({ min: 3, max: 200, pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ }),
    // HTTPS only: the token goes in a header, and a plain HTTP clone would show it on the network.
    cloneUrl: str({ max: 300, pattern: /^https:\/\/[^\s@]+$/ }),
  }),
  pullRequest: obj({
    number: int({ min: 1, max: 2 ** 31 - 1 }),
    headSha: sha,
    // A git branch name; never an option of git.
    baseRef: str({ min: 1, max: 255, pattern: /^(?!-)[^\s~^:?*[\\]+$/ }),
  }),
  installationToken: obj({ token: str({ min: 1, max: 500 }), expiresAt: isoDate }),
  leaseExpiresAt: isoDate,
  provider: nullable(obj({ kind: oneOf(['openrouter'] as const), apiKey: str({ min: 1, max: 500 }) })),
  providers: optional(arr(jobProvider, { max: 4 })),
  models: optional(
    obj({
      provider: str({ min: 1, max: 36, pattern: PROVIDER_ID }),
      model: str({ min: 1, max: 200, pattern: MODEL_ID }),
      fallback: nullable(str({ min: 1, max: 200, pattern: MODEL_ID })),
    }),
  ),
  rules: optional(arr(jobRule, { max: MAX_JOB_RULES })),
};
const resolveComment = obj({
  id: int({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  author: str({ min: 1, max: 100 }),
  isBot: bool,
  // 2000 characters and the mark of a cut (packages/engine/src/threads.ts).
  body: str({ max: 2100 }),
  commit: nullable(sha),
});
const resolveThread = obj({
  id: str({ min: 1, max: 100 }),
  path: str({ min: 1, max: 1000 }),
  line: nullable(int({ min: 0, max: 10_000_000 })),
  comments: arr(resolveComment, { max: 30 }),
});
const rejectedFinding = obj({
  path: str({ min: 1, max: 1000 }),
  line: int({ min: 0, max: 10_000_000 }),
  title: str({ min: 1, max: 1000 }),
  category: oneOf(CATEGORIES),
  severity: optional(oneOf(SEVERITIES)),
  status: oneOf(['dismissed', 'wontfix'] as const),
  // REASON_MAX of the service (apps/web/app/findings/store.ts).
  reason: nullable(str({ max: 500 })),
  commit: sha,
});
const count = int({ min: 0, max: 100_000 });
const line = int({ min: 0, max: 10_000_000 });
const tokens = nullable(int({ min: 0, max: 100_000_000 }));
const finding = obj({
  path: str({ min: 1, max: 1000 }),
  start_line: line,
  line,
  severity: oneOf(SEVERITIES),
  category: oneOf(CATEGORIES),
  confidence: num({ min: 0, max: 100 }),
  title: text(1000),
  scenario: text(20_000),
  fix: text(20_000),
  suggestion: text(20_000),
  patch: optional(text(20_000)),
  anchor: nullable(line),
  blocking: bool,
  suggestion_range: nullable(tuple2(line, line)),
  rule_id: optional(uuid),
  fingerprint: optional(str({ max: 16, pattern: /^[0-9a-f]{16}$/ })),
  follows: optional(str({ max: 12, pattern: FINDING_KEY_PATTERN })),
  seen: optional(bool),
});
const earlierFinding = obj({
  key: str({ max: 12, pattern: FINDING_KEY_PATTERN }),
  path: str({ min: 1, max: 1000 }),
  line,
  title: str({ min: 1, max: 1000 }),
  severity: oneOf(SEVERITIES),
  category: oneOf(CATEGORIES),
  status: oneOf(EARLIER_STATUSES),
  reason: nullable(str({ max: 500 })),
  commit: sha,
});
const jobEarlier = obj({
  findings: arr(earlierFinding, { max: MAX_EARLIER_FINDINGS }),
  last: nullable(obj({ head: sha, score: int({ min: 1, max: 5 }) })),
});
/** REV-99. The check of the runner, for the service: an earlier finding that fails it would make the runner refuse the job. */
export const parseEarlierFinding = (value: unknown): Checked<EarlierFinding> => run(earlierFinding, value) as Checked<EarlierFinding>;
const settledFinding = obj({
  path: str({ min: 1, max: 1000 }),
  line,
  title: text(1000),
  status: oneOf(SETTLED_STATUSES),
  key: str({ max: 12, pattern: /^[0-9a-f]{12}$/ }),
  fingerprint: str({ max: 16, pattern: /^[0-9a-f]{16}$/ }),
});
const jobDelta = obj({
  score: int({ min: 1, max: 5 }),
  findings: arr(finding, { max: MAX_DELTA_FINDINGS }),
  settled: arr(settledFinding, { max: MAX_SETTLED }),
});
/**
 * REV-88. The checks of the runner, for the service: a finding or a settled finding of a `delta`
 * that fails them would make the runner refuse the whole job.
 */
export const parseReviewFinding = (value: unknown): Checked<ReviewFinding> => run(finding, value) as Checked<ReviewFinding>;
export const parseSettledFinding = (value: unknown): Checked<JobDelta['settled'][number]> => run(settledFinding, value) as Checked<JobDelta['settled'][number]>;
const diffHash = str({ max: 16, pattern: DIFF_HASH });
const reuseKey = str({ max: 64, pattern: REUSE_KEY });
const job = tagged('kind', {
  review: obj({
    ...jobBase,
    kind: oneOf(['review'] as const),
    threads: optional(arr(resolveThread, { max: MAX_RESOLVE_THREADS })),
    reuse: optional(
      nullable(
        obj({
          head: sha,
          key: reuseKey,
          delta: optional(jobDelta),
        }),
      ),
    ),
    rejected: optional(arr(rejectedFinding, { max: MAX_REJECTED_FINDINGS })),
    earlier: optional(jobEarlier),
    reviewed: optional(nullable(sha)),
  }),
  resolve: obj({
    ...jobBase,
    kind: oneOf(['resolve'] as const),
    resolve: obj({ threads: arr(resolveThread, { max: MAX_RESOLVE_THREADS }), open: count, waiting: count }),
  }),
});

export const parseClaimRequest = (value: unknown): Checked<ClaimRequest> => run(claimRequest, value) as Checked<ClaimRequest>;
export const parseJob = (value: unknown): Checked<Job> => run(job, value) as Checked<Job>;

// --- Heartbeat --------------------------------------------------------------------------------

export type HeartbeatRequest = { attempt: number };

/**
 * `cancel`: the job is no longer wanted (a newer push, a close or a suspension cancelled it). The
 * runner stops and sends nothing.
 */
export type HeartbeatResponse = { leaseExpiresAt: string; cancel: boolean };

const heartbeatRequest = obj({ attempt });
const heartbeatResponse = obj({ leaseExpiresAt: isoDate, cancel: bool });
export const parseHeartbeatRequest = (value: unknown): Checked<HeartbeatRequest> => run(heartbeatRequest, value);
export const parseHeartbeatResponse = (value: unknown): Checked<HeartbeatResponse> => run(heartbeatResponse, value);

// --- Result -----------------------------------------------------------------------------------

export type ReviewFinding = {
  path: string;
  start_line: number;
  line: number;
  severity: Severity;
  category: Category;
  confidence: number;
  title: string;
  scenario: string;
  fix: string;
  suggestion: string;
  /**
   * REV-104, with the feature `patch`. A short unified diff of the fix, when the fix does not fit a
   * suggestion. Absent when the finding has an applicable suggestion, and always absent from a runner
   * of an earlier release.
   */
  patch?: string;
  /** The changed line the finding anchors on, or null when it goes in the summary. */
  anchor: number | null;
  blocking: boolean;
  suggestion_range: [number, number] | null;
  /**
   * REV-19. The rule of the job that the finding applies (`JobRule.id`). Absent when the finding
   * cites no rule, and always absent from a runner of an earlier release.
   */
  rule_id?: string;
  /**
   * The fingerprint of the finding (packages/engine/src/fingerprint.ts): the path, the rule or the
   * title, and the code around the line at the head. A runner of an earlier release sends none; the
   * service then computes one without the code.
   */
  fingerprint?: string;
  /**
   * REV-99. The key of the earlier finding (`EarlierFinding.key`) that this finding continues: the
   * same defect, reworded, or what a fix left of it. Only when the job carried `earlier`.
   */
  follows?: string;
  /**
   * REV-100. The code of the finding (its lines, and 5 lines around) did not change since the last
   * commit that a review of Kentō read on the pull request. Only when the job carried `reviewed`.
   * A new finding of this kind, not critical, does not block (`toConsider` of packages/engine).
   */
  seen?: boolean;
};

/** The review of a job: what `reviewPullRequest` of packages/engine returns, without the pack. */
export type ReviewPayload = {
  level: Level;
  base: string;
  head: string;
  score: number;
  verdict: (typeof VERDICTS)[number];
  model: string;
  provider: string | null;
  costUsd: number | null;
  /** With the feature `providers`. `unknown`: no price for the model, `costUsd` is 0. */
  costSource?: CostSource;
  promptTokens: number | null;
  completionTokens: number | null;
  summary: string;
  risk: string;
  diagram: string | null;
  deeperReview: string | null;
  findings: ReviewFinding[];
  notReviewed: string[];
  skipped: string[];
  /** REV-89, with the feature `reuse`. The hash of the reviewed files of the diff. */
  diffHash?: string;
  /** REV-89, with the feature `reuse`. The key of the whole input of the model. */
  reuseKey?: string;
  /** REV-89, with the feature `reuse`. The tokens of the prompt that the provider read from its cache. */
  cachedTokens?: number | null;
  /**
   * REV-88, when the job carried `delta`: the review read only the files that changed since the head
   * `since` (`files` of them). Absent: the review read the whole pull request.
   */
  delta?: { since: string; files: number };
  /**
   * REV-96, with the feature `refuted`, when the job carried `threads`: the ids of the answered
   * threads (`ResolveThread.id`) that the model called refuted. The service answers them with the
   * hint of the command `reject`.
   */
  refutedThreads?: string[];
};

/**
 * REV-89. A head whose reuse key is the one of `JobReuse`: the runner called no model. `of` is the
 * head of the review to publish again.
 */
export type UnchangedPayload = { level: Level; base: string; head: string; of: string; diffHash: string; reuseKey: string };

export const THREAD_VERDICTS = ['fixed', 'answered', 'open'] as const;

/**
 * The answer of a job `resolve`. `threads`: the verdict of the model on each thread that it read,
 * with `changed`, whether the file of the thread changed between the commit of its first comment and
 * the head (null when a force-push removed that commit). `held`: the number of threads that the
 * pack of the model held (it stops at 150 kB). `model` is null when no thread waited: no model call.
 */
export type ResolvePayload = {
  level: Level;
  head: string;
  model: string | null;
  provider: string | null;
  costUsd: number | null;
  costSource?: CostSource;
  promptTokens: number | null;
  completionTokens: number | null;
  open: number;
  waiting: number;
  held: number;
  threads: { id: string; verdict: (typeof THREAD_VERDICTS)[number]; reply: string; changed: boolean | null }[];
};

/**
 * `providerStatus`, with the feature `providers`: the HTTP status of the provider when the model
 * call failed on it (401 or 403: the provider refused the key). Null when the failure is elsewhere.
 */
export type ResultRequest =
  | { outcome: 'done'; attempt: number; review: ReviewPayload }
  | { outcome: 'resolved'; attempt: number; resolve: ResolvePayload }
  | { outcome: 'unchanged'; attempt: number; unchanged: UnchangedPayload }
  | { outcome: 'failed'; attempt: number; reason: string; providerStatus?: number | null };

const review = obj({
  level: oneOf(LEVELS),
  base: sha,
  head: sha,
  score: int({ min: 1, max: 5 }),
  verdict: oneOf(VERDICTS),
  model: str({ min: 1, max: 200 }),
  provider: nullable(text(200)),
  // reviews.cost_usd is numeric(10, 6).
  costUsd: nullable(num({ min: 0, max: 9999 })),
  costSource: optional(oneOf(COST_SOURCES)),
  promptTokens: tokens,
  completionTokens: tokens,
  summary: text(50_000),
  risk: text(5_000),
  diagram: nullable(text(20_000)),
  deeperReview: nullable(text(5_000)),
  findings: arr(finding, { max: 100 }),
  notReviewed: arr(text(1000), { max: 200 }),
  skipped: arr(text(1000), { max: 2000 }),
  diffHash: optional(diffHash),
  reuseKey: optional(reuseKey),
  cachedTokens: optional(tokens),
  delta: optional(obj({ since: sha, files: int({ min: 0, max: 100_000 }) })),
  refutedThreads: optional(arr(str({ min: 1, max: 100 }), { max: MAX_RESOLVE_THREADS })),
});
const resultRequest = tagged('outcome', {
  done: obj({ outcome: oneOf(['done'] as const), attempt, review }),
  resolved: obj({
    outcome: oneOf(['resolved'] as const),
    attempt,
    resolve: obj({
      level: oneOf(LEVELS),
      head: sha,
      model: nullable(str({ min: 1, max: 200 })),
      provider: nullable(text(200)),
      costUsd: nullable(num({ min: 0, max: 9999 })),
      costSource: optional(oneOf(COST_SOURCES)),
      promptTokens: tokens,
      completionTokens: tokens,
      open: count,
      waiting: count,
      held: int({ min: 0, max: MAX_RESOLVE_THREADS }),
      threads: arr(
        obj({ id: str({ min: 1, max: 100 }), verdict: oneOf(THREAD_VERDICTS), reply: text(10_000), changed: nullable(bool) }),
        { max: MAX_RESOLVE_THREADS },
      ),
    }),
  }),
  unchanged: obj({
    outcome: oneOf(['unchanged'] as const),
    attempt,
    unchanged: obj({ level: oneOf(LEVELS), base: sha, head: sha, of: sha, diffHash, reuseKey }),
  }),
  failed: obj({
    outcome: oneOf(['failed'] as const),
    attempt,
    reason: str({ min: 1, max: 2000 }),
    providerStatus: optional(nullable(int({ min: 100, max: 599 }))),
  }),
});

export const parseResultRequest = (value: unknown): Checked<ResultRequest> => run(resultRequest, value) as Checked<ResultRequest>;

// --- Errors -----------------------------------------------------------------------------------

/**
 * The body of every 4xx and 5xx answer of the API. `errors` lists the problems of a 400.
 *
 * The heartbeat and the result answer 409 with:
 * - `lease_lost`: the attempt of the runner is over (its lease ended, and the job went back to the
 *   queue or to another runner). The runner stops the job and sends nothing more.
 * - `job_finished` / `job_not_running`: the job already has its result, or was cancelled.
 */
export type ApiError = { error: string; errors?: string[] };
