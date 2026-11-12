import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { findingKey, type Answer } from '@sakuga-review/engine';
import { parseJob, parseResultRequest, type Job, type ResultRequest } from '@sakuga-review/protocol';
import { ApiError, createApi, UnauthorizedError } from '../src/api.ts';
import { clonePullRequest, gitEnvironment, isTransientGitError } from '../src/clone.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { chooseModel, runJob } from '../src/job.ts';
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

// A repository that serves the pull request over file://. The head is fetched by its id.
before(() => {
  root = mkdtempSync(join(tmpdir(), 'kento-runner-test-'));
  source = join(root, 'source');
  execFileSync('mkdir', [source]);
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.email', 'test@example.com');
  git(source, 'config', 'user.name', 'Test');
  // As GitHub, the source accepts a filter: a clone that asks for one would be partial.
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

function job(overrides: Partial<Job> & Record<string, unknown> = {}): Job {
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
  } as Job;
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
  config: { workDir: join(root, 'work'), provider: { kind: 'openrouter' as const, baseUrl: undefined, apiKey, own: apiKey ? ('openrouter' as const) : null } },
  cloneUrl: () => `file://${source}`,
  gitProtocols: 'file',
  cloneRetryDelaysMs: [],
});

function assertNoSecretInLogs() {
  const all = logs.join('\n');
  for (const secret of [INSTALLATION_TOKEN, SERVICE_KEY, RUNNER_KEY, RUNNER_TOKEN, Buffer.from(`x-access-token:${INSTALLATION_TOKEN}`).toString('base64')]) {
    assert.ok(!all.includes(secret), `a log line holds a secret:\n${all}`);
  }
}

test('a job: clone, review by the engine with the stub model, result to the service', async () => {
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
    assert.equal(git(checkout.repoDir, 'rev-list', '--objects', '--missing=print', '--all', head).split('\n').filter((line) => line.startsWith('?')).length, 0, 'every object of the head and of the base is in the clone: no blob to fetch later');
    const grep = spawnSync('grep', ['-rl', INSTALLATION_TOKEN, checkout.repoDir], { encoding: 'utf8' });
    assert.equal(grep.status, 1, `grep found the token in: ${grep.stdout}`);
  } finally {
    await checkout.remove();
  }
});

test('a clone that fails once starts again, and leaves one directory', async () => {
  const work = mkdtempSync(join(root, 'retry-'));
  const late = join(root, 'late-source');
  const url = `file://${late}`;
  const retries: number[] = [];
  const checkout = await clonePullRequest({
    workDir: work,
    cloneUrl: url,
    headSha: head,
    baseRef: 'main',
    env: gitEnvironment(url, INSTALLATION_TOKEN, 'file'),
    retryDelaysMs: [10, 10],
    transient: () => true,
    // The repository appears after the first attempt, as the objects of a push reach every server of GitHub.
    onRetry: (attempt) => {
      retries.push(attempt);
      symlinkSync(source, late);
    },
  });
  try {
    assert.deepEqual(retries, [1]);
    assert.equal(checkout.base, base);
    assert.deepEqual(readdirSync(work), [basename(checkout.repoDir)], 'the failed attempt leaves nothing');
  } finally {
    await checkout.remove();
  }
});

test('a clone that keeps failing stops after its last attempt', async () => {
  const work = mkdtempSync(join(root, 'retry-'));
  const url = `file://${join(root, 'never')}`;
  const retries: number[] = [];
  await assert.rejects(
    clonePullRequest({ workDir: work, cloneUrl: url, headSha: head, baseRef: 'main', env: gitEnvironment(url, INSTALLATION_TOKEN, 'file'), retryDelaysMs: [1, 1], transient: () => true, onRetry: (attempt) => retries.push(attempt) }),
    /git fetch failed/,
  );
  assert.deepEqual(retries, [1, 2]);
  assert.deepEqual(readdirSync(work), []);
});

test('a clone error that a new attempt cannot fix fails at once', async () => {
  const work = mkdtempSync(join(root, 'retry-'));
  const url = `file://${join(root, 'never')}`;
  const retries: number[] = [];
  await assert.rejects(
    clonePullRequest({ workDir: work, cloneUrl: url, headSha: head, baseRef: 'main', env: gitEnvironment(url, INSTALLATION_TOKEN, 'file'), retryDelaysMs: [60_000], onRetry: (attempt) => retries.push(attempt) }),
    /git fetch failed/,
  );
  assert.deepEqual(retries, []);
});

