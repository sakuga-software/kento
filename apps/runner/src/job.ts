// One job: clone, review with packages/engine, send the result. The heartbeat keeps the lease while
// the job runs, and stops the job when the service cancels it.
import { mkdir } from 'node:fs/promises';
import { levelConfig, reviewPullRequest, type ReviewResult } from '@sakuga-review/engine';
import { HEARTBEAT_SECONDS, type Job, type ResultRequest, type ReviewPayload } from '@sakuga-review/protocol';
import { ApiError, type KentoApi } from './api.ts';
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

export type JobOutcome = 'done' | 'failed' | 'cancelled' | 'interrupted';

/** Runs a job to its end and sends its result. Throws only when the result cannot be sent. */
export async function runJob(job: Job, deps: JobDependencies): Promise<JobOutcome> {
  const started = Date.now();
  const fields = { jobId: job.id, repo: job.repo.fullName, pr: job.pullRequest.number, head: job.pullRequest.headSha, reviewLevel: job.level };
  log('info', 'job.started', fields);
  addSecret(job.installationToken.token);
  addSecret(job.provider?.apiKey);

  const cancel = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, cancel.signal]) : cancel.signal;
  const heartbeat = setInterval(async () => {
    try {
      const answer = await deps.api.heartbeat(job.id);
      if (answer.cancel) {
        log('info', 'job.cancelled_by_service', fields);
        cancel.abort(new Error('the service cancelled the job'));
      }
    } catch (error) {
      log('warn', 'job.heartbeat_failed', { ...fields, error: errorMessage(error) });
    }
  }, deps.heartbeatMs ?? HEARTBEAT_SECONDS * 1000);

  let result: ResultRequest;
  try {
    const review = await reviewJob(job, deps, signal);
    result = { outcome: 'done', review };
  } catch (error) {
    result = { outcome: 'failed', reason: errorMessage(error).slice(0, 2000) || 'unknown error' };
  } finally {
    clearInterval(heartbeat);
  }

  try {
    if (cancel.signal.aborted) {
      // The service no longer wants the job: it would refuse the result.
      log('info', 'job.finished', { ...fields, outcome: 'cancelled', durationMs: Date.now() - started });
      return 'cancelled';
    }
    if (result.outcome === 'failed' && deps.signal?.aborted) {
      // The runner stops (SIGTERM, a redeploy) in the middle of the job. The failure comes from the
      // stop, not from the pull request: send nothing, so that the job stays running until its lease
      // ends and the service gives it to another runner (REV-6). A review already done is still sent.
      log('warn', 'job.finished', { ...fields, outcome: 'interrupted', durationMs: Date.now() - started });
      return 'interrupted';
    }
    try {
      await deps.api.result(job.id, result);
    } catch (error) {
      // A review that the service refuses (400) becomes a failure with the reason, so the job does
      // not stay running until its lease ends.
      if (!(error instanceof ApiError && error.status === 400 && result.outcome === 'done')) throw error;
      result = { outcome: 'failed', reason: `the service refused the review: ${errorMessage(error)}`.slice(0, 2000) };
      await deps.api.result(job.id, result);
    }
    log(result.outcome === 'done' ? 'info' : 'warn', 'job.finished', {
      ...fields,
      outcome: result.outcome,
      durationMs: Date.now() - started,
      ...(result.outcome === 'done' ? { score: result.review.score, model: result.review.model, costUsd: result.review.costUsd } : { reason: result.reason }),
    });
    return result.outcome;
  } finally {
    removeSecret(job.installationToken.token);
    removeSecret(job.provider?.apiKey);
  }
}

async function reviewJob(job: Job, deps: JobDependencies, signal: AbortSignal): Promise<ReviewPayload> {
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
    const result = await withEnvironment(env, () =>
      reviewPullRequest({
        repoDir: checkout.repoDir,
        base: checkout.base,
        head: checkout.head,
        level: job.level,
        config: levelConfig(job.level),
        apiKey,
        baseUrl: deps.config.provider.baseUrl,
        // A cancelled job stops its model call, so it costs nothing more.
        fetch: ((url: string, init: RequestInit = {}) =>
          modelFetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal })) as typeof fetch,
        log: (message) => log('warn', 'job.model_attempt_failed', { jobId: job.id, error: message }),
      }),
    );
    return payload(result);
  } finally {
    await checkout.remove();
  }
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
