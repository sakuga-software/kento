// One job: clone, review with packages/engine, send the result. The heartbeat keeps the lease while
// the job runs, and stops the job when the service cancels it.
import { mkdir } from 'node:fs/promises';
import {
  askJson,
  fileChangedSince,
  mergeBase,
  ProviderError,
  providerLevelConfig,
  type LevelConfig,
  RESOLVE_SCHEMA,
  resolvePack,
  reviewUnlessUnchanged,
  type OpenThread,
  type ReviewResult,
  type ThreadVerdict,
} from '@kento-review/engine';
import {
  HEARTBEAT_SECONDS,
  MAX_RESOLVE_THREADS,
  type CostSource,
  type Job,
  type ProviderKind,
  type ResolvePayload,
  type ResolveThread,
  type ResultRequest,
  type ReviewPayload,
  type UnchangedPayload,
} from '@kento-review/protocol';
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
  /** Replaces the waits between the attempts of a clone in a test. */
  cloneRetryDelaysMs?: readonly number[];
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
  for (const provider of job.providers ?? []) addSecret(provider.apiKey);
  // A service that sends `providers` reads the keys that only it knows in the result.
  const newService = job.providers !== undefined;

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
      const reviewed = await reviewJob(job, deps, signal);
      result =
        'of' in reviewed
          ? { outcome: 'unchanged', attempt: job.attempt, unchanged: reviewed }
          : { outcome: 'done', attempt: job.attempt, review: reviewed };
    }
  } catch (error) {
    result = { outcome: 'failed', attempt: job.attempt, reason: errorMessage(error).slice(0, 2000) || 'unknown error' };
    // The service marks a provider whose key is refused: an admin then replaces the key.
    if (newService) result.providerStatus = error instanceof ProviderError ? error.status : null;
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
        ? {
            score: result.review.score,
            model: result.review.model,
            costUsd: result.review.costUsd,
            promptTokens: result.review.promptTokens,
            ...(result.review.cachedTokens !== undefined ? { cachedTokens: result.review.cachedTokens } : {}),
            ...(result.review.diffHash ? { diffHash: result.review.diffHash } : {}),
          }
        : result.outcome === 'resolved'
          ? { threads: result.resolve.threads.length, model: result.resolve.model, costUsd: result.resolve.costUsd }
          : result.outcome === 'unchanged'
            ? { of: result.unchanged.of, diffHash: result.unchanged.diffHash, costUsd: 0 }
            : { reason: result.reason }),
    });
    return result.outcome === 'failed' ? 'failed' : 'done';
  } finally {
    removeSecret(job.installationToken.token);
    removeSecret(job.provider?.apiKey);
    for (const provider of job.providers ?? []) removeSecret(provider.apiKey);
  }
}

/** The provider that a job calls: its kind, its key, its URL and the configuration of the level. */
export type Model = { kind: ProviderKind; apiKey: string | undefined; baseUrl: string | undefined; config: LevelConfig };

/**
 * The provider of a job. The runner's own key or server first, when it is of the kind that the job
 * names: with it, the service never sees a key. Else the key that the service gave with the job,
 * which only a trusted runner gets.
 */
export function chooseModel(job: Job, own: JobDependencies['config']['provider']): Model {
  // REV-12: the config of the repository chose the provider and the models of the level.
  const chosen = job.models ? [job.models.model, ...(job.models.fallback ? [job.models.fallback] : [])] : undefined;
  if (job.providers !== undefined) {
    const wanted = job.models ? job.providers.find((p) => p.id === job.models!.provider) : job.providers[0];
    if (!wanted) throw new Error(job.models ? `the provider ${job.models.provider} that the config chose is not in the job` : 'the job names no provider');
    const config = providerLevelConfig(job.level, wanted.kind, chosen ?? wanted.models);
    if (own.own === wanted.kind) {
      return { kind: wanted.kind, apiKey: own.apiKey ?? undefined, baseUrl: own.baseUrl ?? wanted.baseUrl ?? undefined, config };
    }
    if (wanted.apiKey === null) {
      throw new Error(`no model key: the job needs a ${wanted.kind} provider on the runner (PROVIDER_KIND and PROVIDER_API_KEY), or a trusted runner`);
    }
    return { kind: wanted.kind, apiKey: wanted.apiKey, baseUrl: wanted.baseUrl ?? undefined, config };
  }
  // A service of an earlier release: an OpenRouter key, the runner's own first. Without `providers`,
  // the only provider that a config can name is the one of the service.
  if (job.models && job.models.provider !== 'service') {
    throw new Error(`the provider ${job.models.provider} that the config chose is not in the job`);
  }
  const apiKey = (own.own === 'openrouter' ? own.apiKey : null) ?? job.provider?.apiKey;
  if (!apiKey) throw new Error('no model key: set PROVIDER_API_KEY on the runner, or mark the runner as trusted');
  return { kind: 'openrouter', apiKey, baseUrl: own.own === 'openrouter' ? own.baseUrl : undefined, config: providerLevelConfig(job.level, 'openrouter', chosen) };
}