test('an abort stops the wait between two attempts of a clone', async () => {
  const work = mkdtempSync(join(root, 'retry-'));
  const url = `file://${join(root, 'never')}`;
  const controller = new AbortController();
  const started = Date.now();
  await assert.rejects(
    clonePullRequest({ workDir: work, cloneUrl: url, headSha: head, baseRef: 'main', env: gitEnvironment(url, INSTALLATION_TOKEN, 'file'), retryDelaysMs: [60_000], transient: () => true, onRetry: () => controller.abort(), signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.ok(Date.now() - started < 10_000, 'the wait of 60 s did not run');
  assert.deepEqual(readdirSync(work), []);
});

test('only the transient errors of git start a new attempt', () => {
  for (const message of [
    "git fetch failed (1): fatal: bad revision 'a1745bf8'\nerror: https://github.com/o/r.git did not send all necessary objects",
    'git fetch failed (128): error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly',
    'git fetch failed (128): fatal: unable to access \'https://github.com/o/r.git/\': The requested URL returned error: 502',
    'git fetch failed (128): fatal: early EOF',
  ]) {
    assert.ok(isTransientGitError(new Error(message)), message);
  }
  for (const message of [
    "git fetch failed (128): fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 401",
    "git fetch failed (128): fatal: couldn't find remote ref refs/heads/gone",
    "git fetch failed (128): fatal: 'never' does not appear to be a git repository",
  ]) {
    assert.ok(!isTransientGitError(new Error(message)), message);
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
      clonePullRequest({ workDir: work, cloneUrl: url, headSha: head, baseRef: 'main', env: gitEnvironment(url, INSTALLATION_TOKEN, 'http'), retryDelaysMs: [] }),
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

test('a start with no token says where to get one, and calls nothing', async () => {
  const stateDir = join(root, 'state-empty');
  let calls = 0;
  const doFetch = (async () => (calls++, Response.json({}, { status: 201 }))) as unknown as typeof fetch;
  const config = { stateDir, kentoUrl: 'https://review.example', registrationToken: null, name: 'runners-host', labels: [] };
  await assert.rejects(runnerToken(config, doFetch), /KENTO_REGISTRATION_TOKEN is not set: set it to a token from the Runners screen/);
  assert.equal(calls, 0);
});

test('an answer that is not the protocol tells which runner to run; the request stays the same', async () => {
  const sent: { url: string; body: unknown }[] = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ id: 42 }, { status: 201 });
  }) as typeof fetch;
  const config = { stateDir: join(root, 'state-bad'), kentoUrl: 'https://review.example', registrationToken: 'registration-secret', name: 'runners-host', labels: ['linux'] };
  await assert.rejects(runnerToken(config, doFetch), /^Error: register: the service answer does not match the runner protocol \(.+\); run the runner version that the Runners screen shows$/);
  assert.deepEqual(sent.map((s) => s.url), ['https://review.example/api/runner/register']);
  assert.deepEqual(Object.keys(sent[0]!.body as object).sort(), ['labels', 'name', 'version']);
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

// --- resolve ---------------------------------------------------------------------------------

/** A model that answers `resolve`: `fixed` for each thread of the pack, and records the packs. */
function stubResolveModel() {
  const packs: string[] = [];
  const stub = (async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body));
    const pack: string = body.messages[1].content;
    packs.push(pack);
    const ids = [...pack.matchAll(/^## Thread (\S+)$/gm)].map((m) => m[1]!);
    const threads = ids.map((id) => ({ id, verdict: 'fixed', reply: `Corrigé (${id}).` }));
    return new Response(
      JSON.stringify({ model: body.model, provider: 'Stub', choices: [{ message: { content: JSON.stringify({ threads }) } }], usage: { prompt_tokens: 20, completion_tokens: 8, cost: 0.003 } }),
    );
  }) as typeof globalThis.fetch;
  return { fetch: stub, packs };
}

function resolveJob(threads: { id: string; commit: string | null; author?: string; isBot?: boolean }[]): Job {
  return job({
    kind: 'resolve',
    resolve: {
      threads: threads.map((t, i) => ({
        id: t.id,
        path: 'sum.ts',
        line: 2,
        comments: [{ id: 100 + i, author: t.author ?? 'sakuga-review', isBot: t.isBot ?? true, body: 'La somme soustrait.', commit: t.commit }],
      })),
      open: threads.length + 1,
      waiting: threads.length,
    },
  });
}

test('a resolve job: the pack of the threads, one model call, and whether each file changed since its thread', async () => {
  const { api, results } = fakeApi();
  const model = stubResolveModel();
  const first = git(source, 'rev-list', '--max-parents=0', 'pr');
  const job = resolveJob([
    { id: 'PRRT_before', commit: first },
    { id: 'PRRT_at_head', commit: head },
    { id: 'PRRT_gone', commit: 'f'.repeat(40) },
    { id: 'PRRT_unknown', commit: null },
  ]);
  const outcome = await runJob(job, deps(api, model.fetch, RUNNER_KEY));

  assert.equal(outcome, 'done');
  assert.equal(model.packs.length, 1);
  assert.match(model.packs[0]!, /## Thread PRRT_before/);
  const result = results[0]!;
  assert.equal(result.outcome, 'resolved');
  if (result.outcome !== 'resolved') return;
  assert.equal(result.resolve.head, head);
  assert.equal(result.resolve.held, 4);
  assert.deepEqual({ open: result.resolve.open, waiting: result.resolve.waiting }, { open: 5, waiting: 4 });
  assert.equal(result.resolve.costUsd, 0.003);
  assert.deepEqual(
    result.resolve.threads.map((t) => [t.id, t.verdict, t.changed]),
    [
      ['PRRT_before', 'fixed', true],
      ['PRRT_at_head', 'fixed', false],
      // A force-push removed the commit of the thread: nobody can tell.
      ['PRRT_gone', 'fixed', null],
      // GitHub gave no commit for the thread: unknown too, not « unchanged ».
      ['PRRT_unknown', 'fixed', null],
    ],
  );
  assert.deepEqual(readdirSync(join(root, 'work')), [], 'the clone is removed after the job');
  assertNoSecretInLogs();
});

test('a resolve job with no thread to answer clones nothing and calls no model', async () => {
  const { api, results } = fakeApi();
  const model = stubResolveModel();
  const outcome = await runJob(job({ kind: 'resolve', resolve: { threads: [], open: 2, waiting: 0 } }), {
    ...deps(api, model.fetch, RUNNER_KEY),
    cloneUrl: () => 'file:///nowhere/at/all',
  });
  assert.equal(outcome, 'done');
  assert.equal(model.packs.length, 0);
  const result = results[0]!;
  assert.ok(result.outcome === 'resolved');
  assert.deepEqual({ model: result.resolve.model, held: result.resolve.held, threads: result.resolve.threads, open: result.resolve.open }, { model: null, held: 0, threads: [], open: 2 });
});

test('the runner claims both kinds of job', async () => {
  const stop = new AbortController();
  const fake = fakeApi();
  const claims: unknown[] = [];
  const api = {
    ...fake.api,
    claim: async (body: unknown) => {
      claims.push(body);
      stop.abort();
      return null;
    },
  };
  await runLoop(api, deps(fake.api, stubModel().fetch, RUNNER_KEY), stop.signal);
  assert.deepEqual(claims[0], { hasProviderKey: true, kinds: ['review', 'resolve'], features: ['providers', 'models', 'rules', 'threads', 'reuse', 'rejected', 'delta', 'rejected-severity', 'earlier', 'reviewed', 'refuted', 'patch'], ownProvider: 'openrouter' });
});

// --- providers (REV-11) ------------------------------------------------------------------------

const PROVIDER_ID = '7f1d6c2e-9a4b-4c3d-8e2f-1a2b3c4d5e6f';
const ANTHROPIC_KEY = 'sk-ant-api-key-of-the-test-0123456789';

/** A model that answers as Anthropic, or with `status`, and records each call. */
function stubAnthropic(status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const stub = (async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body });
    if (status !== 200) return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status });
    return new Response(
      JSON.stringify({
        model: body.model,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(answer()) }],
        usage: { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    );
  }) as typeof globalThis.fetch;
  return { fetch: stub, calls };
}

