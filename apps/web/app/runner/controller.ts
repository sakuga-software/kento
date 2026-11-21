import {
  CLAIM_WAIT_SECONDS,
  MAX_BODY_BYTES,
  parseClaimRequest,
  parseHeartbeatRequest,
  parseRegisterRequest,
  parseResultRequest,
  UUID,
  type ApiError,
  type Checked,
  type ClaimRequest,
  type HeartbeatResponse,
  type Job,
  type JobProvider,
  type JobReuse,
  type JobRule,
  type ProviderKind,
  type RegisterResponse,
  type ResolveInput,
  type JobEarlier,
  type RejectedFinding,
  type ResolveThread,
} from '@kento-review/protocol'
import { createController } from 'remix/router'

import { GITHUB_API_URL, type InstallationToken, type MintInstallationToken } from '../github/installation-token.ts'
import { createInstallationTokenCache, type InstallationTokenCache } from '../github/token-cache.ts'
import { errorMessage, log } from '../log.ts'
import { createGitHub, type GitHub } from '../publish/github.ts'
import { providerAad, type SecretBox } from '../providers/secrets.ts'
import { KIND_LABELS } from '../providers/form.ts'
import { idFormHelp, jobModels, jobModelsChosen, SERVICE_PROVIDER, type LevelModels } from '../repo-config/model.ts'
import { readAnsweredThreads, readResolveInput, THREADS_PERMISSIONS } from '../resolve/threads.ts'
import { runnerRoutes } from './routes.ts'
import type { ClaimedJob, RunnerRow, RunnerStore } from './store.ts'
import { bearerToken, hashToken, newRunnerToken, REGISTRATION_TOKEN_PREFIX, sameSecret } from './tokens.ts'

export interface RunnerApiDependencies {
  store: RunnerStore
  /**
   * The registration token of the environment, for a runner of the service. Null closes this way;
   * the tokens of the Runners screen work either way.
   */
  registrationToken: string | null
  /** Null when the GitHub App is not configured: a claim then gives no job. */
  mintInstallationToken: MintInstallationToken | null
  /** The OpenRouter key of the service, for a trusted runner of the service without its own key, when the org has no provider. */
  providerApiKey: string | null
  /**
   * Decrypts the key of a provider of an org (REV-11), for a trusted runner of that org or of the
   * service, for one job. Null without KENTO_SECRETS_KEY: no job of a provider with a key then runs.
   */
  secrets?: SecretBox | null
  /** Called after a review or a resolution is stored: the publisher posts it on GitHub (REV-5). */
  onReviewStored?: () => void
  /** The REST API of GitHub, where the service reads the threads of a resolve job. */
  githubApiUrl?: string
  fetch?: typeof globalThis.fetch
  /** The GitHub server of the App, where the runners clone. `https://github.com` when not given. */
  githubUrl?: string
  /** How long a claim waits for a job, and how often it looks. Tests make them short. */
  claimWaitMs?: number
  claimPollMs?: number
}

/** The token of the runner: `contents: read` (the default of the mint) on the one repository of a job, a new one for each job. */
function mintFor(job: ClaimedJob, mint: MintInstallationToken): Promise<InstallationToken> {
  return mint({ installationId: job.githubInstallationId, githubRepoId: job.githubRepoId })
}

/** What a claim knows of its runner, for each job that it looks at. */
interface Claim {
  runner: RunnerRow
  body: ClaimRequest
  mint: MintInstallationToken
  /** REV-92. The `pull_requests: read` tokens that the service keeps, to read the threads. */
  threadsTokens: InstallationTokenCache
  ownProvider: ClaimRequest['ownProvider']
  ownKey: boolean
  readsProviders: boolean
  secrets: SecretBox | null
}

