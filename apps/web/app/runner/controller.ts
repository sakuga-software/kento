import {
  CLAIM_WAIT_SECONDS,
  MAX_BODY_BYTES,
  parseClaimRequest,
  parseHeartbeatRequest,
  parseRegisterRequest,
  parseResultRequest,
  type ApiError,
  type Checked,
  type HeartbeatResponse,
  type Job,
  type JobProvider,
  type JobRule,
  type RegisterResponse,
  type ResolveInput,
} from '@sakuga-review/protocol'
import { createController } from 'remix/router'

import type { MintInstallationToken } from '../github/installation-token.ts'
import { errorMessage, log } from '../log.ts'
import { createGitHub } from '../publish/github.ts'
import { providerAad, type SecretBox } from '../providers/secrets.ts'
import { jobModels } from '../repo-config/model.ts'
import { readResolveInput, THREADS_PERMISSIONS } from '../resolve/threads.ts'
import { runnerRoutes } from './routes.ts'
import type { RunnerRow, RunnerStore } from './store.ts'
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
  /** The OpenRouter key of the service, for a trusted runner without its own key, when the org has no provider. */
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function createRunnerController(deps: RunnerApiDependencies) {
  let claimWaitMs = deps.claimWaitMs ?? CLAIM_WAIT_SECONDS * 1000
  let claimPollMs = deps.claimPollMs ?? 1000
  let githubUrl = deps.githubUrl ?? 'https://github.com'

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
        if (!mint) {
          // No job can run without the GitHub App. Hold the claim for the whole wait anyway, so that
          // a runner does not call again at once and loop on the service.
          await sleep(claimWaitMs, request.signal)
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
          await sleep(claimWaitMs, request.signal)
          return new Response(null, { status: 204 })
        }

        // Long poll: look for a job until one comes or the wait is over. A runner that hangs up
        // stops the loop.
        let deadline = Date.now() + claimWaitMs
        while (!request.signal.aborted) {
          let job = await deps.store.claimJob(runner.id, {
            kinds: body.kinds ?? ['review'],
            ownProvider,
            readsProviders,
            serviceKey: deps.providerApiKey !== null,
            secrets: secrets !== null,
          })
          if (job) {
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
              installationToken = await mint({
                installationId: job.githubInstallationId,
                githubRepoId: job.githubRepoId,
              })
              if (job.kind === 'resolve') {
                // The service reads the threads with its own token; the runner gets them, not the token.
                let threadsToken = await mint({
                  installationId: job.githubInstallationId,
                  githubRepoId: job.githubRepoId,
                  permissions: THREADS_PERMISSIONS,
                })
                let github = createGitHub({ apiUrl: deps.githubApiUrl ?? 'https://api.github.com', token: threadsToken.token, fetch: deps.fetch })
                resolve = await readResolveInput(github, job.fullName, job.prNumber, job.headSha)
              }
            } catch (cause) {
              // The job cannot run without its rules, a token or its threads. It counts as an attempt:
              // queued again after the backoff, or failed after the last attempt.
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
              continue
            }
            let provider: Job['provider'] = null
            let providers: JobProvider[] | undefined
            let keyFromService: boolean
            if (job.provider) {
              // The provider of the org. Its key goes only to a trusted runner that does not hold this
              // kind itself; the claim already chose such a runner, and this checks it again.
              let p = job.provider
              let needsKey = p.kind !== ownProvider && !p.runnerHeld
              let apiKey: string | null = null
              if (needsKey) {
                let reason: string | null = null
                // The claim already chose such a runner; this checks it again before the key is decrypted.
                if (job.runnerOrgId !== null && job.runnerOrgId !== p.orgId) reason = `the provider « ${p.label} » is not of the org of the runner`
                else if (!job.runnerTrusted || !secrets || !p.keyCiphertext) reason = `the provider « ${p.label} » needs a trusted runner`
                else {
                  try {
                    apiKey = secrets.decrypt(p.keyCiphertext, providerAad(p))
                  } catch (cause) {
                    reason = `the key of the provider « ${p.label} » cannot be decrypted: ${errorMessage(cause)}`
                  }
                }
                if (reason) {
                  let released = await deps.store.releaseJob(job.id, runner.id, job.attempt, reason)
                  log('error', 'job.provider_key_unavailable', { jobId: job.id, runnerId: runner.id, providerId: p.id, state: released, error: reason })
                  continue
                }
              }
              providers = [{ id: p.id, kind: p.kind, apiKey, baseUrl: p.baseUrl, models: p.models[job.level] ?? [] }]
              keyFromService = apiKey !== null
            } else {
              // The OpenRouter key of the service, for a trusted runner without its own OpenRouter
              // key. A runner of this release reads it in `providers`; an earlier one, in `provider`.
              let serviceKey = job.runnerTrusted && !ownKey && deps.providerApiKey ? deps.providerApiKey : null
              provider = !readsProviders && serviceKey ? { kind: 'openrouter', apiKey: serviceKey } : null
              providers = readsProviders ? [{ id: 'service', kind: 'openrouter', apiKey: serviceKey, baseUrl: null, models: [] }] : undefined
              keyFromService = serviceKey !== null
            }
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
            })
            // REV-12. The models of the config, to a runner that reads them, and only when the job
            // also carries their provider: `service`, or an entry of `providers`. Else the runner
            // would fail the job; it runs the models of the engine instead, and the log says why.
            let models = jobModels(job.config)
            let wantsModels = body.features?.includes('models') ?? false
            let reachable = models !== null && (providers ? providers.some((p) => p.id === models.provider) : models.provider === 'service')
            if (models && (!wantsModels || !reachable)) {
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
            return json<Job>(200, resolve ? { ...message, kind: 'resolve', resolve } : { ...message, kind: 'review' })
          }
          let left = deadline - Date.now()
          if (left <= 0) break
          await sleep(Math.min(claimPollMs, left), request.signal)
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
            ? { score: body.review.score, model: body.review.model, costUsd: body.review.costUsd }
            : body.outcome === 'resolved'
              ? { threads: body.resolve.threads.length, model: body.resolve.model, costUsd: body.resolve.costUsd }
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