const anthropicProvider = (apiKey: string | null, models: string[] = []) => ({ id: PROVIDER_ID, kind: 'anthropic' as const, apiKey, baseUrl: null, models });

test('a job with an Anthropic provider of the service: the key of the job, the cost from the price table', async () => {
  const { api, results } = fakeApi();
  const model = stubAnthropic();
  const outcome = await runJob(job({ providers: [anthropicProvider(ANTHROPIC_KEY)] }), deps(api, model.fetch));
  assert.equal(outcome, 'done');
  assert.equal(model.calls[0]!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(model.calls[0]!.headers['x-api-key'], ANTHROPIC_KEY);
  assert.equal(model.calls[0]!.body.model, 'claude-haiku-5-5', 'the default model of the level at Anthropic');
  const result = results[0]!;
  assert.equal(result.outcome, 'done');
  if (result.outcome !== 'done') return;
  // 10,000 × 0.10 + 1,000 × 0.50 millionths of a dollar.
  assert.equal(result.review.costUsd, 0.0015);
  assert.equal(result.review.costSource, 'table');
  // REV-108. The stop_reason of the model goes to the logs, and no key of the protocol carries it.
  assert.ok(logs.some((l) => l.includes('job.model_usage') && l.includes('"stopReason":"end_turn"') && l.includes('"retriedWithoutThinking":null')));
  assert.ok(!('stopReason' in result.review));
  assert.ok(!logs.join('\n').includes(ANTHROPIC_KEY), 'no log line holds the key of the provider');
  assertNoSecretInLogs();
});

test('the models that the job names replace the defaults of the provider', async () => {
  const { api } = fakeApi();
  const model = stubAnthropic();
  await runJob(job({ providers: [anthropicProvider(ANTHROPIC_KEY, ['claude-sonnet-5-5'])] }), deps(api, model.fetch));
  assert.equal(model.calls[0]!.body.model, 'claude-sonnet-5-5');
});

test('a refused key fails the job with the status of the provider, and the next model is not called', async () => {
  const { api, results } = fakeApi();
  const model = stubAnthropic(401);
  const outcome = await runJob(job({ providers: [anthropicProvider(ANTHROPIC_KEY, ['claude-haiku-5-5', 'claude-sonnet-5-5'])] }), deps(api, model.fetch));
  assert.equal(outcome, 'failed');
  assert.equal(model.calls.length, 1);
  const result = results[0]!;
  assert.equal(result.outcome, 'failed');
  if (result.outcome !== 'failed') return;
  assert.equal(result.providerStatus, 401);
  assert.match(result.reason, /Anthropic answered 401/);
  assert.ok(!result.reason.includes(ANTHROPIC_KEY));
  assertNoSecretInLogs();
});

test('a provider that the runner must hold: without it, the job fails with a clear reason and calls nothing', async () => {
  const { api, results } = fakeApi();
  const model = stubAnthropic();
  await runJob(job({ providers: [anthropicProvider(null)] }), deps(api, model.fetch));
  assert.equal(model.calls.length, 0);
  const result = results[0]!;
  assert.equal(result.outcome, 'failed');
  if (result.outcome !== 'failed') return;
  assert.match(result.reason, /needs a anthropic provider on the runner/);
  assert.equal(result.providerStatus, null);
});

test('a service of an earlier release gets no key that it does not know in the result', async () => {
  const { api, results } = fakeApi();
  const model = stubAnthropic(401);
  // No `providers`: the job of an earlier service, and an OpenRouter key.
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY } }), deps(api, model.fetch));
  const result = results[0]!;
  assert.equal(result.outcome, 'failed');
  assert.ok(!('providerStatus' in result));
});