/** What a job carries besides its key: its rules, the installation token, and for a resolve job its threads. */
interface Prepared {
  rules: JobRule[] | null
  installationToken: InstallationToken
  resolve: ResolveInput | null
  wantsRules: boolean
  /** REV-71. The answered threads of a review job, for a runner that reads them. */
  threads: ResolveThread[] | null
  /** REV-89. The review that the runner may reuse; undefined for a runner that does not read it. */
  reuse: JobReuse | null | undefined
  /** REV-95. The rejected findings of a review job, for a runner that reads them. */
  rejected: RejectedFinding[] | null
  /** REV-99. The findings of the pull request of a review job, for a runner that reads them. */
  earlier: JobEarlier | null
  /** REV-100. The last reviewed commit of the pull request of a review job (null: none), or undefined for a runner that does not read it. */
  reviewed: string | null | undefined
}

/** The provider of a job and its key, in the shape of the release of the runner. */
interface Keys {
  provider: Job['provider']
  providers: JobProvider[] | undefined
  keyFromService: boolean
}

export function createRunnerController(deps: RunnerApiDependencies) {
  let claimWaitMs = deps.claimWaitMs ?? CLAIM_WAIT_SECONDS * 1000
  let claimPollMs = deps.claimPollMs ?? 1000
  let githubUrl = deps.githubUrl ?? 'https://github.com'
  // REV-92. One `pull_requests: read` token per repository while it is valid, for the claims of
  // review and resolve jobs. The token of the runner is never one of them: it is minted for each job.
  let threadsTokens = deps.mintInstallationToken
    ? createInstallationTokenCache({ mint: deps.mintInstallationToken, permissions: THREADS_PERMISSIONS })
    : null

  /** The runner of the request, or the 401 to send. Never says why a token is refused. */
  async function authenticate(request: Request, action: string): Promise<RunnerRow | Response> {
    let token = bearerToken(request)
    let runner = token ? await deps.store.findRunner(hashToken(token)) : null
    if (!runner) {
      log('warn', 'runner.auth_refused', { action })
      return error(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' })
    }
    return runner
  }

  /**
   * What a job needs before it goes to the runner: its rules, the installation token, and for a
   * resolve job its threads. Null when one of them fails: the job is released and counts as an
   * attempt, queued again after the backoff or failed after the last attempt.
   */
  async function prepareJob(job: ClaimedJob, claim: Claim): Promise<Prepared | null> {
    let { runner, body, mint, threadsTokens } = claim
    let wantsRules = body.features?.includes('rules') ?? false
    let rules: JobRule[] | null = null
    let stage = 'rules'
    let installationToken
    let resolve: ResolveInput | null = null
    try {
      // REV-19. The rules of a review job, read at once after the claim (see jobRules), and
      // kept on the job when they go to the runner: the result can cite only these.
      rules = job.kind === 'review' ? await deps.store.jobRules(job.id) : []
      if (wantsRules && job.kind === 'review') await deps.store.recordSentRules(job.id, runner.id, job.attempt, rules)
      stage = 'installation token'
      installationToken = await mintFor(job, mint)
      if (job.kind === 'resolve') {
        // The service reads the threads with its own token; the runner gets them, not the token.
        resolve = await readThreads(job, threadsTokens, (github) => readResolveInput(github, job.fullName, job.prNumber, job.headSha))
      }
    } catch (cause) {
      if (installationToken) stage = 'review threads'
      let reason = `${stage}: ${errorMessage(cause)}`.slice(0, 1000)
      let released = await deps.store.releaseJob(job.id, runner.id, job.attempt, reason)
      // The event names the step that failed; `job.installation_token_failed` keeps its name
      // for the token and the threads, as the dashboards of Grafana read it.
      log('error', stage === 'rules' ? 'job.rules_failed' : 'job.installation_token_failed', {
        jobId: job.id,
        runnerId: runner.id,
        attempt: job.attempt,
        stage,
        state: released,
        error: reason,
      })
      return null
    }
    // REV-71. The answered threads of a review job. A failure costs the review its threads, never
    // the review: it runs as before this release, and the log says why.
    let threads: ResolveThread[] | null = null
    if (job.kind === 'review' && (body.features?.includes('threads') ?? false)) {
      try {
        threads = await readThreads(job, threadsTokens, (github) => readAnsweredThreads(github, job.fullName, job.prNumber))
      } catch (cause) {
        log('warn', 'job.threads_failed', { jobId: job.id, runnerId: runner.id, attempt: job.attempt, error: errorMessage(cause).slice(0, 1000) })
      }
    }
    // REV-95. The findings that a person set aside. A failure costs the review this section only.
    let rejected: RejectedFinding[] | null = null
    if (job.kind === 'review' && (body.features?.includes('rejected') ?? false)) {
      try {
        rejected = await deps.store.jobRejected(job.id, { severity: body.features?.includes('rejected-severity') ?? false })
      } catch (cause) {
        log('warn', 'job.rejected_failed', { jobId: job.id, runnerId: runner.id, attempt: job.attempt, error: errorMessage(cause).slice(0, 1000) })
      }
    }
    // REV-89. The last review that the runner may publish again. A failure costs only the reuse.
    let reuse: JobReuse | null | undefined
    if (job.kind === 'review' && (body.features?.includes('reuse') ?? false)) {
      try {
        // A new attempt (the source moved, or a lease ended) gets a whole review: `reuse` null.
        reuse = job.attempt > 1 ? null : await deps.store.reusableReview(job.id)
        // REV-88. To a runner that reads it, the last review to review only the change since.
        if (reuse && (body.features?.includes('delta') ?? false)) {
          let delta = await deps.store.jobDelta(job.id, reuse, { patch: body.features?.includes('patch') ?? false, reverses: body.features?.includes('reverses') ?? false })
          if (delta) reuse = { ...reuse, delta }
        }
      } catch (cause) {
        reuse = null
        log('warn', 'job.reuse_failed', { jobId: job.id, runnerId: runner.id, attempt: job.attempt, error: errorMessage(cause).slice(0, 1000) })
      }
    }
    // REV-99. Every finding of the pull request. A failure costs the review this section only.
    let earlier: JobEarlier | null = null
    if (job.kind === 'review' && (body.features?.includes('earlier') ?? false)) {
      try {
        earlier = await deps.store.jobEarlier(job.id, { reverses: body.features?.includes('reverses') ?? false })
      } catch (cause) {
        log('warn', 'job.earlier_failed', { jobId: job.id, runnerId: runner.id, attempt: job.attempt, error: errorMessage(cause).slice(0, 1000) })
      }
    }
    // REV-100. The last commit that a review of Kentō read. A failure costs the review this rule only.
    let reviewed: string | null | undefined
    if (job.kind === 'review' && (body.features?.includes('reviewed') ?? false)) {
      try {
        reviewed = await deps.store.jobReviewed(job.id)
      } catch (cause) {
        log('warn', 'job.reviewed_failed', { jobId: job.id, runnerId: runner.id, attempt: job.attempt, error: errorMessage(cause).slice(0, 1000) })
      }
    }
    return { rules, installationToken, resolve, wantsRules, threads, reuse, rejected, earlier, reviewed }
  }

  /**
   * Runs `read` with a client of GitHub that can read the review threads of the repository of a
   * job, and nothing else. The token is the kept one of the repository (REV-92).
   */
  function readThreads<T>(job: ClaimedJob, tokens: InstallationTokenCache, read: (github: GitHub) => Promise<T>): Promise<T> {
    let target = { installationId: job.githubInstallationId, githubRepoId: job.githubRepoId }
    return tokens.run(target, (token) => read(createGitHub({ apiUrl: deps.githubApiUrl ?? GITHUB_API_URL, token: token.token, fetch: deps.fetch })))
  }

  /**
   * The provider of a job and its key. Null when the key cannot go to this runner: the job is
   * released.
   */
  async function prepareJobKey(job: ClaimedJob, claim: Claim): Promise<Keys | null> {
    let { runner, ownProvider, ownKey, readsProviders, secrets } = claim
    if (!job.provider) {
      // The OpenRouter key of the service, for a trusted runner of the service without its own
      // OpenRouter key. A runner of an org never gets it (REV-130): its admin could read the key
      // and spend it outside Kentō. A runner of this release reads it in `providers`; an earlier
      // one, in `provider`.
      let serviceKey = job.runnerTrusted && job.runnerOrgId === null && !ownKey && deps.providerApiKey ? deps.providerApiKey : null
      return {
        provider: !readsProviders && serviceKey ? { kind: 'openrouter', apiKey: serviceKey } : null,
        providers: readsProviders ? [{ id: 'service', kind: 'openrouter', apiKey: serviceKey, baseUrl: null, models: [] }] : undefined,
        keyFromService: serviceKey !== null,
      }
    }
    // The provider of the org. Its key goes only to a trusted runner that does not hold this
    // kind itself; the claim already chose such a runner, and this checks it again.
    let p = job.provider
    let needsKey = p.kind !== ownProvider && !p.runnerHeld
    let apiKey: string | null = null
    if (needsKey) {
      let reason: string | null = null
      if (job.runnerOrgId !== null && job.runnerOrgId !== p.orgId) reason = `the provider "${p.label}" is not of the org of the runner`
      else if (!job.runnerTrusted || !secrets || !p.keyCiphertext) reason = `the provider "${p.label}" needs a trusted runner`
      else {
        try {
          apiKey = secrets.decrypt(p.keyCiphertext, providerAad(p))
        } catch (cause) {
          reason = `the key of the provider "${p.label}" cannot be decrypted: ${errorMessage(cause)}`
        }
      }
      if (reason) {
        let released = await deps.store.releaseJob(job.id, runner.id, job.attempt, reason)
        log('error', 'job.provider_key_unavailable', { jobId: job.id, runnerId: runner.id, providerId: p.id, state: released, error: reason })
        return null
      }
    }
    return {
      provider: null,
      providers: [{ id: p.id, kind: p.kind, apiKey, baseUrl: p.baseUrl, models: p.models[job.level] ?? [] }],
      keyFromService: apiKey !== null,
    }
  }

  /** The job as the runner reads it, with the logs of what it carries and what it leaves out. */
  function jobResponse(job: ClaimedJob, claim: Claim, prepared: Prepared, keys: Keys): Response {
    let { runner, body } = claim
    let { rules, installationToken, resolve, wantsRules, threads, reuse, rejected, earlier, reviewed } = prepared
    let { provider, providers, keyFromService } = keys
    log('info', 'job.claimed', {
      jobId: job.id,
      attempt: job.attempt,
      runnerId: runner.id,
      repo: job.fullName,
      pr: job.prNumber,
      head: job.headSha,
      keyFromService,
      provider: job.provider ? { id: job.provider.id, kind: job.provider.kind } : 'service',
      kind: job.kind,
      ...(resolve ? { threads: resolve.threads.length } : {}),
      ...(threads ? { answeredThreads: threads.length } : {}),
      ...(reuse ? { reuseOf: reuse.head, ...(reuse.delta ? { deltaFindings: reuse.delta.findings.length, settled: reuse.delta.settled.length } : {}) } : {}),
      ...(rejected ? { rejectedFindings: rejected.length } : {}),
      ...(earlier ? { earlierFindings: earlier.findings.length } : {}),
    })
    // REV-12. The models of the config, to a runner that reads them, and only when the job
    // also carries their provider: `service`, or an entry of `providers`. Else the runner
    // would fail the job; it runs the models of the engine instead, and the log says why.
    // KNT-139. The values of Kentō are not a choice: with a default provider of the org, the job
    // runs the models of that provider, and no warning is necessary.
    let models = jobModels(job.config)
    let wantsModels = body.features?.includes('models') ?? false
    let reachable = carriesProvider(models, providers?.map((p) => p.id))
    if (models && jobModelsChosen(job.config) && (!wantsModels || !reachable)) {
      log('warn', 'job.models_not_sent', {
        jobId: job.id,
        runnerId: runner.id,
        provider: models.provider,
        reason: wantsModels ? 'the job does not carry the provider of the config' : 'runner does not read the models of the config',
      })
    }
    // A runner of an earlier release refuses a job with a key that it does not know: it gets
    // no rules, and the log says so.
    let jobRules = rules ?? []
    if (jobRules.length && !wantsRules) {
      log('warn', 'job.rules_not_sent', { jobId: job.id, runnerId: runner.id, rules: jobRules.length, reason: 'runner does not read the rules' })
    } else if (jobRules.length) {
      log('info', 'job.rules_sent', { jobId: job.id, runnerId: runner.id, rules: jobRules.map((r) => r.id) })
    }
    let message = {
      id: job.id,
      attempt: job.attempt,
      level: job.level,
      repo: { fullName: job.fullName, cloneUrl: `${githubUrl}/${job.fullName}.git` },
      pullRequest: { number: job.prNumber, headSha: job.headSha, baseRef: job.baseRef },
      installationToken,
      leaseExpiresAt: job.leaseExpiresAt.toISOString(),
      provider,
      ...(providers ? { providers } : {}),
      ...(models && wantsModels && reachable ? { models } : {}),
      ...(wantsRules && job.kind === 'review' ? { rules: jobRules } : {}),
    }
    return json<Job>(
      200,
      resolve
        ? { ...message, kind: 'resolve', resolve }
        : { ...message, kind: 'review', ...(threads ? { threads } : {}), ...(reuse !== undefined ? { reuse } : {}), ...(rejected ? { rejected } : {}), ...(earlier ? { earlier } : {}), ...(reviewed !== undefined ? { reviewed } : {}) },
    )
  }

  return createController(runnerRoutes, {
    actions: {
      async register({ request }) {
        let given = bearerToken(request)
        // A token of the Runners screen: one use, one hour, and the runner gets the org, the name,
        // the labels and the trust that the admin chose. The body gives only the version.
        if (given?.startsWith(REGISTRATION_TOKEN_PREFIX)) {
          let body = await readJson(request, parseRegisterRequest)
          if (body instanceof Response) return body
          let token = newRunnerToken()
          let registered = await deps.store.registerWithToken({
            registrationHash: hashToken(given),
            version: body.version,
            tokenHash: hashToken(token),
          })
          if (!registered) {
            log('warn', 'runner.registration_refused', { reason: 'screen token unknown, used or expired' })
            return error(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' })
          }
          log('info', 'runner.registered', {
            runnerId: registered.runnerId,
            orgId: registered.orgId,
            name: registered.name,
            labels: registered.labels,
            version: body.version,
          })
          return json<RegisterResponse>(201, { runnerId: registered.runnerId, token })
        }

        if (!deps.registrationToken || !given || !sameSecret(given, deps.registrationToken)) {
          log('warn', 'runner.registration_refused')
          return error(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' })
        }
        let body = await readJson(request, parseRegisterRequest)
        if (body instanceof Response) return body

        let token = newRunnerToken()
        let runnerId = await deps.store.createRunner({ ...body, tokenHash: hashToken(token) })
        log('info', 'runner.registered', { runnerId, name: body.name, labels: body.labels, version: body.version, service: true })
        return json<RegisterResponse>(201, { runnerId, token })
      },

      async claim({ request }) {
        let runner = await authenticate(request, 'claim')
        if (runner instanceof Response) return runner
        let body = await readJson(request, parseClaimRequest)
        if (body instanceof Response) return body
        let mint = deps.mintInstallationToken
        if (!mint || !threadsTokens) {
          // No job can run without the GitHub App. Hold the claim for the whole wait anyway, so that
          // a runner does not call again at once and loop on the service.
          await waitFor(claimWaitMs, request.signal)
          return new Response(null, { status: 204 })
        }

        // The provider that the runner calls on its own. A runner of an earlier release does not say
        // the kind of its key: OpenRouter.
        let ownProvider = body.ownProvider !== undefined ? body.ownProvider : body.hasProviderKey ? 'openrouter' : null
        let ownKey = ownProvider === 'openrouter'
        let readsProviders = body.features?.includes('providers') ?? false
        let secrets = deps.secrets ?? null
        // A runner that holds no provider can run a job only with a key that the service holds, and
        // only when it is trusted. With no such key at all, a claim would take a job only to fail it.
        if (ownProvider === null && !deps.providerApiKey && !(readsProviders && secrets)) {
          await waitFor(claimWaitMs, request.signal)
          return new Response(null, { status: 204 })
        }

        // Long poll: look for a job until one comes or the wait is over. A runner that hangs up
        // stops the loop. A job that cannot go to this runner is released, and the loop looks again.
        let claim: Claim = { runner, body, mint, threadsTokens, ownProvider, ownKey, readsProviders, secrets }
        let deadline = performance.now() + claimWaitMs
        while (!request.signal.aborted) {
          let job = await deps.store.claimJob(runner.id, {
            kinds: body.kinds ?? ['review'],
            ownProvider,
            readsProviders,
            serviceKey: deps.providerApiKey !== null,
            secrets: secrets !== null,
          })
          if (!job) {
            let left = deadline - performance.now()
            if (left <= 0) break
            await sleep(Math.min(claimPollMs, left), request.signal)
            continue
          }
          // REV-62. An id of the wrong form, kept before the form refused it (#66), fails its job here:
          // no token, no call to the provider. The comment of a failed job (#71) gives the reason.
          let wrongId = wrongModelId(job, { wantsModels: body.features?.includes('models') ?? false, readsProviders })
          if (wrongId) {
            let stored = await deps.store.storeResult(job.id, runner.id, job.attempt, { outcome: 'failed', reason: wrongId })
            // Not `stored`: a cancel or the sweep took the job first. It is not this claim's to fail, and
            // a job back in the queue fails at its next claim, its id still wrong.
            log('error', 'job.model_id_refused', { jobId: job.id, runnerId: runner.id, attempt: job.attempt, state: stored, error: wrongId })
            if (stored !== 'stored') log('warn', 'job.model_id_refusal_not_stored', { jobId: job.id, runnerId: runner.id, outcome: stored })
            continue
          }
          let prepared = await prepareJob(job, claim)
          if (!prepared) continue
          let keys = await prepareJobKey(job, claim)
          if (!keys) continue
          return jobResponse(job, claim, prepared, keys)
        }
        return new Response(null, { status: 204 })
      },

      async heartbeat({ request, params }) {
        let runner = await authenticate(request, 'heartbeat')
        if (runner instanceof Response) return runner
        if (!UUID.test(params.id)) return error(404, 'job_not_found')
        let body = await readJson(request, parseHeartbeatRequest)
        if (body instanceof Response) return body
        let outcome = await deps.store.heartbeat(params.id, runner.id, body.attempt)
        switch (outcome.kind) {
          case 'not_found':
            return error(404, 'job_not_found')
          case 'lease_lost':
            log('warn', 'job.lease_lost', { jobId: params.id, runnerId: runner.id, attempt: body.attempt, action: 'heartbeat' })
            return error(409, 'lease_lost')
          case 'finished':
            return error(409, 'job_finished')
          default:
            return json<HeartbeatResponse>(200, {
              leaseExpiresAt: outcome.leaseExpiresAt.toISOString(),
              cancel: outcome.kind === 'cancelled',
            })
        }
      },

      async result({ request, params }) {
        let runner = await authenticate(request, 'result')
        if (runner instanceof Response) return runner
        if (!UUID.test(params.id)) return error(404, 'job_not_found')
        let body = await readJson(request, parseResultRequest)
        if (body instanceof Response) return body

        let { attempt, ...result } = body
        let outcome = await deps.store.storeResult(params.id, runner.id, attempt, result)
        log(outcome === 'stored' ? 'info' : 'warn', 'job.result', {
          jobId: params.id,
          runnerId: runner.id,
          attempt,
          outcome: body.outcome,
          stored: outcome,
          ...(body.outcome === 'done'
            ? {
                score: body.review.score,
                model: body.review.model,
                costUsd: body.review.costUsd,
                promptTokens: body.review.promptTokens,
                // REV-89. What the provider read from its cache, and the hash of the diff.
                ...(body.review.cachedTokens !== undefined ? { cachedTokens: body.review.cachedTokens } : {}),
                ...(body.review.diffHash ? { diffHash: body.review.diffHash } : {}),
              }
            : body.outcome === 'resolved'
              ? { threads: body.resolve.threads.length, model: body.resolve.model, costUsd: body.resolve.costUsd }
              : body.outcome === 'unchanged'
                ? { of: body.unchanged.of, diffHash: body.unchanged.diffHash, costUsd: 0 }
                : { reason: body.reason }),
        })
        switch (outcome) {
          case 'stored':
            if (body.outcome !== 'failed') deps.onReviewStored?.()
            return new Response(null, { status: 204 })
          case 'not_found':
            return error(404, 'job_not_found')
          case 'lease_lost':
            return error(409, 'lease_lost')
          case 'not_running':
            return error(409, 'job_not_running')
          case 'wrong_head':
            return error(422, 'wrong_head')
          case 'wrong_kind':
            return error(422, 'wrong_kind')
        }
      },
    },
  })
}

/**
 * REV-12. Whether the job carries the provider of the models of its config, so that the runner can
 * run them: `service`, or an entry of `providers`. `providers` is undefined for a runner that does
 * not read them, which runs the OpenRouter of the service only.
 */
function carriesProvider(models: LevelModels | null, providers: readonly string[] | undefined): boolean {
  return models !== null && (providers ? providers.includes(models.provider) : models.provider === 'service')
}

/**
 * REV-62. Why the job cannot run: the ids that the runner would send to a provider that refuses
 * their form, or null when every id has the form of its provider.
 *
 * The ids are those that the runner runs, as `jobResponse` sends them: the models of the config when
 * the runner reads them and the job carries their provider (`carriesProvider`, with the providers
 * that `prepareJobKey` sends), else the models of the provider of the org for the level. A job of the
 * service without models of the config runs the models of Kentō, which have the form of OpenRouter.
 */
export function wrongModelId(
  job: Pick<ClaimedJob, 'provider' | 'level' | 'config'>,
  runner: { wantsModels: boolean; readsProviders: boolean },
): string | null {
  let kind: ProviderKind = job.provider?.kind ?? 'openrouter'
  let models = jobModels(job.config)
  // The same list as `prepareJobKey`: the provider of the org, else `service` for a runner that reads them.
  let sent = job.provider ? [job.provider.id] : runner.readsProviders ? [SERVICE_PROVIDER] : undefined
  // The runner runs the models of the config when it gets them, else those of the provider.
  let ids =
    models && runner.wantsModels && carriesProvider(models, sent)
      ? [models.model, ...(models.fallback ? [models.fallback] : [])]
      : (job.provider?.models[job.level] ?? [])
  let wrong = ids.flatMap((id) => {
    let help = idFormHelp(kind, id)
    return help ? [{ id, help }] : []
  })
  if (wrong.length === 0) return null
  let names = wrong.map((w) => w.id).join(', ')
  return `invalid model id for ${KIND_LABELS[kind]}: ${names}. ${wrong[0]!.help}`
}

function json<T>(status: number, body: T, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

function error(status: number, code: string, headers: Record<string, string> = {}, errors?: string[]): Response {
  return json<ApiError>(status, errors ? { error: code, errors } : { error: code }, headers)
}

/**
 * Reads a JSON body of at most MAX_BODY_BYTES and checks it. Returns the value, or the 4xx to send.
 * The size is counted while reading, so a body without Content-Length cannot pass the limit.
 */
async function readJson<T>(request: Request, parse: (value: unknown) => Checked<T>): Promise<T | Response> {
  if (!/^application\/json\b/.test(request.headers.get('Content-Type') ?? '')) {
    return error(415, 'json_required')
  }
  let length = Number(request.headers.get('Content-Length') ?? 0)
  if (length > MAX_BODY_BYTES) return error(413, 'body_too_large')

  let chunks: Uint8Array[] = []
  let size = 0
  if (request.body) {
    let reader = request.body.getReader()
    for (;;) {
      let { done, value } = await reader.read()
      if (done || value === undefined) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        return error(413, 'body_too_large')
      }
      chunks.push(value)
    }
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return error(400, 'invalid_json')
  }
  let checked = parse(value)
  if (!checked.ok) return error(400, 'invalid_body', {}, checked.errors.slice(0, 20))
  return checked.value
}

/**
 * Waits at least `ms` on the clock of `performance.now()`, or until the signal aborts. A timer can
 * fire a little before its time on that clock: the wait then sleeps again for what is left.
 */
async function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  let deadline = performance.now() + ms
  for (let left = ms; left > 0 && !signal.aborted; left = deadline - performance.now()) await sleep(left, signal)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}
