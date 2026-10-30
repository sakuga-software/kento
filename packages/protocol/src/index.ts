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

export const LEVELS = ['lite', 'balanced', 'heavy'] as const;
export type Level = (typeof LEVELS)[number];

/**
 * The providers of models that a runner can call (packages/engine/src/providers.ts). A runner of an
 * earlier release knows `openrouter` only.
 */
export const PROVIDER_KINDS = ['openrouter', 'anthropic', 'openai_compatible', 'ollama'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * What a runner can read in a job beyond the first release. A runner of an earlier release sends
 * none, and gets jobs of the first shape only: `obj()` refuses a key that it does not know.
 *
 * - `providers`: the job can carry `providers` (several kinds of provider, their base URL and their
 *   models), and the result of a failure can carry `providerStatus`, and a review its `costSource`.
 * - `models`: the job can carry `models`, the provider and the models that the config of its
 *   repository chose for its level (REV-12).
 */
export const FEATURES = ['providers', 'models'] as const;
export type Feature = (typeof FEATURES)[number];

/** Where the cost of a call comes from: the provider, the price table, a free local model, or nowhere (0). */
export const COST_SOURCES = ['provider', 'table', 'free', 'unknown'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

const uuid = str({ max: 36, pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ });
const sha = str({ max: 64, pattern: /^[0-9a-f]{40}([0-9a-f]{24})?$/ });
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
};

/** A review job has no `resolve` key: a runner of an earlier release reads it as before. */
export type Job = (JobBase & { kind: 'review' }) | (JobBase & { kind: 'resolve'; resolve: ResolveInput });

const claimRequest = obj({
  hasProviderKey: bool,
  kinds: optional(arr(oneOf(JOB_KINDS), { max: 10 })),
  features: optional(arr(oneOf(FEATURES), { max: 20 })),
  ownProvider: optional(nullable(oneOf(PROVIDER_KINDS))),
});
/** A model id at a provider: `claude-opus-5-5`, `anthropic/claude-haiku-5.5`, `qwen3:32b`. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const jobProvider = obj({
  id: str({ min: 1, max: 36, pattern: /^(service|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/ }),
  kind: oneOf(PROVIDER_KINDS),
  apiKey: nullable(str({ min: 1, max: 500 })),
  // HTTPS, or HTTP for a server on a private network (Ollama): the runner checks it again.
  baseUrl: nullable(str({ max: 300, pattern: /^https?:\/\/[^\s@]+$/ })),
  models: arr(str({ min: 1, max: 200, pattern: MODEL_ID }), { max: 5 }),
});
const attempt = int({ min: 1, max: 1000 });
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
      provider: str({ min: 1, max: 36, pattern: /^(service|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/ }),
      model: str({ min: 1, max: 200, pattern: MODEL_ID }),
      fallback: nullable(str({ min: 1, max: 200, pattern: MODEL_ID })),
    }),
  ),
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
const count = int({ min: 0, max: 100_000 });
const job = tagged('kind', {
  review: obj({ ...jobBase, kind: oneOf(['review'] as const) }),
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

export const SEVERITIES = ['critical', 'major', 'minor'] as const;
export const CATEGORIES = ['bug', 'security', 'data', 'contract', 'test'] as const;
export const VERDICTS = ['REQUEST_CHANGES', 'APPROVE', 'COMMENT'] as const;

export type ReviewFinding = {
  path: string;
  start_line: number;
  line: number;
  severity: (typeof SEVERITIES)[number];
  category: (typeof CATEGORIES)[number];
  confidence: number;
  title: string;
  scenario: string;
  fix: string;
  suggestion: string;
  /** The changed line the finding anchors on, or null when it goes in the summary. */
  anchor: number | null;
  blocking: boolean;
  suggestion_range: [number, number] | null;
  /**
   * The fingerprint of the finding (packages/engine/src/fingerprint.ts): the path, the rule or the
   * title, and the code around the line at the head. A runner of an earlier release sends none; the
   * service then computes one without the code.
   */
  fingerprint?: string;
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
};

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
  | { outcome: 'failed'; attempt: number; reason: string; providerStatus?: number | null };

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
  anchor: nullable(line),
  blocking: bool,
  suggestion_range: nullable(tuple2(line, line)),
  fingerprint: optional(str({ max: 16, pattern: /^[0-9a-f]{16}$/ })),
});
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