test('the provider of a job: the runner first when it holds that kind, else the key of the job', () => {
  const own = (kind: 'ollama' | 'anthropic' | 'openrouter', apiKey: string | null, baseUrl?: string) => ({ kind, apiKey, baseUrl, own: kind });
  const ollamaJob = job({ providers: [{ id: PROVIDER_ID, kind: 'ollama', apiKey: null, baseUrl: null, models: ['qwen3:32b'] }] });
  const local = chooseModel(ollamaJob, own('ollama', null, 'http://gpu.lan:11434'));
  assert.deepEqual({ kind: local.kind, apiKey: local.apiKey, baseUrl: local.baseUrl, models: local.config.models }, {
    kind: 'ollama',
    apiKey: undefined,
    baseUrl: 'http://gpu.lan:11434',
    models: ['qwen3:32b'],
  });
  // The runner holds an Anthropic key: the key of the job is never used.
  assert.equal(chooseModel(job({ providers: [anthropicProvider(ANTHROPIC_KEY)] }), own('anthropic', 'sk-ant-runner')).apiKey, 'sk-ant-runner');
  // The runner holds another kind: the key of the job.
  assert.equal(chooseModel(job({ providers: [anthropicProvider(ANTHROPIC_KEY)] }), own('openrouter', RUNNER_KEY)).apiKey, ANTHROPIC_KEY);
  assert.throws(() => chooseModel(ollamaJob, own('openrouter', RUNNER_KEY)), /needs a ollama provider on the runner/);
});

test('the configuration of a provider: Ollama may be HTTP, the others must be HTTPS', () => {
  const ollama = loadConfig({ KENTO_URL: 'https://review.sakuga.dev', PROVIDER_KIND: 'ollama', PROVIDER_BASE_URL: 'http://gpu.lan:11434' });
  assert.deepEqual(ollama.provider, { kind: 'ollama', baseUrl: 'http://gpu.lan:11434', apiKey: null, own: 'ollama' });
  assert.equal(loadConfig({ KENTO_URL: 'https://review.sakuga.dev' }).provider.own, null, 'no key: the runner holds no provider');
  assert.equal(loadConfig({ KENTO_URL: 'https://review.sakuga.dev', PROVIDER_KIND: 'anthropic', PROVIDER_API_KEY: 'sk-ant-x' }).provider.own, 'anthropic');
  assert.throws(() => loadConfig({ KENTO_URL: 'https://review.sakuga.dev', PROVIDER_KIND: 'anthropic', PROVIDER_BASE_URL: 'http://proxy.lan' }), /PROVIDER_BASE_URL must be an https:\/\/ URL/);
  assert.throws(() => loadConfig({ KENTO_URL: 'https://review.sakuga.dev', PROVIDER_KIND: 'openai_compatible', PROVIDER_API_KEY: 'k' }), /PROVIDER_BASE_URL is required/);
});

