import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Answer, Finding } from '../src/findings.ts';
import { levelConfig, reviewInPasses, reviewPullRequest } from '../src/index.ts';
import { BASE_PASSES } from '../src/passes.ts';
import { isRaceFinding, isTraced, isUnmeasuredSlowClaim, splitUntracedTiming } from '../src/timing.ts';

// KNT-152. A race, an order of events or a timeout must trace the steps that the runtime allows.

const finding = (title: string, extra: Partial<Finding> = {}): Finding => ({
  path: 'src/queue.ts',
  start_line: 9,
  line: 9,
  severity: 'major',
  category: 'bug',
  confidence: 80,
  title,
  scenario: 'The scenario.',
  fix: 'The fix.',
  suggestion: '',
  interleaving: [],
  ...extra,
});

test('the findings about a race, an order of events or a timer', () => {
  for (const title of [
    'Race between two writers of the count',
    'A waiter is granted after its timer fired',
    'The order of reject and abort loses the error',
    'Concurrent requests both insert the row',
    'A middle click is counted twice',
    'The promise resolves after the abort',
    'Time-of-check to time-of-use on the file',
  ]) {
    assert.equal(isRaceFinding(finding(title)), true, title);
  }
  assert.equal(isRaceFinding(finding('A missing id gives 500')), false);
  assert.equal(isRaceFinding(finding('Wrong total', { scenario: 'The handler races the timer: the timer fires before the grant.' })), true, 'the scenario counts');
  assert.equal(isRaceFinding(finding('The cache key traces the user')), false, '"traces" is no race');
});

test('a claim that some work is too slow needs a number or an input', () => {
  assert.equal(isUnmeasuredSlowClaim(finding('The compiler in `beforeAll` may exceed its timeout')), true);
  assert.equal(isUnmeasuredSlowClaim(finding('The request times out', { scenario: 'The export can take long.' })), true);
  assert.equal(isUnmeasuredSlowClaim(finding('The request times out', { scenario: 'An export of 200000 rows takes 40 s, over the limit of 30 s.' })), false);
  assert.equal(isUnmeasuredSlowClaim(finding('The query is O(n^2)', { scenario: 'The loop reads every row for each row, O(n^2) on the table.' })), false);
  assert.equal(isUnmeasuredSlowClaim(finding('A missing id gives 500')), false);
});

const exists = (path: string) => path === 'src/queue.ts';
const step = (line: number, text = 'runs') => ({ path: 'src/queue.ts', line, step: text });

test('an interleaving is traced with two steps or more, each at a line of a file of the head', () => {
  assert.equal(isTraced([step(9), step(14)], exists), true);
  assert.equal(isTraced([step(9)], exists), false, 'one step');
  assert.equal(isTraced([], exists), false);
  assert.equal(isTraced(undefined, exists), false);
  assert.equal(isTraced([step(9), { path: 'src/made-up.ts', line: 3, step: 'runs' }], exists), false, 'a file that is not at the head');
  assert.equal(isTraced([step(9), step(0)], exists), false, 'no line');
  assert.equal(isTraced([step(9), step(14, ' ')], exists), false, 'no text');
});

const answer = (findings: Finding[], extra: Partial<Answer> = {}): Answer => ({
  confidence_score: 4,
  risk: 'Low risk.',
  summary: 'Summary.',
  diagram: '',
  findings,
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
  ...extra,
});

test('a race with no traced steps and a slow claim with no number become questions', () => {
  const guessed = finding('A waiter is granted after its timer fired');
  const traced = finding('Race between two writers of the count', { interleaving: [step(9, 'A reads the count.'), step(14, 'B reads it before A writes.')] });
  const slow = finding('The compiler in `beforeAll` may exceed its timeout');
  const hole = finding('Concurrent deletes remove the last owner', { severity: 'critical' });
  const plain = finding('A missing id gives 500');
  const { answer: got, asked } = splitUntracedTiming(answer([guessed, traced, slow, hole, plain], { questions: [{ path: 'a.ts', question: 'Q?' }] }), exists);
  assert.deepEqual(got.findings, [traced, hole, plain]);
  assert.deepEqual(asked, [guessed, slow]);
  assert.deepEqual(got.questions, [
    { path: 'a.ts', question: 'Q?' },
    { path: 'src/queue.ts', question: 'A waiter is granted after its timer fired? The review traced no order of steps that the runtime allows.' },
    { path: 'src/queue.ts', question: 'The compiler in `beforeAll` may exceed its timeout? The review gave no number and no input that makes it slow.' },
  ]);
  const none = answer([plain]);
  assert.equal(splitUntracedTiming(none, exists).answer, none, 'nothing to move: the same answer');
});

