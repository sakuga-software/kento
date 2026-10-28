import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import type { Answer } from '@sakuga-review/engine';
import { parseResultRequest, type Job, type ResultRequest } from '@sakuga-review/protocol';
import { ApiError, createApi, UnauthorizedError } from '../src/api.ts';
import { clonePullRequest, gitEnvironment } from '../src/clone.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { runJob } from '../src/job.ts';
import { output, redact } from '../src/log.ts';
import { runLoop, runnerToken } from '../src/runner.ts';

const INSTALLATION_TOKEN = 'ghs_InstallationTokenOfTheTest0123456789';
const SERVICE_KEY = 'sk-or-v1-service-key-of-the-test';
const RUNNER_KEY = 'sk-or-v1-runner-key-of-the-test';
const RUNNER_TOKEN = 'kento_rt_RunnerTokenOfTheTest_0123456789abcdef';

let root = '';
let source = '';
let base = '';
let head = '';
let logs: string[] = [];

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A repository that serves the pull request over file://, with what a partial clone needs.
before(() => {
  root = mkdtempSync(join(tmpdir(), 'kento-runner-test-'));
  source = join(root, 'source');
  execFileSync('mkdir', [source]);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.email', 'test@example.com');
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'uploadpack.allowFilter', 'true');
  git(source, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  writeFileSync(join(source, 'sum.ts'), 'export function sum(a: number, b: number) {\n  return a + b;\n}\n');
  git(source, 'add', '.');
  git(source, 'commit', '-q', '-m', 'base');
  git(source, 'checkout', '-q', '-b', 'pr');
  writeFileSync(join(source, 'sum.ts'), 'export function sum(a: number, b: number) {\n  return a - b;\n}\n');
  git(source, 'commit', '-q', '-am', 'fix: sum');
  head = git(source, 'rev-parse', 'HEAD');
  git(source, 'checkout', '-q', 'main');
  writeFileSync(join(source, 'other.ts'), 'export const other = 1;\n');
  git(source, 'add', '.');
  git(source, 'commit', '-q', '-m', 'main moves on');
  base = git(source, 'rev-parse', 'HEAD');
});

after(() => rmSync(root, { recursive: true, force: true }));

const write = output.write;
beforeEach(() => {
  logs = [];
  output.write = (_level, line) => {
    logs.push(line);
  };
});
afterEach(() => {
  output.write = write;
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: '0b9c4a52-3f1e-4c55-9a43-2f1a3f0f6b11',
    attempt: 1,
    kind: 'review',
    level: 'lite',
    repo: { fullName: 'sakuga-software/sakuga-review', cloneUrl: 'https://github.com/sakuga-software/sakuga-review.git' },
    pullRequest: { number: 28, headSha: head, baseRef: 'main' },
    installationToken: { token: INSTALLATION_TOKEN, expiresAt: '2027-01-15T09:00:00Z' },
    leaseExpiresAt: '2027-01-15T08:02:00Z',
    provider: null,
    ...overrides,
  };
}

const answer = (): Answer => ({
  confidence_score: 5,
  risk: 'Faible',
  summary: 'Résumé',
  diagram: '',
  findings: [{ path: 'sum.ts', start_line: 2, line: 2, severity: 'major', category: 'bug', confidence: 90, title: 'Soustraction', scenario: 'sum(1, 2) donne -1.', fix: 'a + b', suggestion: '  return a + b;\n' }],
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
});