test('the loop says what it can read and which provider it holds', async () => {
  const bodies: unknown[] = [];
  const controller = new AbortController();
  const api = {
    ...fakeApi().api,
    claim: async (body: unknown) => {
      bodies.push(body);
      controller.abort();
      return null;
    },
  };
  const model = stubModel();
  await runLoop(api, { ...deps(fakeApi().api, model.fetch), config: { workDir: join(root, 'work'), provider: { kind: 'ollama', baseUrl: undefined, apiKey: null, own: 'ollama' } } }, controller.signal);
  assert.deepEqual(bodies[0], { hasProviderKey: true, kinds: ['review', 'resolve'], features: ['providers', 'models', 'rules', 'threads', 'reuse', 'rejected', 'delta', 'rejected-severity', 'earlier', 'reviewed', 'refuted', 'patch'], ownProvider: 'ollama' });
});

// --- models of the config of the repository (REV-12) -------------------------------------------

test('the models of the config replace those of the level, and the fallback takes over (REV-12)', async () => {
  const { api, results } = fakeApi();
  const asked: string[] = [];
  const stub = (async (url: string, init: RequestInit) => {
    asked.push(JSON.parse(String(init.body)).model);
    // The first model fails: the fallback of the config answers.
    if (asked.length === 1) return new Response('{"error":{"message":"overloaded"}}', { status: 503 });
    return stubModel().fetch(url, init);
  }) as typeof fetch;
  const models = { provider: 'service', model: 'anthropic/claude-sonnet-5.5', fallback: 'z-ai/glm-5.3' };
  // A service without `providers`: the key of the runner, at OpenRouter.
  assert.equal(await runJob(job({ level: 'balanced', models }), deps(api, stub, RUNNER_KEY)), 'done');
  assert.deepEqual([...new Set(asked)], ['anthropic/claude-sonnet-5.5', 'z-ai/glm-5.3']);
  assert.equal(results[0]!.outcome === 'done' && results[0]!.review.model, 'z-ai/glm-5.3');
});

test('with providers, the models of the config pick their provider by id (REV-12)', async () => {
  const { api } = fakeApi();
  const model = stubAnthropic();
  const service = { id: 'service', kind: 'openrouter' as const, apiKey: SERVICE_KEY, baseUrl: null, models: [] };
  const models = { provider: PROVIDER_ID, model: 'claude-sonnet-5-5', fallback: null };
  assert.equal(await runJob(job({ providers: [service, anthropicProvider(ANTHROPIC_KEY)], models }), deps(api, model.fetch)), 'done');
  assert.equal(model.calls[0]!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(model.calls[0]!.body.model, 'claude-sonnet-5-5');
});

test('a config whose provider is not in the job fails it with the reason, and calls no model (REV-12)', async () => {
  const model = stubModel();
  const one = fakeApi();
  const models = { provider: PROVIDER_ID, model: 'claude-sonnet-5-5', fallback: null };
  assert.equal(await runJob(job({ models }), deps(one.api, model.fetch, RUNNER_KEY)), 'failed');
  const two = fakeApi();
  const service = { id: 'service', kind: 'openrouter' as const, apiKey: SERVICE_KEY, baseUrl: null, models: [] };
  assert.equal(await runJob(job({ providers: [service], models }), deps(two.api, model.fetch, RUNNER_KEY)), 'failed');
  assert.deepEqual(model.keys, [], 'no model call');
  for (const { results } of [one, two]) {
    assert.equal(results[0]!.outcome === 'failed' && results[0]!.reason, `the provider ${PROVIDER_ID} that the config chose is not in the job`);
  }
});

// --- rules of the repository and of the org (REV-19) --------------------------------------------

const RULE_ID = '5d0e6c1a-8b7f-4e2d-9c3b-1f2a3b4c5d6e';
const OTHER_RULE_ID = '6e1f7d2b-9c8a-4f3e-8d4c-2a3b4c5d6e7f';

/** A model that cites `cite` in its finding, and records the pack and the schema of each call. */
function stubRuleModel(cite: string | null) {
  const bodies: any[] = [];
  const stub = (async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const content = answer();
    content.findings = content.findings.map((f) => ({ ...f, severity: 'minor', rule_id: cite }));
    return new Response(JSON.stringify({ model: body.model, provider: 'Stub', choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0042 } }));
  }) as typeof globalThis.fetch;
  return { fetch: stub, bodies };
}

