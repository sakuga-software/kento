// The life of a runner: get its token (from its state file, or by registering), then claim and run
// jobs one at a time until it stops.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FEATURES, type JobKind } from '@sakuga-review/protocol';
import { createApi, register, UnauthorizedError, type KentoApi } from './api.ts';
import type { Config } from './config.ts';
import { runJob, type JobDependencies } from './job.ts';
import { addSecret, errorMessage, log } from './log.ts';
import packageJson from '../package.json' with { type: 'json' };

export const VERSION = packageJson.version;

type State = { runnerId: string; token: string };

/** The least time between the start of two claims that gave no job. */
export const MIN_CLAIM_INTERVAL_MS = 5000;

/**
 * The token of the runner. The first start registers with the registration token and writes
 * runner.json (mode 600) in the state directory; the next starts read it. A revoked token is never
 * replaced on its own: the runner stops, and an operator decides.
 */
export async function runnerToken(config: Pick<Config, 'stateDir' | 'kentoUrl' | 'registrationToken' | 'name' | 'labels'>, doFetch: typeof fetch = fetch): Promise<State> {
  const file = join(config.stateDir, 'runner.json');
  try {
    const state = JSON.parse(await readFile(file, 'utf8')) as State;
    if (typeof state.token === 'string' && typeof state.runnerId === 'string') {
      addSecret(state.token);
      return state;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`cannot read ${file}: ${errorMessage(error)}`);
  }
  if (!config.registrationToken) throw new Error(`no runner token in ${file}, and KENTO_REGISTRATION_TOKEN is not set`);
  addSecret(config.registrationToken);
  const state = await register(config.kentoUrl, config.registrationToken, { name: config.name, labels: config.labels, version: VERSION }, doFetch);
  addSecret(state.token);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  // Write then rename, so that a crash never leaves half a file.
  await writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  log('info', 'runner.registered', { runnerId: state.runnerId, name: config.name, labels: config.labels });
  return state;
}

/**
 * Claims and runs jobs until `signal` aborts. A refused token stops the runner (UnauthorizedError).
 * Any other error waits a little longer each time, up to one minute, then claims again.
 */
export async function runLoop(
  api: KentoApi,
  deps: Omit<JobDependencies, 'api' | 'signal'> & { minClaimIntervalMs?: number },
  signal: AbortSignal,
): Promise<void> {
  let delay = 1000;
  // The runner says what it can read in a job, and which provider it calls on its own. An earlier
  // service refuses a claim with these keys: the service is deployed before its runners.
  const ownProvider = deps.config.provider.own;
  const claim = { hasProviderKey: ownProvider !== null, kinds: ['review', 'resolve'] as JobKind[], features: [...FEATURES], ownProvider };
  const minClaimIntervalMs = deps.minClaimIntervalMs ?? MIN_CLAIM_INTERVAL_MS;
  while (!signal.aborted) {
    try {
      const started = Date.now();
      const job = await api.claim(claim, signal);
      delay = 1000;
      if (job) await runJob(job, { ...deps, api, signal });
      // A claim with no job normally waits up to 30 s on the service. One that answers at once (a
      // service without its GitHub App, an older service) must not make the runner loop fast.
      else await sleep(minClaimIntervalMs - (Date.now() - started), signal);
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof UnauthorizedError) throw error;
      log('warn', 'runner.claim_failed', { error: errorMessage(error), retryInMs: delay });
      await sleep(delay, signal);
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

export function start(config: Config, state: State): KentoApi {
  return createApi(config.kentoUrl, state.token);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}
