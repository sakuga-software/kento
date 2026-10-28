// One job: clone, review with packages/engine, send the result. The heartbeat keeps the lease while
// the job runs, and stops the job when the service cancels it.
import { mkdir } from 'node:fs/promises';
import {
  askJson,
  fileChangedSince,
  levelConfig,
  mergeBase,
  RESOLVE_SCHEMA,
  resolvePack,
  reviewPullRequest,
  type OpenThread,
  type ReviewResult,
  type ThreadVerdict,
} from '@sakuga-review/engine';
import { HEARTBEAT_SECONDS, type Job, type ResolvePayload, type ResultRequest, type ReviewPayload } from '@sakuga-review/protocol';
import { ApiError, isJobLost, type KentoApi } from './api.ts';
import { clonePullRequest, gitEnvironment, withEnvironment } from './clone.ts';
import type { Config } from './config.ts';
import { addSecret, errorMessage, log, removeSecret } from './log.ts';

export type JobDependencies = {
  api: KentoApi;
  config: Pick<Config, 'workDir' | 'provider'>;
  /** Replaces the network of the model calls in a test. */
  modelFetch?: typeof fetch;
  /** Replaces the clone URL of the job in a test, to clone a local repository. */
  cloneUrl?: (job: Job) => string;
  /** The protocols that git may use: `https`, or `file` in a test. */
  gitProtocols?: string;
  heartbeatMs?: number;
  /** Aborts the job, for example when the runner stops. */
  signal?: AbortSignal;
};

/**
 * - `cancelled`: the service cancelled the job (a newer push, a close); nothing was sent.
 * - `lost`: the service gave the job to another attempt (the lease ended) or refused the result with
 *   409; nothing was stored.
 * - `interrupted`: the runner stopped in the middle; the job comes back when its lease ends.
 */
export type JobOutcome = 'done' | 'failed' | 'cancelled' | 'lost' | 'interrupted';

/** Runs a job to its end and sends its result. Throws only when the result cannot be sent. */
export async function runJob(job: Job, deps: JobDependencies): Promise<JobOutcome> {
  const started = Date.now();
  const fields = { jobId: job.id, kind: job.kind, attempt: job.attempt, repo: job.repo.fullName, pr: job.pullRequest.number, head: job.pullRequest.headSha, reviewLevel: job.level };
  log('info', 'job.started', fields);
  addSecret(job.installationToken.token);
  addSecret(job.provider?.apiKey);

  // `stop` ends the job when the service no longer wants it from this runner: `cancelled` when it
  // was cancelled, `lost` when its lease went to another attempt.
  const stop = new AbortController();
  let stoppedAs: 'cancelled' | 'lost' | null = null;
  const stopJob = (as: 'cancelled' | 'lost', reason: string) => {
    if (stoppedAs) return;
    stoppedAs = as;
    stop.abort(new Error(reason));
  };
  const signal = deps.signal ? AbortSignal.any([deps.signal, stop.signal]) : stop.signal;

  // One heartbeat at a time, and none once the job has ended, even when a call was in flight.
  let ended = false;
  let beating = false;
  const heartbeat = setInterval(async () => {
    if (ended || beating) return;
    beating = true;
    try {
      const answer = await deps.api.heartbeat(job.id, job.attempt);
      if (!ended && answer.cancel) {
        log('info', 'job.cancelled_by_service', fields);
        stopJob('cancelled', 'the service cancelled the job');
      }
    } catch (error) {
      if (!ended && isJobLost(error)) {
        log('warn', 'job.lease_lost', { ...fields, error: errorMessage(error) });
        stopJob('lost', 'the service gave the job to another attempt');
      } else {
        log('warn', 'job.heartbeat_failed', { ...fields, error: errorMessage(error) });
      }
    } finally {
      beating = false;
    }
  }, deps.heartbeatMs ?? HEARTBEAT_SECONDS * 1000);

  let result: ResultRequest;
  try {
    if (job.kind === 'resolve') {
      result = { outcome: 'resolved', attempt: job.attempt, resolve: await resolveJob(job, deps, signal) };
    } else {
      result = { outcome: 'done', attempt: job.attempt, review: await reviewJob(job, deps, signal) };
    }
  } catch (error) {
    result = { outcome: 'failed', attempt: job.attempt, reason: errorMessage(error).slice(0, 2000) || 'unknown error' };
  } finally {
    ended = true;
    clearInterval(heartbeat);
  }

  try {
    if (stoppedAs) {
      // The service no longer wants the job from this runner: it would refuse the result.
      log('info', 'job.finished', { ...fields, outcome: stoppedAs, durationMs: Date.now() - started });
      return stoppedAs;
    }
    if (result.outcome === 'failed' && deps.signal?.aborted) {
      // The runner stops (SIGTERM, a redeploy) in the middle of the job. The failure comes from the
      // stop, not from the pull request: send nothing. The job stays running until its lease ends,
      // then the service queues it again for another attempt. A review already done is still sent.
      log('warn', 'job.finished', { ...fields, outcome: 'interrupted', durationMs: Date.now() - started });
      return 'interrupted';
    }
    try {
      await deps.api.result(job.id, result);
    } catch (error) {
      // The job was cancelled, or its lease went to another attempt, after the last heartbeat: the
      // service stored nothing, and it is not an error of the runner.
      if (isJobLost(error)) {
        log('warn', 'job.finished', { ...fields, outcome: 'lost', durationMs: Date.now() - started, error: errorMessage(error) });
        return 'lost';
      }
      // A review that the service refuses (400) becomes a failure with the reason, so the job does
      // not stay running until its lease ends.
      if (!(error instanceof ApiError && error.status === 400 && result.outcome !== 'failed')) throw error;
      result = { outcome: 'failed', attempt: job.attempt, reason: `the service refused the review: ${errorMessage(error)}`.slice(0, 2000) };
      try {
        await deps.api.result(job.id, result);
      } catch (second) {
        // The lease can go to another attempt between the two calls.
        if (!isJobLost(second)) throw second;
        log('warn', 'job.finished', { ...fields, outcome: 'lost', durationMs: Date.now() - started, error: errorMessage(second) });
        return 'lost';
      }
    }
    log(result.outcome === 'failed' ? 'warn' : 'info', 'job.finished', {
      ...fields,
      outcome: result.outcome,
      durationMs: Date.now() - started,
      ...(result.outcome === 'done'
        ? { score: result.review.score, model: result.review.model, costUsd: result.review.costUsd }
        : result.outcome === 'resolved'
          ? { threads: result.resolve.threads.length, model: result.resolve.model, costUsd: result.resolve.costUsd }
          : { reason: result.reason }),
    });
    return result.outcome === 'failed' ? 'failed' : 'done';
  } finally {
    removeSecret(job.installationToken.token);
    removeSecret(job.provider?.apiKey);
  }
}