/** A model that answers as OpenRouter, and records the key of each call. No network. */
function stubModel(options: { hang?: boolean } = {}) {
  const keys: string[] = [];
  const stub = (async (_url: string, init: RequestInit): Promise<Response> => {
    keys.push(String((init.headers as Record<string, string>).Authorization));
    if (options.hang) {
      await new Promise((_, reject) => {
        if (init.signal!.aborted) reject(init.signal!.reason);
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }
    const body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ model: body.model, provider: 'Stub', choices: [{ message: { content: JSON.stringify(answer()) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0042 } }));
  }) as typeof globalThis.fetch;
  return { fetch: stub, keys };
}

/**
 * An API that records the results, as the service would get them. `heartbeatStatus` / `resultStatus`
 * make the service answer with that error status, as when the lease of the attempt is lost (409).
 */
function fakeApi(options: { cancel?: boolean; heartbeatStatus?: number; resultStatus?: number } = {}) {
  const results: ResultRequest[] = [];
  const attempts: number[] = [];
  let heartbeats = 0;
  return {
    results,
    attempts,
    heartbeats: () => heartbeats,
    api: {
      claim: async () => null,
      heartbeat: async (_id: string, attempt: number) => {
        heartbeats++;
        attempts.push(attempt);
        if (options.heartbeatStatus) throw new ApiError(options.heartbeatStatus, `heartbeat: the service answered ${options.heartbeatStatus}`);
        return { leaseExpiresAt: '2027-01-15T08:04:00Z', cancel: options.cancel ?? false };
      },
      result: async (_id: string, body: ResultRequest) => {
        const checked = parseResultRequest(JSON.parse(JSON.stringify(body)));
        assert.ok(checked.ok, `the result is the protocol: ${!checked.ok && checked.errors.join('; ')}`);
        if (options.resultStatus) throw new ApiError(options.resultStatus, `result: the service answered ${options.resultStatus}`);
        results.push(body);
      },
    },
  };
}

const deps = (api: ReturnType<typeof fakeApi>['api'], modelFetch: typeof fetch, apiKey: string | null = null) => ({
  api,
  modelFetch,
  config: { workDir: join(root, 'work'), provider: { kind: 'openrouter' as const, baseUrl: undefined, apiKey } },
  cloneUrl: () => `file://${source}`,
  gitProtocols: 'file',
});

function assertNoSecretInLogs() {
  const all = logs.join('\n');
  for (const secret of [INSTALLATION_TOKEN, SERVICE_KEY, RUNNER_KEY, RUNNER_TOKEN, Buffer.from(`x-access-token:${INSTALLATION_TOKEN}`).toString('base64')]) {
    assert.ok(!all.includes(secret), `a log line holds a secret:\n${all}`);
  }
}

test('a job: partial clone, review by the engine with the stub model, result to the service', async () => {
  const { api, results } = fakeApi();
  const model = stubModel();
  const outcome = await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY } }), deps(api, model.fetch));

  assert.equal(outcome, 'done');
  assert.equal(results.length, 1);
  const result = results[0]!;
  assert.equal(result.outcome, 'done');
  if (result.outcome !== 'done') return;
  assert.equal(result.review.head, head);
  assert.equal(result.review.base, git(source, 'merge-base', base, head), 'the diff starts at the merge base with the base branch');
  assert.equal(result.review.score, 2, 'a blocking finding caps the score at 2');
  assert.equal(result.review.model, 'anthropic/claude-haiku-5.5');
  assert.equal(result.review.costUsd, 0.0042);
  assert.equal(result.review.findings[0]!.anchor, 2);
  assert.deepEqual(model.keys, [`Bearer ${SERVICE_KEY}`], 'without its own key, the runner uses the key of the job');

  assert.deepEqual(readdirSync(join(root, 'work')), [], 'the clone is removed after the job');
  assertNoSecretInLogs();
});

test('the key of the runner comes before the key of the job, and no key fails the job', async () => {
  const model = stubModel();
  const one = fakeApi();
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY } }), deps(one.api, model.fetch, RUNNER_KEY));
  assert.deepEqual(model.keys, [`Bearer ${RUNNER_KEY}`]);

  const two = fakeApi();
  assert.equal(await runJob(job(), deps(two.api, model.fetch)), 'failed');
  assert.deepEqual(two.results, [{ outcome: 'failed', attempt: 1, reason: 'no model key: set PROVIDER_API_KEY on the runner, or mark the runner as trusted' }]);
  assertNoSecretInLogs();
});

test('a failed clone sends a failure whose reason and logs hold no token', async () => {
  const { api, results } = fakeApi();
  const d = { ...deps(api, stubModel().fetch, RUNNER_KEY), cloneUrl: () => `file://${join(root, 'missing')}` };
  assert.equal(await runJob(job(), d), 'failed');
  assert.equal(results[0]!.outcome, 'failed');
  const reason = results[0]!.outcome === 'failed' ? results[0]!.reason : '';
  assert.match(reason, /^clone failed: git fetch failed/);
  assert.ok(!reason.includes(INSTALLATION_TOKEN));
  assert.match(logs.join('\n'), /"level":"warn","event":"job.finished".*"reviewLevel":"lite".*"outcome":"failed"/);
  assertNoSecretInLogs();
});

test('a job that the service cancels stops its model call and sends nothing', async () => {
  const { api, results, heartbeats } = fakeApi({ cancel: true });
  const d = { ...deps(api, stubModel({ hang: true }).fetch, RUNNER_KEY), heartbeatMs: 50 };
  assert.equal(await runJob(job(), d), 'cancelled');
  assert.ok(heartbeats() >= 1);
  assert.deepEqual(results, []);
});

test('a job whose lease went to another attempt stops at the next heartbeat and sends nothing', async () => {
  const { api, results, attempts } = fakeApi({ heartbeatStatus: 409 });
  const model = stubModel({ hang: true });
  const d = { ...deps(api, model.fetch, RUNNER_KEY), heartbeatMs: 50 };
  assert.equal(await runJob(job({ attempt: 2 }), d), 'lost');
  assert.deepEqual(results, []);
  assert.ok(attempts.length >= 1 && attempts.every((a) => a === 2), `the heartbeat sends the attempt of the job: ${attempts}`);
  assert.match(logs.join('\n'), /"event":"job.lease_lost"/);
  assert.match(logs.join('\n'), /"event":"job.finished".*"outcome":"lost"/);
});

