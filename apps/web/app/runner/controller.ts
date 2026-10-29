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
  type RegisterResponse,
  type ResolveInput,
} from '@sakuga-review/protocol'
import { createController } from 'remix/router'

import type { MintInstallationToken } from '../github/installation-token.ts'
import { errorMessage, log } from '../log.ts'
import { createGitHub } from '../publish/github.ts'
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
  /** The model key of the service, for a trusted runner without its own key. */
  providerApiKey: string | null
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

        // A runner without its own OpenRouter key can run a job only with the key of the service,
        // and only when it is trusted. Without that, a claim would take a job only to fail it. A
        // runner of an earlier release does not say the kind of its key: OpenRouter.
        let ownKey = body.hasProviderKey && (body.ownProvider ?? 'openrouter') === 'openrouter'
        if (!ownKey && !deps.providerApiKey) {
          await sleep(claimWaitMs, request.signal)
          return new Response(null, { status: 204 })
        }
        let trustedOnly = !ownKey

        // Long poll: look for a job until one comes or the wait is over. A runner that hangs up
        // stops the loop.
        let deadline = Date.now() + claimWaitMs
        while (!request.signal.aborted) {
          let job = await deps.store.claimJob(runner.id, { trustedOnly, kinds: body.kinds ?? ['review'] })
          if (job) {
            let installationToken
            let resolve: ResolveInput | null = null
            try {
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
              // The job cannot run without a token or its threads. It counts as an attempt: queued
              // again after the backoff, or failed after the last attempt.
              let reason = `${installationToken ? 'review threads' : 'installation token'}: ${errorMessage(cause)}`.slice(0, 1000)
              let released = await deps.store.releaseJob(job.id, runner.id, job.attempt, reason)
              log('error', 'job.installation_token_failed', {
                jobId: job.id,
                runnerId: runner.id,
                attempt: job.attempt,
                state: released,
                error: reason,
              })
              continue
            }
            // The OpenRouter key of the service, for a trusted runner without its own OpenRouter
            // key. A runner of this release reads it in `providers`; an earlier one, in `provider`.
            let serviceKey = job.runnerTrusted && !ownKey && deps.providerApiKey ? deps.providerApiKey : null
            let readsProviders = body.features?.includes('providers') ?? false
            let provider = !readsProviders && serviceKey ? { kind: 'openrouter' as const, apiKey: serviceKey } : null
            let providers: JobProvider[] | undefined = readsProviders
              ? [{ id: 'service', kind: 'openrouter', apiKey: serviceKey, baseUrl: null, models: [] }]
              : undefined
            log('info', 'job.claimed', {
              jobId: job.id,
              attempt: job.attempt,
              runnerId: runner.id,
              repo: job.fullName,
              pr: job.prNumber,
              head: job.headSha,
              keyFromService: serviceKey !== null,
              kind: job.kind,
              ...(resolve ? { threads: resolve.threads.length } : {}),
            })
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