const rule = (overrides: Record<string, unknown> = {}) => ({
  id: RULE_ID,
  scope: 'repo' as const,
  title: 'Une somme additionne',
  text: 'Toute fonction `sum` additionne ses arguments.',
  paths: ['*.ts'],
  severityFloor: 'major' as const,
  ...overrides,
});

test('a job with rules: the pack holds the rules that the diff touches, and a finding cites one by its id', async () => {
  const { api, results } = fakeApi();
  const model = stubRuleModel('R1');
  const rules = [rule(), rule({ id: OTHER_RULE_ID, title: 'Index des FK', paths: ['**/migrations/**'] })];
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY }, rules }), deps(api, model.fetch));

  const pack = model.bodies[0].messages.at(-1).content as string;
  assert.match(pack, /### R1 · Une somme additionne/);
  assert.doesNotMatch(pack, /Index des FK/, 'a rule whose paths the diff does not touch is not in the pack');
  const result = results[0]!;
  assert.equal(result.outcome, 'done');
  if (result.outcome !== 'done') return;
  assert.equal(result.review.findings[0]!.rule_id, RULE_ID);
  assert.equal(result.review.findings[0]!.severity, 'major', 'the floor of the rule raises a minor finding');
  const trace = logs.map((l) => JSON.parse(l)).find((l) => l.event === 'job.rules');
  assert.deepEqual({ received: trace.received, packed: trace.packed }, { received: [RULE_ID, OTHER_RULE_ID], packed: [RULE_ID] });
});

test('a job of a service of an earlier release has no rules: the result has no rule_id key', async () => {
  const { api, results } = fakeApi();
  const model = stubRuleModel('R1');
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY } }), deps(api, model.fetch));
  const result = results[0]!;
  assert.equal(result.outcome, 'done');
  if (result.outcome !== 'done') return;
  assert.ok(!('rule_id' in result.review.findings[0]!), 'a finding without a rule sends no rule_id');
  assert.ok(!JSON.stringify(model.bodies[0].response_format).includes('rule_id'), 'the answer schema has no rule_id without rules');
});

// --- answered threads (REV-71) ------------------------------------------------------------------

test('a review job with an answered thread: the pack holds the reply, and a refuted finding on an unchanged file is not sent', async () => {
  const { api, results } = fakeApi();
  const bodies: any[] = [];
  const model = (async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const content = { ...answer(), confidence_score: 4, threads: [{ id: 'T1', verdict: 'refuted', reason: 'La ligne 2 soustrait à dessein.' }] };
    return new Response(JSON.stringify({ model: body.model, provider: 'Stub', choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0042 } }));
  }) as typeof globalThis.fetch;
  const threads = [
    {
      id: 'PRRT_kwDO71',
      path: 'sum.ts',
      line: 2,
      comments: [
        { id: 1, author: 'kento-review', isBot: true, body: '**Soustraction**', commit: head },
        { id: 2, author: 'alex', isBot: false, body: 'Voulu : `sum` soustrait dans ce module.', commit: head },
      ],
    },
  ];
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY }, threads }), deps(api, model));

  const pack = bodies[0].messages.at(-1).content as string;
  assert.match(pack, /## Answered threads[\s\S]*\*\*alex\*\* \(person\):\n\nVoulu : `sum` soustrait dans ce module\./);
  assert.ok(JSON.stringify(bodies[0].response_format).includes('"threads"'));
  const result = results[0]!;
  assert.equal(result.outcome, 'done');
  if (result.outcome !== 'done') return;
  assert.deepEqual(result.review.findings, []);
  assert.equal(result.review.score, 4);
  assert.ok(logs.map((l) => JSON.parse(l)).some((l) => l.event === 'job.finding_refuted_in_thread' && l.path === 'sum.ts'));
  // REV-96. The service that sent the thread gets its id back, to answer it with the hint of `reject`.
  assert.deepEqual(result.review.refutedThreads, ['PRRT_kwDO71']);
  assert.ok(parseResultRequest(JSON.parse(JSON.stringify(result))).ok, 'the result is the protocol');

  // A job without threads (a service that does not read them) gets no `refutedThreads`.
  const old = fakeApi();
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY } }), deps(old.api, model));
  assert.ok(old.results[0]!.outcome === 'done' && !('refutedThreads' in old.results[0]!.review));
});

