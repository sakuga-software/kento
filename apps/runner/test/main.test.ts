// The entry point, as a process: what the runner does when the service refuses its token.
// The tests wait for events (a log line, a request, an exit), never for a time: a slow machine only
// makes them slower.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const RUNNER_TOKEN = 'kento_rt_RunnerTokenOfTheTest_0123456789abcdef';
let root = '';
before(() => {
  root = mkdtempSync(join(tmpdir(), 'kento-runner-main-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

type Line = { event: string; error?: string };

/**
 * Starts `node src/main.ts` against a service that answers 401 to everything, and reads its log.
 * With `hold`, the service keeps each request until `release()`.
 */
async function startRefused(env: Record<string, string>, options: { hold?: boolean } = {}) {
  const held: ServerResponse[] = [];
  let received!: () => void;
  const firstRequest = new Promise<void>((resolve) => (received = resolve));
  const refuse = (response: ServerResponse) => response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}');
  const server = createServer((request, response) => {
    request.resume();
    received();
    if (options.hold) held.push(response);
    else refuse(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: join(import.meta.dirname, '..'),
    env: { PATH: process.env.PATH!, KENTO_URL: `http://127.0.0.1:${port}`, KENTO_RUNNER_NAME: 'test-runner', ...env },
  });
  let out = '';
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const lines = () => out.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Line);
  const read = (chunk: Buffer) => (out += chunk);
  child.stdout.on('data', read);
  child.stderr.on('data', read);

  /** Resolves when the log has a line with this event. Rejects when the process exits first. */
  function logged(event: string): Promise<Line> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const line = lines().find((l) => l.event === event);
        if (!line) return false;
        child.stdout.off('data', check);
        child.stderr.off('data', check);
        resolve(line);
        return true;
      };
      if (check()) return;
      child.stdout.on('data', check);
      child.stderr.on('data', check);
      void exited.then((code) => {
        if (!check()) reject(new Error(`the runner exited with ${code} before ${event}: ${out}`));
      });
    });
  }

  return {
    child,
    exited,
    lines,
    logged,
    firstRequest,
    release: () => held.splice(0).forEach(refuse),
    close: () => server.close(),
  };
}

test('a refused registration token says to make a new one, and waits instead of exiting into a restart loop', async () => {
  const run = await startRefused({ KENTO_REGISTRATION_TOKEN: 'kento_reg_expired-0000000000000000', KENTO_STATE_DIR: mkdtempSync(join(root, 'state-')) });
  try {
    const refused = await run.logged('runner.registration_refused');
    assert.match(refused.error!, /registration token/);
    assert.match(refused.error!, /new token on the Runners screen/);
    assert.doesNotMatch(refused.error!, /runner\.json/, 'no runner.json exists yet');
    // A process that exits is started again by --restart unless-stopped: it must wait for the stop.
    run.child.kill('SIGTERM');
    assert.equal(await run.exited, 1);
    assert.deepEqual(
      run.lines().map((line) => line.event),
      ['runner.registration_refused', 'shutdown.started', 'shutdown.done'],
    );
    assert.doesNotMatch(run.lines().map((line) => JSON.stringify(line)).join('\n'), /kento_reg_expired/);
  } finally {
    run.child.kill('SIGKILL');
    run.close();
  }
});

test('a refused runner token says how to register again, and waits until it is stopped', async () => {
  const stateDir = mkdtempSync(join(root, 'state-'));
  writeFileSync(join(stateDir, 'runner.json'), JSON.stringify({ runnerId: '0b9c4a52-3f1e-4c55-9a43-2f1a3f0f6b12', token: RUNNER_TOKEN }), { mode: 0o600 });
  const run = await startRefused({ KENTO_STATE_DIR: stateDir });
  try {
    const refused = await run.logged('runner.token_refused');
    assert.match(refused.error!, /revoked/);
    assert.match(refused.error!, /new token from the Runners screen/);
    run.child.kill('SIGTERM');
    assert.equal(await run.exited, 1);
    assert.deepEqual(
      run.lines().map((line) => line.event).filter((event) => event !== 'startup.ready'),
      ['runner.token_refused', 'shutdown.started', 'shutdown.done'],
    );
  } finally {
    run.child.kill('SIGKILL');
    run.close();
  }
});

test('a stop that comes before the refusal still ends with shutdown.done', async () => {
  // SIGTERM arrives while the service holds the registration.
  const run = await startRefused({ KENTO_REGISTRATION_TOKEN: 'kento_reg_expired-0000000000000000', KENTO_STATE_DIR: mkdtempSync(join(root, 'state-')) }, { hold: true });
  try {
    await run.firstRequest;
    run.child.kill('SIGTERM');
    await run.logged('shutdown.started');
    run.release();
    assert.equal(await run.exited, 1);
    assert.deepEqual(
      run.lines().map((line) => line.event),
      ['shutdown.started', 'runner.registration_refused', 'shutdown.done'],
    );
  } finally {
    run.child.kill('SIGKILL');
    run.close();
  }
});