type Checkout = Awaited<ReturnType<typeof clonePullRequest>>;
type Workspace = { checkout: Checkout; env: Record<string, string>; apiKey: string; fetch: typeof fetch };

/** Clones the pull request, runs `work` in its checkout with the git environment, and removes it. */
async function withCheckout<T>(job: Job, deps: JobDependencies, signal: AbortSignal, work: (ws: Workspace) => Promise<T>): Promise<T> {
  // The key of the runner first: with it, the service never sees a key. A trusted runner without
  // its own key gets the key of the service with the job.
  const apiKey = deps.config.provider.apiKey ?? job.provider?.apiKey;
  if (!apiKey) throw new Error('no model key: set PROVIDER_API_KEY on the runner, or mark the runner as trusted');

  await mkdir(deps.config.workDir, { recursive: true });
  const cloneUrl = deps.cloneUrl?.(job) ?? job.repo.cloneUrl;
  const env = gitEnvironment(cloneUrl, job.installationToken.token, deps.gitProtocols);
  let checkout;
  try {
    checkout = await clonePullRequest({ workDir: deps.config.workDir, cloneUrl, headSha: job.pullRequest.headSha, baseRef: job.pullRequest.baseRef, env });
  } catch (error) {
    throw new Error(`clone failed: ${errorMessage(error)}`);
  }
  try {
    signal.throwIfAborted();
    const modelFetch = deps.modelFetch ?? globalThis.fetch;
    // A cancelled job stops its model call, so it costs nothing more.
    const fetch = ((url: string, init: RequestInit = {}) =>
      modelFetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal })) as typeof globalThis.fetch;
    const ws = { checkout, env, apiKey, fetch };
    return await withEnvironment(env, () => work(ws));
  } finally {
    await checkout.remove();
  }
}

async function reviewJob(job: Job, deps: JobDependencies, signal: AbortSignal): Promise<ReviewPayload> {
  return withCheckout(job, deps, signal, async ({ checkout, apiKey, fetch }) =>
    payload(
      await reviewPullRequest({
        repoDir: checkout.repoDir,
        base: checkout.base,
        head: checkout.head,
        level: job.level,
        config: levelConfig(job.level),
        apiKey,
        baseUrl: deps.config.provider.baseUrl,
        fetch,
        log: (message) => log('warn', 'job.model_attempt_failed', { jobId: job.id, error: message }),
      }),
    ),
  );
}