test('a result that the service refuses with 409 ends the job as lost, without an error', async () => {
  const { api, results } = fakeApi({ resultStatus: 409 });
  assert.equal(await runJob(job(), deps(api, stubModel().fetch, RUNNER_KEY)), 'lost');
  assert.deepEqual(results, []);
  assert.match(logs.join('\n'), /"event":"job.finished".*"outcome":"lost"/);
});

test('a review refused with 400, then a failure refused with 409, ends the job as lost', async () => {
  const sent: string[] = [];
  const { api } = fakeApi();
  const statuses = [400, 409];
  const refusing = {
    ...api,
    result: async (_id: string, body: ResultRequest) => {
      sent.push(body.outcome);
      const status = statuses.shift()!;
      throw new ApiError(status, `result: the service answered ${status}`);
    },
  };
  assert.equal(await runJob(job(), deps(refusing, stubModel().fetch, RUNNER_KEY)), 'lost');
  assert.deepEqual(sent, ['done', 'failed']);
  assert.match(logs.join('\n'), /"event":"job.finished".*"outcome":"lost"/);
});

test('a heartbeat that fails for another reason does not stop the job', async () => {
  const { api, results, heartbeats } = fakeApi({ heartbeatStatus: 503 });
  // A model that answers after a few heartbeats.
  const slow = (async (url: string, init: RequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return stubModel().fetch(url, init);
  }) as typeof fetch;
  assert.equal(await runJob(job(), { ...deps(api, slow, RUNNER_KEY), heartbeatMs: 30 }), 'done');
  assert.ok(heartbeats() >= 2);
  assert.equal(results[0]!.outcome, 'done');
});

test('the heartbeat stops when the job ends, also when it ends in a failure', async () => {
  const { api, heartbeats } = fakeApi();
  // A model that fails after a few heartbeats.
  const failing = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    throw new Error('the model is down');
  }) as unknown as typeof fetch;
  assert.equal(await runJob(job(), { ...deps(api, failing, RUNNER_KEY), heartbeatMs: 20 }), 'failed');
  const count = heartbeats();
  assert.ok(count >= 1, 'the job sent heartbeats while it ran');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(heartbeats(), count, 'no heartbeat after the end of the job');
});

test('a runner that stops in the middle of a job sends nothing, so the job can be taken again', async () => {
  const { api, results } = fakeApi();
  const stop = new AbortController();
  const pending = runJob(job(), { ...deps(api, stubModel({ hang: true }).fetch, RUNNER_KEY), signal: stop.signal });
  setTimeout(() => stop.abort(new Error('the runner received SIGTERM')), 300);
  assert.equal(await pending, 'interrupted');
  assert.deepEqual(results, [], 'no failure is sent for a stop of the runner');
  assert.match(logs.join('\n'), /"event":"job.finished".*"outcome":"interrupted"/);
});

test('the clone is bare, and keeps the token out of the remote URL and the files of the repository', async () => {
  const work = mkdtempSync(join(root, 'clone-'));
  const env = gitEnvironment(`file://${source}`, INSTALLATION_TOKEN, 'file');
  const checkout = await clonePullRequest({ workDir: work, cloneUrl: `file://${source}`, headSha: head, baseRef: 'main', env });
  try {
    assert.equal(checkout.base, base);
    assert.equal(git(checkout.repoDir, 'config', '--get', 'remote.origin.url'), `file://${source}`);
    assert.equal(git(checkout.repoDir, 'rev-parse', '--is-bare-repository'), 'true', 'no checkout: no file of the pull request is written');
    const grep = spawnSync('grep', ['-rl', INSTALLATION_TOKEN, checkout.repoDir], { encoding: 'utf8' });
    assert.equal(grep.status, 1, `grep found the token in: ${grep.stdout}`);
  } finally {
    await checkout.remove();
  }
});

test('git sends the token as a basic header, and a failed clone leaves nothing', async () => {
  const seen: (string | undefined)[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    seen.push(request.headers.authorization);
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const url = `http://127.0.0.1:${port}/o/r.git`;
    const work = mkdtempSync(join(root, 'http-'));
    await assert.rejects(
      clonePullRequest({ workDir: work, cloneUrl: url, headSha: head, baseRef: 'main', env: gitEnvironment(url, INSTALLATION_TOKEN, 'http') }),
      (error: Error) => !error.message.includes(INSTALLATION_TOKEN),
    );
    assert.ok(seen.length >= 1);
    assert.equal(seen[0], `basic ${Buffer.from(`x-access-token:${INSTALLATION_TOKEN}`).toString('base64')}`);
    assert.deepEqual(readdirSync(work), [], 'a failed clone leaves nothing');
  } finally {
    server.close();
  }
});

