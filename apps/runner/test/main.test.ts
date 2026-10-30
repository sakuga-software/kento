// The entry point, as a process: what the runner does when the service refuses its token.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const RUNNER_TOKEN = 'kento_rt_RunnerTokenOfTheTest_0123456789abcdef';
let root = '';
before(() => {
  root = mkdtempSync(join(tmpdir(), 'kento-runner-main-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

/** Starts `node src/main.ts` against a service that answers 401 to everything, and reads its log. */
async function startRefused(env: Record<string, string>, delayMs = 0) {
  const server = createServer((request, response) => {
    request.resume();
    setTimeout(() => response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}'), delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: join(import.meta.dirname, '..'),
    env: { PATH: process.env.PATH!, KENTO_URL: `http://127.0.0.1:${port}`, KENTO_RUNNER_NAME: 'test-runner', ...env },
  });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (out += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const lines = () => out.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; error?: string });
  return { child, exited, lines, close: () => server.close() };
}

test('a refused registration token says to make a new one, and waits instead of exiting into a restart loop', async () => {
  const run = await startRefused({ KENTO_REGISTRATION_TOKEN: 'kento_reg_expired-0000000000000000', KENTO_STATE_DIR: mkdtempSync(join(root, 'state-')) });
  try {
    const early = await Promise.race([run.exited.then(() => 'exited'), new Promise((resolve) => setTimeout(resolve, 1500, 'running'))]);
    assert.equal(early, 'running', 'a process that exits is started again by --restart unless-stopped');
    const refused = run.lines().filter((line) => line.event.startsWith('runner.'));
    assert.deepEqual(refused.map((line) => line.event), ['runner.registration_refused']);
    assert.match(refused[0]!.error!, /registration token/);
    assert.match(refused[0]!.error!, /new token on the Runners screen/);
    assert.doesNotMatch(refused[0]!.error!, /runner\.json/, 'no runner.json exists yet');
    assert.doesNotMatch(run.lines().map((line) => JSON.stringify(line)).join('\n'), /kento_reg_expired/);
    run.child.kill('SIGTERM');
    assert.equal(await run.exited, 1);
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
    const early = await Promise.race([run.exited.then(() => 'exited'), new Promise((resolve) => setTimeout(resolve, 1500, 'running'))]);
    assert.equal(early, 'running');
    const refused = run.lines().filter((line) => line.event === 'runner.token_refused');
    assert.equal(refused.length, 1);
    assert.match(refused[0]!.error!, /revoked/);
    assert.match(refused[0]!.error!, /new token from the Runners screen/);
    run.child.kill('SIGTERM');
    assert.equal(await run.exited, 1);
    assert.equal(run.lines().at(-1)!.event, 'shutdown.done');
  } finally {
    run.child.kill('SIGKILL');
    run.close();
  }
});

test('a stop that comes before the refusal still ends with shutdown.done', async () => {
  // The service answers late: SIGTERM arrives while the registration is in flight.
  const run = await startRefused({ KENTO_REGISTRATION_TOKEN: 'kento_reg_expired-0000000000000000', KENTO_STATE_DIR: mkdtempSync(join(root, 'state-')) }, 1000);
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    run.child.kill('SIGTERM');
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