/**
 * The answer to the open threads, as `resolve` of the Action: the pack of the threads (their code at
 * the head and their diff since), one model call, and for each thread whether its file changed since
 * its first comment. The runner writes nothing on GitHub: the service posts the replies and resolves
 * the threads with its own token.
 */
async function resolveJob(job: Extract<Job, { kind: 'resolve' }>, deps: JobDependencies, signal: AbortSignal): Promise<ResolvePayload> {
  const { open, waiting } = job.resolve;
  const empty: ResolvePayload = {
    level: job.level,
    head: job.pullRequest.headSha,
    model: null,
    provider: null,
    costUsd: null,
    promptTokens: null,
    completionTokens: null,
    open,
    waiting,
    held: 0,
    threads: [],
  };
  // No thread waits: no clone, and no model call.
  if (job.resolve.threads.length === 0) return empty;

  return withCheckout(job, deps, signal, async ({ checkout, apiKey, fetch }) => {
    const threads: OpenThread[] = job.resolve.threads.map((t) => ({
      ...t,
      comments: t.comments.map(({ commit, ...c }) => ({ ...c, ...(commit ? { commit } : {}) })),
    }));
    // As the Action: the diff of a thread whose commit is gone starts at the merge base.
    const base = mergeBase(checkout.repoDir, checkout.base, checkout.head);
    const { pack, held } = resolvePack(checkout.repoDir, base, checkout.head, threads);
    if (held.length === 0) return empty;
    const { answer, usage } = await askJson<{ threads: ThreadVerdict[] }>(
      { apiKey, baseUrl: deps.config.provider.baseUrl, fetch, log: (message) => log('warn', 'job.model_attempt_failed', { jobId: job.id, error: message }) },
      levelConfig(job.level),
      'resolve.md',
      pack,
      { name: 'resolve', schema: RESOLVE_SCHEMA },
    );
    const byId = new Map((answer.threads ?? []).map((v) => [v.id, v]));
    const verdicts: ResolvePayload['threads'] = [];
    for (const t of held) {
      const v = byId.get(t.id);
      if (!v || !['fixed', 'answered', 'open'].includes(v.verdict)) continue;
      verdicts.push({
        id: t.id,
        verdict: v.verdict,
        reply: cut(v.reply, 10_000),
        // A thread whose commit GitHub does not give: nobody can tell what changed since (null).
        changed: t.comments[0]?.commit ? fileChangedSince(checkout.repoDir, t.comments[0].commit, checkout.head, t.path) : null,
      });
    }
    return {
      ...empty,
      model: usage.model ? cut(usage.model, 200) : 'unknown',
      provider: usage.provider ?? null,
      costUsd: typeof usage.cost === 'number' ? usage.cost : null,
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      held: held.length,
      threads: verdicts,
    };
  });
}

/** The review as the protocol sends it: the result of the engine without the pack and the lines. */
export function payload(result: ReviewResult): ReviewPayload {
  const { answer, usage } = result;
  return {
    level: result.level,
    base: result.base,
    head: result.head,
    score: result.score,
    verdict: result.verdict,
    model: usage.model || 'unknown',
    provider: usage.provider ?? null,
    costUsd: typeof usage.cost === 'number' ? usage.cost : null,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    summary: cut(answer.summary, 50_000),
    risk: cut(answer.risk, 5_000),
    diagram: result.diagram === null ? null : cut(result.diagram, 20_000),
    deeperReview: result.deeperReview === null ? null : cut(result.deeperReview, 5_000),
    findings: result.findings.slice(0, 100).map((f) => ({
      path: cut(f.path, 1000),
      start_line: lineNumber(f.start_line),
      line: lineNumber(f.line),
      severity: f.severity,
      category: f.category,
      confidence: Math.min(100, Math.max(0, Number(f.confidence) || 0)),
      title: cut(f.title, 1000),
      scenario: cut(f.scenario, 20_000),
      fix: cut(f.fix, 20_000),
      suggestion: cut(f.suggestion, 20_000),
      anchor: f.anchor,
      blocking: f.blocking,
      suggestion_range: f.suggestion_range,
    })),
    notReviewed: (answer.not_reviewed ?? []).slice(0, 200).map((item) => cut(item, 1000)),
    skipped: result.skipped.slice(0, 2000).map((item) => cut(item, 1000)),
  };
}

// The model writes the text: cut it to the limits of the protocol, so that the service takes it.
function cut(text: unknown, max: number): string {
  const value = typeof text === 'string' ? text : '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function lineNumber(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? Math.min(value as number, 10_000_000) : 0;
}
