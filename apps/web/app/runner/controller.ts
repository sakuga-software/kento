import {
  CLAIM_WAIT_SECONDS,
  MAX_BODY_BYTES,
  parseClaimRequest,
  parseRegisterRequest,
  parseResultRequest,
  type ApiError,
  type Checked,
  type HeartbeatResponse,
  type Job,
  type RegisterResponse,
} from '@sakuga-review/protocol'
import { createController } from 'remix/router'

import type { MintInstallationToken } from '../github/installation-token.ts'
import { errorMessage, log } from '../log.ts'
import { runnerRoutes } from './routes.ts'
import type { RunnerRow, RunnerStore } from './store.ts'
import { bearerToken, hashToken, newRunnerToken, sameSecret } from './tokens.ts'

export interface RunnerApiDependencies {
  store: RunnerStore
  /** The secret that `register` asks for. Null closes the registration. */
  registrationToken: string | null
  /** Null when the GitHub App is not configured: a claim then gives no job. */
  mintInstallationToken: MintInstallationToken | null
  /** The model key of the service, for a trusted runner without its own key. */
  providerApiKey: string | null
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
        if (!deps.registrationToken || !given || !sameSecret(given, deps.registrationToken)) {
          log('warn', 'runner.registration_refused')
          return error(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' })
        }
        let body = await readJson(request, parseRegisterRequest)
        if (body instanceof Response) return body

        let token = newRunnerToken()
        let runnerId = await deps.store.createRunner({ ...body, tokenHash: hashToken(token) })
        log('info', 'runner.registered', { runnerId, name: body.name, labels: body.labels, version: body.version })
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

        // A runner without its own model key can run a job only with the key of the service, and
        // only when it is trusted. Without that, a claim would take a job only to fail it.
        if (!body.hasProviderKey && !deps.providerApiKey) {
          await sleep(claimWaitMs, request.signal)
          return new Response(null, { status: 204 })
        }
        let trustedOnly = !body.hasProviderKey

        // Long poll: look for a job until one comes or the wait is over. A runner that hangs up
        // stops the loop.
        let deadline = Date.now() + claimWaitMs
        while (!request.signal.aborted) {
          let job = await deps.store.claimJob(runner.id, { trustedOnly })
          if (job) {
            let installationToken
            try {
              installationToken = await mint({
                installationId: job.githubInstallationId,
                githubRepoId: job.githubRepoId,
              })
            } catch (cause) {
              // The job cannot run without a token; a retry is the work of a later ticket.
              let reason = `installation token: ${errorMessage(cause)}`.slice(0, 1000)
              await deps.store.failJob(job.id, runner.id, reason)
              log('error', 'job.installation_token_failed', { jobId: job.id, runnerId: runner.id, error: reason })
              continue
            }
            let provider =
              job.runnerTrusted && !body.hasProviderKey && deps.providerApiKey
                ? { kind: 'openrouter' as const, apiKey: deps.providerApiKey }
                : null
            log('info', 'job.claimed', {
              jobId: job.id,
              runnerId: runner.id,
              repo: job.fullName,
              pr: job.prNumber,
              head: job.headSha,
              keyFromService: provider !== null,
            })
            return json<Job>(200, {
              id: job.id,
              kind: 'review',
              level: job.level,
              repo: { fullName: job.fullName, cloneUrl: `${githubUrl}/${job.fullName}.git` },
              pullRequest: { number: job.prNumber, headSha: job.headSha, baseRef: job.baseRef },
              installationToken,
              leaseExpiresAt: job.leaseExpiresAt.toISOString(),
              provider,
            })
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
        let outcome = await deps.store.heartbeat(params.id, runner.id)
        switch (outcome.kind) {
          case 'not_found':
            return error(404, 'job_not_found')
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

        let outcome = await deps.store.storeResult(params.id, runner.id, body)
        log(outcome === 'stored' ? 'info' : 'warn', 'job.result', {
          jobId: params.id,
          runnerId: runner.id,
          outcome: body.outcome,
          stored: outcome,
          ...(body.outcome === 'done'
            ? { score: body.review.score, model: body.review.model, costUsd: body.review.costUsd }
            : { reason: body.reason }),
        })
        switch (outcome) {
          case 'stored':
            return new Response(null, { status: 204 })
          case 'not_found':
            return error(404, 'job_not_found')
          case 'not_running':
            return error(409, 'job_not_running')
          case 'wrong_head':
            return error(422, 'wrong_head')
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