test('the patch of a finding without a suggestion goes to the service (REV-104)', async () => {
  const { api, results } = fakeApi();
  const patch = '--- a/sum.ts\n+++ b/sum.ts\n@@ -2 +2 @@\n-  return a - b;\n+  return a + b;';
  const model = (async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body));
    const content = { ...answer(), findings: [{ ...answer().findings[0]!, suggestion: '', patch }] };
    return new Response(JSON.stringify({ model: body.model, provider: 'Stub', choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0042 } }));
  }) as typeof globalThis.fetch;
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY } }), deps(api, model));
  const result = results[0]!;
  assert.ok(result.outcome === 'done');
  assert.equal(result.review.findings[0]!.patch, patch);
  assert.equal(result.review.findings[0]!.suggestion_range, null);
});

// --- rejected findings (REV-95) -----------------------------------------------------------------

test('a review job with a rejected finding: the pack holds its cause, and the finding on an unchanged file is not sent', async () => {
  const { api, results } = fakeApi();
  const bodies: any[] = [];
  const model = (async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    // The model words the defect again, one line off; it keeps the score of the pull request.
    const reworded = { ...answer().findings[0]!, title: 'Soustraction au lieu d’une addition', line: 3, start_line: 3 };
    const content = { ...answer(), confidence_score: 4, findings: [reworded] };
    return new Response(JSON.stringify({ model: body.model, provider: 'Stub', choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0042 } }));
  }) as typeof globalThis.fetch;
  const rejected = [{ path: 'sum.ts', line: 2, title: 'Soustraction', category: 'bug' as const, severity: 'major' as const, status: 'dismissed' as const, reason: 'Voulu : ce module soustrait.', commit: head }];
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY }, rejected }), deps(api, model));

  const pack = bodies[0].messages.at(-1).content as string;
  assert.match(pack, /## Rejected findings[\s\S]*- Cause written by the person: « Voulu : ce module soustrait\. »/);
  const result = results[0]!;
  assert.equal(result.outcome, 'done');
  if (result.outcome !== 'done') return;
  assert.deepEqual(result.review.findings, []);
  assert.equal(result.review.score, 4);
  assert.ok(logs.map((l) => JSON.parse(l)).some((l) => l.event === 'job.finding_dropped_as_rejected' && l.path === 'sum.ts'));
});

// --- reuse of the last review (REV-89) -----------------------------------------------------------

test('a service that sends reuse gets the diff hash, the reuse key and the cached tokens of a review (REV-89)', async () => {
  const { api, results } = fakeApi();
  const model = stubModel();
  assert.equal(await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY }, reuse: null }), deps(api, model.fetch)), 'done');
  const result = results[0]!;
  assert.ok(result.outcome === 'done');
  assert.match(result.review.diffHash ?? '', /^[0-9a-f]{16}$/);
  assert.match(result.review.reuseKey ?? '', /^[0-9a-f]{64}$/);
  // The stub gives no prompt_tokens_details: the provider said nothing of its cache.
  assert.equal(result.review.cachedTokens, null);
  assert.ok(logs.some((l) => l.includes('"event":"job.finished"') && l.includes(`"diffHash":"${result.review.diffHash}"`)), 'the log line of the job holds the diff hash');

  // A service of an earlier release sends no `reuse`, and refuses a key that it does not know.
  const earlier = fakeApi();
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY } }), deps(earlier.api, model.fetch));
  const old = earlier.results[0]!;
  assert.ok(old.outcome === 'done' && !('diffHash' in old.review) && !('reuseKey' in old.review) && !('cachedTokens' in old.review));
});

test('a head with the reuse key of the last review calls no model, and sends unchanged (REV-89)', async () => {
  const first = fakeApi();
  const model = stubModel();
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY }, reuse: null }), deps(first.api, model.fetch));
  const done = first.results[0]!;
  assert.ok(done.outcome === 'done');
  assert.equal(model.keys.length, 1);

  // The same head stands for a merge of main: the key is that of the pack after its commits.
  const previous = '1111111111111111111111111111111111111111';
  const { api, results } = fakeApi();
  const outcome = await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY }, reuse: { head: previous, key: done.review.reuseKey! } }), deps(api, model.fetch));
  assert.equal(outcome, 'done');
  assert.equal(model.keys.length, 1, 'no model call');
  const result = results[0]!;
  assert.equal(result.outcome, 'unchanged');
  if (result.outcome !== 'unchanged') return;
  assert.deepEqual(result.unchanged, { level: 'lite', base: done.review.base, head, of: previous, diffHash: done.review.diffHash, reuseKey: done.review.reuseKey });

  // Another key: a review.
  const other = fakeApi();
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY }, reuse: { head: previous, key: 'f'.repeat(64) } }), deps(other.api, model.fetch));
  assert.equal(other.results[0]!.outcome, 'done');
  assert.equal(model.keys.length, 2);
});