type Checkout = Awaited<ReturnType<typeof clonePullRequest>>;
type Workspace = { checkout: Checkout; env: Record<string, string>; model: Model; fetch: typeof fetch };

/** Clones the pull request, runs `work` in its checkout with the git environment, and removes it. */
async function withCheckout<T>(job: Job, deps: JobDependencies, signal: AbortSignal, work: (ws: Workspace) => Promise<T>): Promise<T> {
  const model = chooseModel(job, deps.config.provider);

  await mkdir(deps.config.workDir, { recursive: true });
  const cloneUrl = deps.cloneUrl?.(job) ?? job.repo.cloneUrl;
  const env = gitEnvironment(cloneUrl, job.installationToken.token, deps.gitProtocols);
  let checkout;
  try {
    checkout = await clonePullRequest({
      workDir: deps.config.workDir,
      cloneUrl,
      headSha: job.pullRequest.headSha,
      baseRef: job.pullRequest.baseRef,
      env,
      retryDelaysMs: deps.cloneRetryDelaysMs,
      onRetry: (attempt, error) => log('warn', 'job.clone_retry', { jobId: job.id, attempt, error: errorMessage(error) }),
      signal,
    });
  } catch (error) {
    throw new Error(`clone failed: ${errorMessage(error)}`);
  }
  try {
    signal.throwIfAborted();
    const modelFetch = deps.modelFetch ?? globalThis.fetch;
    // A cancelled job stops its model call, so it costs nothing more.
    const fetch = ((url: string, init: RequestInit = {}) =>
      modelFetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal })) as typeof globalThis.fetch;
    const ws = { checkout, env, model, fetch };
    return await withEnvironment(env, () => work(ws));
  } finally {
    await checkout.remove();
  }
}

/**
 * The review of a job, or, with the feature `reuse` (REV-89), the head of the last review when this
 * head reads the same input: the service publishes that review again.
 */
