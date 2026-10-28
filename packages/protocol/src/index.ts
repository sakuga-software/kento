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
 * Node 24 or later runs this code as is: no build. Keep to erasable TypeScript syntax.
 */
import { arr, bool, int, nullable, num, obj, oneOf, run, str, tagged, tuple2, type Checked } from './check.ts';

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

/** The providers of models that a runner can call. M2 has OpenRouter only. */
export const PROVIDER_KINDS = ['openrouter'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

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

/**
 * `hasProviderKey`: the runner has its own key for the model. The service then never sends its own
 * key, even to a trusted runner.
 */
export type ClaimRequest = { hasProviderKey: boolean };

/**
 * A job, as the runner receives it.
 *
 * - `installationToken`: a GitHub token for this repository only, with `contents: read`, valid one
 *   hour. It clones the code; it cannot write. The runner never logs it.
 * - `provider`: the key of the service for the model. Only a trusted runner without its own key
 *   gets it; otherwise it is null and the runner uses its own key.
 * - `attempt`: the number of this claim of the job, from 1. The heartbeat and the result send it.
 */
export type Job = {
  id: string;
  attempt: number;
  kind: 'review';
  level: Level;
  repo: { fullName: string; cloneUrl: string };
  pullRequest: { number: number; headSha: string; baseRef: string };
  installationToken: { token: string; expiresAt: string };
  leaseExpiresAt: string;
  provider: { kind: ProviderKind; apiKey: string } | null;
};

const claimRequest = obj({ hasProviderKey: bool });
const attempt = int({ min: 1, max: 1000 });
const job = obj({
  id: uuid,
  attempt,
  kind: oneOf(['review'] as const),
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
  provider: nullable(obj({ kind: oneOf(PROVIDER_KINDS), apiKey: str({ min: 1, max: 500 }) })),
});

export const parseClaimRequest = (value: unknown): Checked<ClaimRequest> => run(claimRequest, value);
export const parseJob = (value: unknown): Checked<Job> => run(job, value);

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

export type ResultRequest =
  | { outcome: 'done'; attempt: number; review: ReviewPayload }
  | { outcome: 'failed'; attempt: number; reason: string };

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
  failed: obj({ outcome: oneOf(['failed'] as const), attempt, reason: str({ min: 1, max: 2000 }) }),
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
