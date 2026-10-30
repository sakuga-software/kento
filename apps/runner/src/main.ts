// Entry point of the kento-runner image: `node src/main.ts`.
import { RegistrationRefusedError, UnauthorizedError } from './api.ts';
import { loadConfig } from './config.ts';
import { addSecret, errorMessage, log } from './log.ts';
import { runLoop, runnerToken, start, VERSION } from './runner.ts';

let config;
try {
  config = loadConfig();
} catch (error) {
  log('error', 'startup.config_invalid', { error: errorMessage(error) });
  process.exit(1);
}
addSecret(config.registrationToken);
addSecret(config.provider.apiKey);

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('info', 'shutdown.started', { signal });
    stop.abort(new Error(`the runner received ${signal}`));
  });
}

try {
  const state = await runnerToken(config);
  log('info', 'startup.ready', { runnerId: state.runnerId, version: VERSION, url: config.kentoUrl, ownKey: config.provider.apiKey !== null });
  await runLoop(start(config, state), { config }, stop.signal);
  log('info', 'shutdown.done');
} catch (error) {
  if (error instanceof RegistrationRefusedError) {
    log('error', 'runner.registration_refused', {
      error:
        'the service refused the registration token: it expired after one hour, was already used, or was cancelled. ' +
        'Create a new token on the Runners screen, then remove this container and start the command of the new token.',
    });
    await refused();
  } else if (error instanceof UnauthorizedError) {
    log('error', 'runner.token_refused', {
      error:
        'the service refused the runner token: the runner was revoked, or runner.json belongs to another service. ' +
        'Remove this container and its state volume, then register again with a new token from the Runners screen.',
    });
    await refused();
  } else {
    log('error', 'runner.stopped', { error: errorMessage(error) });
  }
  process.exit(1);
}

/**
 * A refused token needs a person: a restart cannot fix it. The runner waits until it is stopped,
 * so that a restart policy (`--restart unless-stopped`) does not start it again and again, and the
 * log keeps one line that says what to do.
 */
async function refused(): Promise<void> {
  if (stop.signal.aborted) return;
  const timer = setInterval(() => {}, 1 << 30);
  await new Promise((resolve) => stop.signal.addEventListener('abort', resolve, { once: true }));
  clearInterval(timer);
  log('info', 'shutdown.done');
}
