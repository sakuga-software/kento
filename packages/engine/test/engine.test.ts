import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fingerprint } from '../src/fingerprint.ts';
import { levelConfig, reviewPullRequest, type Answer } from '../src/index.ts';
import { LEVELS } from '../src/levels.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
let repo = '';
let base = '';
let head = '';

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

// A repository with a base commit, a commit on main after the branch point, and a pull request of
// one commit: the diff must start at the merge base, not at the tip of main.
before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'sum.ts'), 'export function sum(a: number, b: number) {\n  return a + b;\n}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'pr');
  writeFileSync(join(repo, 'sum.ts'), 'export function sum(a: number, b: number) {\n  return a - b;\n}\n');
  git('commit', '-q', '-am', 'fix: sum');
  head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  writeFileSync(join(repo, 'other.ts'), 'export const other = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'main moves on');
  base = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { recursive: true, force: true }));

const answer = (): Answer => ({
  confidence_score: 5,
  risk: 'Low',
  summary: 'Summary',
  diagram: 'flowchart LR\n  A --> B',
  findings: [
    { path: 'sum.ts', start_line: 2, line: 2, severity: 'major', category: 'bug', confidence: 90, title: 'Soustraction', scenario: 'sum(1, 2) donne -1.', fix: 'a + b', suggestion: '  return a + b;\n' },
    { path: '', start_line: 1, line: 1, severity: 'minor', category: 'test', confidence: 10, title: 'No path', scenario: '', fix: '', suggestion: '' },
  ],
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
});

/** A fetch that answers as OpenRouter, fails for the models in `failing`, and records each call. */
function fakeModel(failing: string[] = []) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body });
    if (failing.includes(body.model)) return new Response('down', { status: 503 });
    const content = JSON.stringify(answer());
    return new Response(JSON.stringify({ model: body.model, provider: 'Fake', choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.002 } }));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test('reviews from the merge base, anchors the findings and gives the score and the verdict', async () => {
  const { fetch, calls } = fakeModel();
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'lite', apiKey: 'key-1', fetch, log: () => {} });

  assert.equal(result.base, git('merge-base', base, head));
  assert.match(result.pack, /-  return a \+ b;\n\+  return a - b;/);
  assert.doesNotMatch(result.pack, /other\.ts/, 'the commit of main after the branch point is not in the diff');
  assert.deepEqual([...result.lines.get('sum.ts')!], [2]);

  // The finding without a path is dropped; the other one is on a changed line, so it blocks.
  assert.equal(result.findings.length, 1);
  assert.deepEqual(
    { anchor: result.findings[0].anchor, blocking: result.findings[0].blocking, range: result.findings[0].suggestion_range },
    { anchor: 2, blocking: true, range: [2, 2] },
  );
  // The fingerprint reads the code of the file at the head, not the line number.
  assert.equal(
    result.findings[0].fingerprint,
    fingerprint(result.findings[0], ['export function sum(a: number, b: number) {', '  return a - b;', '}', '']),
  );
  assert.equal(result.score, 2, 'a blocking finding caps the score at 2');
  assert.equal(result.verdict, 'REQUEST_CHANGES');
  assert.equal(result.diagram, 'flowchart LR\n  A --> B');
  assert.equal(result.deeperReview, null);
  assert.equal(result.usage.cost, 0.002);

  // One call, to OpenRouter only, with the key of the input and the prompt of prompts/review.md.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer key-1');
  assert.equal(calls[0].body.model, LEVELS.lite.models[0]);
  assert.equal(calls[0].body.messages[0].content, readFileSync(join(ROOT, 'packages', 'engine', 'prompts', 'review.md'), 'utf8'));
  assert.equal(calls[0].body.messages[1].content, result.pack);
});

test('falls back to the next model of the level and logs the failed attempt', async () => {
  const { fetch, calls } = fakeModel([LEVELS.lite.models[0]]);
  const logs: string[] = [];
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'lite', apiKey: 'k', fetch, log: (m) => logs.push(m) });
  assert.deepEqual(calls.map((c) => c.body.model), LEVELS.lite.models);
  assert.equal(result.usage.model, LEVELS.lite.models[1]);
  assert.match(logs[0], /^attempt 1 with .+ failed: ProviderError: OpenRouter answered 503: down$/);
});

test('calls another server of the same API when the caller gives its base URL', async () => {
  const { fetch, calls } = fakeModel();
  await reviewPullRequest({ repoDir: repo, base, head, level: 'lite', apiKey: 'k', baseUrl: 'https://proxy.example/v1/', fetch, log: () => {} });
  assert.equal(calls[0].url, 'https://proxy.example/v1/chat/completions');
});

test('a level reads the environment only when the caller passes it', () => {
  process.env.REVIEW_MODELS = 'x/from-env';
  try {
    assert.deepEqual(levelConfig('lite'), LEVELS.lite);
    assert.deepEqual(levelConfig('lite', process.env).models, ['x/from-env']);
    assert.deepEqual(levelConfig('heavy', { REVIEW_MAX_PRICE: '1,2', REVIEW_TIMEOUT_MS: '5' }), { ...LEVELS.heavy, maxPrice: { prompt: 1, completion: 2 }, timeoutsMs: [5] });
  } finally {
    delete process.env.REVIEW_MODELS;
  }
});

test('REVIEW_MAX_PRICE takes two numbers of 0 or more, and refuses the rest with its name (REV-61)', () => {
  assert.deepEqual(levelConfig('lite', { REVIEW_MAX_PRICE: ' 0.5 , 3.5 ' }).maxPrice, { prompt: 0.5, completion: 3.5 });
  assert.deepEqual(levelConfig('lite', { REVIEW_MAX_PRICE: '0,0' }).maxPrice, { prompt: 0, completion: 0 });
  // An empty variable keeps the cap of the level, as before.
  assert.deepEqual(levelConfig('lite', { REVIEW_MAX_PRICE: '' }).maxPrice, LEVELS.lite.maxPrice);
  for (const value of ['1', 'x', '1,x', '1,', ',2', '1,2,3', '-1,2', '1,Infinity', '1;2']) {
    assert.throws(() => levelConfig('lite', { REVIEW_MAX_PRICE: value }), (error: Error) => {
      assert.match(error.message, /^REVIEW_MAX_PRICE must be "prompt,completion"/);
      assert.ok(error.message.endsWith(`not "${value}"`), error.message);
      return true;
    }, value);
  }
});

test('REVIEW_MAX_TOKENS and REVIEW_TIMEOUT_MS refuse a value that is not a number above 0 (REV-61)', () => {
  assert.equal(levelConfig('lite', { REVIEW_MAX_TOKENS: '8000' }).maxTokens, 8000);
  for (const value of ['x', '0', '-5', '1.5']) {
    assert.throws(() => levelConfig('lite', { REVIEW_MAX_TOKENS: value }), /^Error: REVIEW_MAX_TOKENS must be a whole number above 0/, value);
  }
  for (const value of ['x', '0', '-1', 'Infinity']) {
    assert.throws(() => levelConfig('lite', { REVIEW_TIMEOUT_MS: value }), /^Error: REVIEW_TIMEOUT_MS must be a number of milliseconds above 0/, value);
  }
});

test('the engine never calls GitHub and reads no environment', () => {
  const dir = join(import.meta.dirname, '..', 'src');
  for (const file of readdirSync(dir)) {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.doesNotMatch(text, /api\.github\.com|GITHUB_TOKEN/, file);
    assert.doesNotMatch(text, /process\.env/, file);
  }
});