// --- incremental review (REV-88) -----------------------------------------------------------------

test('with a delta whose head is the base, the review reads only the change since, and sends delta (REV-88)', async () => {
  const { api, results } = fakeApi();
  const packs: string[] = [];
  const stub = (async (url: string, init: RequestInit) => {
    packs.push(JSON.parse(String(init.body)).messages[1].content);
    return stubModel().fetch(url, init);
  }) as typeof fetch;
  // The last reviewed head is the merge base: the whole change of the pull request came since.
  const since = git(source, 'merge-base', base, head);
  const carried = { path: 'other.ts', start_line: 1, line: 1, severity: 'minor' as const, category: 'bug' as const, confidence: 80, title: 'Hors PR', scenario: 's', fix: 'f', suggestion: '', anchor: null, blocking: false, suggestion_range: null };
  const reuse = { head: since, key: 'e'.repeat(64), delta: { score: 5, findings: [carried], settled: [] } };
  assert.equal(await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY }, reuse }), deps(api, stub)), 'done');
  const result = results[0]!;
  assert.ok(result.outcome === 'done');
  assert.deepEqual(result.review.delta, { since, files: 1 });
  assert.match(packs[0]!, /This pull request was reviewed at commit/);
  assert.ok(!result.review.findings.some((f) => f.title === 'Hors PR'), 'a finding on a file outside the pull request does not come back');
  assert.ok(logs.some((l) => l.includes('"event":"job.review_incremental"')));

  // Without `delta` in the job (a service of REV-89), no `delta` in the result.
  const earlier = fakeApi();
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY }, reuse: { head: since, key: 'e'.repeat(64) } }), deps(earlier.api, stub));
  const old = earlier.results[0]!;
  assert.ok(old.outcome === 'done' && !('delta' in old.review));
});

// --- earlier findings (REV-99) -------------------------------------------------------------------

test('a service that sends earlier findings gets `follows` on a finding that continues one, and an earlier service gets none (REV-99)', async () => {
  const earlier = {
    // The same finding, with the key of its path and title, fixed since.
    findings: [{ key: findingKey(answer().findings[0]!), path: 'sum.ts', line: 2, title: 'Soustraction', severity: 'major' as const, category: 'bug' as const, status: 'fixed' as const, reason: null, commit: head }],
    last: null,
  };
  const sent = job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY }, earlier });
  assert.ok(parseJob(JSON.parse(JSON.stringify(sent))).ok, 'the job is the protocol');
  const { api, results } = fakeApi();
  assert.equal(await runJob(sent, deps(api, stubModel().fetch)), 'done');
  const result = results[0]!;
  assert.ok(result.outcome === 'done');
  assert.equal(result.review.findings[0]!.follows, findingKey(answer().findings[0]!), '« Soustraction » is the fixed finding again: it follows it');
  assert.ok(logs.some((l) => l.includes('job.earlier_findings') && l.includes('"byNet":1')));

  // A service of an earlier release sends no `earlier`, and refuses a key that it does not know.
  const old = fakeApi();
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY } }), deps(old.api, stubModel().fetch));
  assert.ok(old.results[0]!.outcome === 'done' && !('follows' in old.results[0]!.review.findings[0]!));
});

// --- code already read (REV-100) -----------------------------------------------------------------

test('a service that sends the last reviewed commit gets `seen` on a finding whose code did not change, and an earlier service gets none (REV-100)', async () => {
  // The head itself was reviewed: no line changed since.
  const sent = job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY }, reviewed: head });
  assert.ok(parseJob(JSON.parse(JSON.stringify(sent))).ok, 'the job is the protocol');
  const { api, results } = fakeApi();
  assert.equal(await runJob(sent, deps(api, stubModel().fetch)), 'done');
  const result = results[0]!;
  assert.ok(result.outcome === 'done');
  assert.equal(result.review.findings[0]!.seen, true);
  assert.equal(result.review.findings[0]!.blocking, false, 'a new P1 on code already read does not block');
  assert.notEqual(result.review.verdict, 'REQUEST_CHANGES');
  assert.ok(logs.some((l) => l.includes('job.seen_code') && l.includes('"seen":1')));

  const old = fakeApi();
  await runJob(job({ provider: { kind: 'openrouter', apiKey: SERVICE_KEY } }), deps(old.api, stubModel().fetch));
  assert.ok(old.results[0]!.outcome === 'done' && !('seen' in old.results[0]!.review.findings[0]!));
  assert.equal(old.results[0]!.review.verdict, 'REQUEST_CHANGES');
});