test('a refused runner token stops the loop', async () => {
  const api = createApi('http://127.0.0.1:1', RUNNER_TOKEN, (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as unknown as typeof fetch);
  await assert.rejects(runLoop(api, deps(fakeApi().api, stubModel().fetch), new AbortController().signal), UnauthorizedError);
  assertNoSecretInLogs();
});

test('the loop claims, runs the job and claims again until it stops', async () => {
  const stop = new AbortController();
  const fake = fakeApi();
  let claims = 0;
  const api = {
    ...fake.api,
    claim: async () => {
      claims++;
      if (claims === 1) return job();
      stop.abort();
      return null;
    },
  };
  await runLoop(api, deps(fake.api, stubModel().fetch, RUNNER_KEY), stop.signal);
  assert.equal(claims, 2);
  assert.equal(fake.results[0]!.outcome, 'done');
});

test('the loop waits between two claims that the service answers at once with no job', async () => {
  const stop = new AbortController();
  let claims = 0;
  // The answer comes after a macrotask, as from the network: without it a fast loop never lets the timer fire.
  const api = { ...fakeApi().api, claim: () => new Promise<null>((resolve) => setImmediate(() => (claims++, resolve(null)))) };
  setTimeout(() => stop.abort(), 500);
  await runLoop(api, { ...deps(fakeApi().api, stubModel().fetch, RUNNER_KEY), minClaimIntervalMs: 200 }, stop.signal);
  assert.ok(claims >= 2 && claims <= 3, `${claims} claims in 500 ms`);
});

test('registers once, keeps the token in runner.json with mode 600, and reads it at the next start', async () => {
  const stateDir = join(root, 'state');
  const calls: { url: string; auth: string }[] = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization! });
    return Response.json({ runnerId: '0b9c4a52-3f1e-4c55-9a43-2f1a3f0f6b12', token: RUNNER_TOKEN }, { status: 201 });
  }) as typeof fetch;
  const config = { stateDir, kentoUrl: 'https://review.example', registrationToken: 'registration-secret', name: 'runners-host', labels: ['linux'] };

  const first = await runnerToken(config, doFetch);
  const second = await runnerToken({ ...config, registrationToken: null }, doFetch);
  assert.deepEqual(first, second);
  assert.equal(first.token, RUNNER_TOKEN);
  assert.deepEqual(calls, [{ url: 'https://review.example/api/runner/register', auth: 'Bearer registration-secret' }]);
  assert.equal(statSync(join(stateDir, 'runner.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'runner.json'), 'utf8')).token, RUNNER_TOKEN);
  assertNoSecretInLogs();
});

test('the configuration wants an https service and a known provider, and never prints a value', () => {
  const config = loadConfig({ KENTO_URL: 'https://review.sakuga.dev/', KENTO_RUNNER_LABELS: 'linux, x64', KENTO_RUNNER_NAME: 'runners-host', PROVIDER_API_KEY: RUNNER_KEY });
  assert.equal(config.kentoUrl, 'https://review.sakuga.dev');
  assert.deepEqual(config.labels, ['linux', 'x64']);
  assert.equal(config.provider.kind, 'openrouter');
  assert.equal(config.provider.apiKey, RUNNER_KEY);
  assert.equal(loadConfig({ KENTO_URL: 'http://127.0.0.1:3000' }).kentoUrl, 'http://127.0.0.1:3000');

  assert.throws(
    () => loadConfig({ KENTO_URL: 'http://review.sakuga.dev', PROVIDER_KIND: 'secret-provider', PROVIDER_BASE_URL: 'http://x', KENTO_RUNNER_LABELS: 'a b' }),
    (error: Error) =>
      error instanceof ConfigError &&
      /KENTO_URL must be an https:\/\/ URL/.test(error.message) &&
      /PROVIDER_KIND must be one of openrouter/.test(error.message) &&
      /PROVIDER_BASE_URL/.test(error.message) &&
      /KENTO_RUNNER_LABELS/.test(error.message) &&
      !error.message.includes('secret-provider'),
  );
});

test('redact removes GitHub tokens, runner tokens and URL credentials that the runner does not know', () => {
  assert.equal(redact('ghs_abcdefghijklmnopqrstuvwxyz0123 and kento_rt_abcdefghijklmnopqrstuvwxyz'), '[redacted] and [redacted]');
  assert.equal(redact('fatal: https://x-access-token:abc@github.com/a/b.git'), 'fatal: https://[redacted]@github.com/a/b.git');
});
