// Entry point of the kento-runner image: `node src/main.ts`.
import { UnauthorizedError } from './api.ts';
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
  if (error instanceof UnauthorizedError) {
    log('error', 'runner.token_refused', { error: 'the service refused the runner token: it is wrong or revoked. Remove runner.json to register again.' });
  } else {
    log('error', 'runner.stopped', { error: errorMessage(error) });
  }
  process.exit(1);
}