async function reviewJob(job: Extract<Job, { kind: 'review' }>, deps: JobDependencies, signal: AbortSignal): Promise<ReviewPayload | UnchangedPayload> {
  // A service that sends `reuse` (null too) reads the keys of REV-89 in the result.
  const reuse = job.reuse;
  const readsReuse = reuse !== undefined;
  return withCheckout(job, deps, signal, async ({ checkout, model, fetch }) => {
    const result = await reviewUnlessUnchanged({
      repoDir: checkout.repoDir,
      base: checkout.base,
      head: checkout.head,
      level: job.level,
      config: model.config,
      kind: model.kind,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      // REV-19. The rules come with the job, from the service: never from the checkout.
      rules: job.rules ?? [],
      // REV-71. The answered threads come with the job, already cleaned by the service.
      threads: openThreads(job.threads ?? []),
      previousKey: reuse?.key ?? null,
      // REV-88. The last review, to read only what changed since its head.
      delta: reuse?.delta ? { since: reuse.head, ...reuse.delta } : null,
      // REV-95. The findings that a person set aside, with their cause, from the service.
      rejected: job.kind === 'review' ? (job.rejected ?? []) : [],
      // REV-99. Every finding of the pull request, and the last review at this level, from the service.
      earlier: job.earlier ?? null,
      // REV-100. The last commit that a review of Kentō read on the pull request, from the service.
      reviewed: job.reviewed ?? null,
      fetch,
      log: (message) => log('warn', 'job.model_attempt_failed', { jobId: job.id, error: message }),
    });
    if ('unchanged' in result) {
      // REV-89. `reuse` is set: the key can only match it.
      log('info', 'job.review_unchanged', { jobId: job.id, of: reuse!.head, diffHash: result.diffHash });
      return { level: result.level, base: result.base, head: result.head, of: reuse!.head, diffHash: result.diffHash, reuseKey: result.reuseKey };
    }
    if (job.rules !== undefined) {
      // The trace of the rules: those that the job carried, and those that the pack held.
      log('info', 'job.rules', { jobId: job.id, received: job.rules.map((r) => r.id), packed: result.rules.map((r) => r.id) });
    }
    for (const f of result.refutedInThread) log('info', 'job.finding_refuted_in_thread', { jobId: job.id, path: f.path, title: f.title });
    if (result.delta) log('info', 'job.review_incremental', { jobId: job.id, since: result.delta.since, files: result.delta.files.length });
    // REV-88. The floor lifted the score of the model: a line to check it against the reviews.
    if (result.scoreFloor) log('info', 'job.score_floored', { jobId: job.id, model: result.scoreFloor.model, kept: result.scoreFloor.kept });
    for (const f of result.droppedAsRejected) log('info', 'job.finding_dropped_as_rejected', { jobId: job.id, path: f.path, title: f.title });
    // REV-99. The findings linked to an earlier finding, and those that continued a settled one.
    if (job.earlier) log('info', 'job.earlier_findings', { jobId: job.id, held: result.earlier.length, byModel: result.followed.byModel, byNet: result.followed.byNet });
    for (const f of result.droppedAsSettled) log('info', 'job.finding_dropped_as_settled', { jobId: job.id, path: f.path, title: f.title });
    // REV-100. The findings on code that the last reviewed commit already held.
    if (job.reviewed !== undefined) log('info', 'job.seen_code', { jobId: job.id, since: result.seenSince, seen: result.findings.filter((f) => f.seen).length });
    // REV-108. The thinking of an Anthropic model goes to the logs only: the protocol has no key for it.
    // REV-113. So does the prompt cache: what the review read and wrote, and what keeps a cache hit.
    if (result.usage.stop_reason) {
      const u = result.usage;
      log('info', 'job.model_usage', {
        jobId: job.id,
        repo: job.repo.fullName,
        pr: job.pullRequest.number,
        reviewLevel: job.level,
        incremental: result.delta !== null,
        contextHash: result.contextHash,
        model: u.model,
        stopReason: u.stop_reason,
        thinkingTokens: u.thinking_tokens ?? null,
        firstTokenMs: u.first_token_ms ?? null,
        firstTextMs: u.first_text_ms ?? null,
        retriedWithoutThinking: u.retried_without_thinking ?? null,
        promptTokens: u.prompt_tokens ?? null,
        cacheRead: u.cache_read_tokens ?? null,
        cacheWrite5m: u.cache_write_5m_tokens ?? null,
        cacheWrite1h: u.cache_write_1h_tokens ?? null,
        systemHash: u.system_hash ?? null,
        schemaHash: u.schema_hash ?? null,
        effort: u.effort ?? null,
        thinking: u.thinking ?? null,
        costUsd: u.cost ?? null,
        // REV-117. The call that links the findings to the rules and the earlier findings: its cost is in `costUsd`.
        linkStatus: result.link.status,
        linkModel: result.link.usage?.model ?? null,
        linkPromptTokens: result.link.usage?.prompt_tokens ?? null,
        linkCompletionTokens: result.link.usage?.completion_tokens ?? null,
        linkCostUsd: result.link.usage?.cost ?? null,
        linkedRules: result.link.rules,
        linkedFollows: result.link.follows,
      });
    }
    if (result.link.status === 'failed') log('warn', 'job.link_failed', { jobId: job.id, error: result.link.error ?? null });
    const sent = payload(result, job.providers !== undefined, readsReuse, job.earlier !== undefined, job.reviewed !== undefined, job.threads !== undefined);
    // A service that sends `delta` reads it in the result.
    return reuse?.delta && result.delta ? { ...sent, delta: { since: result.delta.since, files: result.delta.files.length } } : sent;
  });
}