test('the prompts ask for the steps, and the check reads them first', () => {
  const text = (name: string) => readFileSync(join(import.meta.dirname, '..', 'prompts', name), 'utf8').replace(/\s+/g, ' ');
  assert.match(text('review.md'), /A race, an order of events or a timeout: give in `interleaving` the steps that the runtime allows, two or more/);
  assert.match(text('review.md'), /JavaScript runs one thread and one event loop/);
  assert.match(text('review.md'), /gives a number \(a duration, a count of rows, of calls or of files\) or the input that makes it slow/);
  assert.match(text('verify.md'), /Then decide: - First, for a finding about a race, an order of events or a timeout: drop it when its `interleaving`/);
});

// A single-threaded queue: the grant clears the timer of the waiter, and the timer removes the waiter
// from the queue. Neither can run in the middle of the other.
const QUEUE = `type Waiter = { grant: () => void; timer: ReturnType<typeof setTimeout> };
const waiters: Waiter[] = [];

export function wait(ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      grant: () => {
        clearTimeout(waiter.timer);
        resolve();
      },
      timer: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error('timeout'));
      }, ms),
    };
    waiters.push(waiter);
  });
}

export function release(): void {
  waiters.shift()?.grant();
}
`;

let repo = '';
let base = '';
let head = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-timing-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'queue.ts'), 'export function release(): void {}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'queue.ts'), QUEUE);
  git('commit', '-q', '-am', 'feat: a queue with a time limit');
  head = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { recursive: true, force: true }));

function fakeModel(reply: Answer) {
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  }) as typeof globalThis.fetch;
  return fetch;
}

test('the queue whose timer and grant clear each other: a guessed race gives no finding, and the score stays', async () => {
  const guessed = finding('A waiter is granted after its timer fired', {
    path: 'queue.ts',
    line: 8,
    start_line: 8,
    scenario: 'The timer fires, then `release` grants the same waiter, and the promise resolves after it rejected.',
  });
  const logs: string[] = [];
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch: fakeModel(answer([guessed])), log: (m) => logs.push(m) });
  assert.deepEqual(result.findings, []);
  assert.equal(result.score, 4);
  assert.equal(result.verdict, 'APPROVE');
  assert.match(result.answer.questions?.[0]?.question ?? '', /^A waiter is granted after its timer fired\? The review traced no order/);
  assert.match(logs.join('\n'), /finding moved to the questions, it traces no interleaving or gives no number: queue\.ts: A waiter is granted/);

  // The same finding with two steps at lines of the file stays: the engine checks the shape, the model the facts.
  const traced = { ...guessed, interleaving: [{ path: 'queue.ts', line: 12, step: 'The timer removes the waiter.' }, { path: 'queue.ts', line: 22, step: '`release` shifts the next waiter.' }] };
  const kept = await reviewPullRequest({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch: fakeModel(answer([traced])), log: () => {} });
  assert.equal(kept.findings.length, 1);
});

test('the check of a review in passes reads the steps of a race', async () => {
  const traced = finding('Race between the timer and the grant', {
    path: 'queue.ts',
    interleaving: [{ path: 'queue.ts', line: 12, step: 'The timer removes the waiter.' }, { path: 'queue.ts', line: 22, step: '`release` shifts the next waiter.' }],
  });
  const users: string[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const user: string = body.messages[1].content;
    users.push(user);
    const pass = BASE_PASSES.find((p) => user.endsWith(`${p.focus}\n`));
    const content = JSON.stringify(pass ? answer(pass.id === 'contracts' ? [traced] : []) : { verdicts: [{ index: 0, keep: true, reason: 'The steps hold.' }] });
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  }) as typeof globalThis.fetch;
  const config = (level: 'lite' | 'balanced') => ({ ...levelConfig(level), models: ['test/model'] });
  const result = await reviewInPasses({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch, log: () => {} }, { passConfig: config('lite'), verifyConfig: config('balanced') });
  const check = users.find((u) => u.includes('# Findings to check'))!;
  assert.match(check, /"interleaving": \[\s*\{\s*"path": "queue\.ts",\s*"line": 12/);
  assert.equal(result.findings.length, 1);
});
