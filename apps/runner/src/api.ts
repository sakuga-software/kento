// The client of the runner API of the web service. It checks every answer against packages/protocol.
import {
  CLAIM_WAIT_SECONDS,
  parseHeartbeatResponse,
  parseJob,
  parseRegisterResponse,
  PATHS,
  type Checked,
  type ClaimRequest,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type Job,
  type RegisterRequest,
  type RegisterResponse,
  type ResultRequest,
} from '@kento-review/protocol';

/** The service refused the runner token (401): it is wrong or revoked. */
export class UnauthorizedError extends Error {
  override name = 'UnauthorizedError';
}

/**
 * The service refused the registration token (401): it expired, it was already used, or an admin
 * cancelled it. The runner has no token of its own yet.
 */
export class RegistrationRefusedError extends UnauthorizedError {
  override name = 'RegistrationRefusedError';
}

/**
 * The service no longer gives this attempt of the job to the runner (409, or 404 for a job that is
 * gone): its lease ended and the job went back to the queue or to another runner, or the job was
 * cancelled or finished. The runner stops the job and sends nothing more.
 */
export function isJobLost(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.status === 404);
}

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type KentoApi = {
  claim(body: ClaimRequest, signal?: AbortSignal): Promise<Job | null>;
  heartbeat(jobId: string, attempt: number): Promise<HeartbeatResponse>;
  result(jobId: string, body: ResultRequest): Promise<void>;
};

export async function register(baseUrl: string, registrationToken: string, body: RegisterRequest, doFetch: typeof fetch = fetch): Promise<RegisterResponse> {
  const response = await post(doFetch, baseUrl, PATHS.register, registrationToken, body, AbortSignal.timeout(30_000));
  if (response.status === 401) throw new RegistrationRefusedError('register: the service refused the registration token');
  if (response.status !== 201) throw await failure(response, 'register');
  return checked(parseRegisterResponse(await response.json()), 'register');
}

export function createApi(baseUrl: string, runnerToken: string, doFetch: typeof fetch = fetch): KentoApi {
  return {
    async claim(body, signal) {
      // The service holds the claim for up to CLAIM_WAIT_SECONDS; wait a little more for the answer.
      const timeout = AbortSignal.timeout((CLAIM_WAIT_SECONDS + 15) * 1000);
      const response = await post(doFetch, baseUrl, PATHS.claim, runnerToken, body, signal ? AbortSignal.any([signal, timeout]) : timeout);
      if (response.status === 204) return null;
      if (response.status !== 200) throw await failure(response, 'claim');
      return checked(parseJob(await response.json()), 'claim');
    },
    async heartbeat(jobId, attempt) {
      const body: HeartbeatRequest = { attempt };
      const response = await post(doFetch, baseUrl, PATHS.heartbeat(jobId), runnerToken, body, AbortSignal.timeout(15_000));
      if (response.status !== 200) throw await failure(response, 'heartbeat');
      return checked(parseHeartbeatResponse(await response.json()), 'heartbeat');
    },
    async result(jobId, body) {
      const response = await post(doFetch, baseUrl, PATHS.result(jobId), runnerToken, body, AbortSignal.timeout(30_000));
      if (response.status !== 204) throw await failure(response, 'result');
    },
  };
}

function post(doFetch: typeof fetch, baseUrl: string, path: string, token: string, body: unknown, signal: AbortSignal): Promise<Response> {
  return doFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'kento-runner' },
    body: JSON.stringify(body),
    signal,
  });
}

async function failure(response: Response, action: string): Promise<Error> {
  const text = (await response.text().catch(() => '')).slice(0, 500);
  if (response.status === 401) return new UnauthorizedError(`${action}: the service refused the token`);
  return new ApiError(response.status, `${action}: the service answered ${response.status} ${text}`);
}

function checked<T>(result: Checked<T>, action: string): T {
  if (!result.ok) throw new Error(`${action}: the service answer does not match the runner protocol (${result.errors.slice(0, 5).join('; ')}); run the runner version that the Runners screen shows`);
  return result.value;
}