/** The threads of a job as the engine reads them: a comment with no commit has no `commit` key. */
function openThreads(threads: ResolveThread[]): OpenThread[] {
  return threads.map((t) => ({
    ...t,
    comments: t.comments.map(({ commit, ...c }) => ({ ...c, ...(commit ? { commit } : {}) })),
  }));
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

  return withCheckout(job, deps, signal, async ({ checkout, model, fetch }) => {
    const threads = openThreads(job.resolve.threads);
    // As the Action: the diff of a thread whose commit is gone starts at the merge base.
    const base = mergeBase(checkout.repoDir, checkout.base, checkout.head);
    const { pack, held } = resolvePack(checkout.repoDir, base, checkout.head, threads);
    if (held.length === 0) return empty;
    const { answer, usage } = await askJson<{ threads: ThreadVerdict[] }>(
      {
        kind: model.kind,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
        fetch,
        log: (message) => log('warn', 'job.model_attempt_failed', { jobId: job.id, error: message }),
      },
      model.config,
      'resolve.md',
      pack,
      { name: 'resolve', schema: RESOLVE_SCHEMA },
    );
    const byId = new Map((answer.threads ?? []).map((v) => [v.id, v]));
    const verdicts: ResolvePayload['threads'] = [];
    for (const t of held) {
      const v = byId.get(t.id);
      if (!v || !['fixed', 'answered', 'open'].includes(v.verdict)) {
        // The summary counts it (held − threads), and the next resolve reads it again.
        log('warn', 'job.thread_without_verdict', { jobId: job.id, thread: t.id });
        continue;
      }
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
      ...(job.providers !== undefined ? { costSource: costSourceOf(usage.cost_source, usage.cost) } : {}),
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      held: held.length,
      threads: verdicts,
    };
  });
}

/** Where the cost comes from; an answer of OpenRouter without a cost is `unknown`. */
function costSourceOf(source: CostSource | undefined, cost: number | undefined): CostSource {
  return source ?? (typeof cost === 'number' ? 'provider' : 'unknown');
}

/**
 * The review as the protocol sends it: the result of the engine without the pack and the lines.
 * `withCostSource`: the service reads `costSource` (it sent `providers` with the job).
 * `withReuse`: the service reads `diffHash`, `reuseKey` and `cachedTokens` (it sent `reuse`, REV-89).
 * `withFollows`: the service reads `follows` (it sent `earlier`, REV-99).
 * `withSeen`: the service reads `seen` (it sent `reviewed`, REV-100).
 * `withRefuted`: the service reads `refutedThreads` (it sent `threads` to a runner that claims
 * `refuted`, REV-96: a service of an earlier release refuses that claim).
 */
export function payload(
  result: ReviewResult,
  withCostSource = false,
  withReuse = false,
  withFollows = false,
  withSeen = false,
  withRefuted = false,
): ReviewPayload {
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
    ...(withCostSource ? { costSource: costSourceOf(usage.cost_source, usage.cost) } : {}),
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
      // REV-104. The service of this job accepted the claim of the feature `patch`, so it reads the key.
      ...(f.patch ? { patch: cut(f.patch, 20_000) } : {}),
      anchor: f.anchor,
      blocking: f.blocking,
      suggestion_range: f.suggestion_range,
      fingerprint: f.fingerprint,
      // A finding without a rule sends no key: a service of an earlier release refuses a key it does not know.
      ...(f.rule_id ? { rule_id: f.rule_id } : {}),
      // REV-99. Only to a service that sent `earlier`: an earlier release refuses a key it does not know.
      ...(withFollows && f.follows ? { follows: f.follows } : {}),
      // KNT-167. Only to a service that sent `earlier`, which accepted the claim of `reverses`.
      ...(withFollows && f.reverses ? { reverses: f.reverses } : {}),
      // REV-100. Only to a service that sent `reviewed`.
      ...(withSeen && f.seen ? { seen: true } : {}),
    })),
    notReviewed: (answer.not_reviewed ?? []).slice(0, 200).map((item) => cut(item, 1000)),
    // KNT-153. The claim of the feature `questions` passed: the service reads the key.
    ...(answer.questions?.length ? { questions: answer.questions.slice(0, 20).map((q) => ({ path: cut(q.path ?? '', 1000), question: cut(q.question, 2000) })) } : {}),
    skipped: result.skipped.slice(0, 2000).map((item) => cut(item, 1000)),
    ...(withReuse ? { diffHash: result.diffHash, reuseKey: result.reuseKey, cachedTokens: usage.cache_read_tokens ?? null } : {}),
    // REV-96. The ids come from the threads of the job: at most MAX_RESOLVE_THREADS of them.
    ...(withRefuted && result.refutedThreads.length ? { refutedThreads: [...new Set(result.refutedThreads)].slice(0, MAX_RESOLVE_THREADS) } : {}),
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
