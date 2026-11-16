import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { levelConfig, reviewInPasses, type Answer } from '../src/index.ts';
import { BASE_PASSES, passesScore } from '../src/passes.ts';

// REV-20. A review in passes: the passes read the same pack from their angle, at once; a stronger
// model keeps or drops each finding; a pass that fails does not stop the others.
const PROMPTS = join(import.meta.dirname, '..', 'prompts');
let repo = '';
let base = '';
let head = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'passes-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'user.ts'), 'export function find(db, id) {\n  return db.get(id);\n}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'user.ts'), 'export function find(db, id) {\n  return db.query(`select * from users where id = ${id}`);\n}\n');
  git('commit', '-q', '-am', 'raw query');
  head = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { recursive: true, force: true }));

const finding = (title: string, severity: 'critical' | 'major' | 'minor' = 'major') => ({
  path: 'user.ts',
  start_line: 2,
  line: 2,
  severity,
  category: 'security' as const,
  confidence: 90,
  title,
  scenario: `${title}.`,
  fix: 'Use a parameter.',
  suggestion: '',
});

const answer = (findings: ReturnType<typeof finding>[], confidence = 4): Answer => ({
  confidence_score: confidence,
  risk: 'Medium',
  summary: 'Summary',
  diagram: '',
  findings,
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
});

const PASS_MODEL = 'test/pass';
const CHECK_MODEL = 'test/check';
const passConfig = { ...levelConfig('lite'), models: [PASS_MODEL] };
const verifyConfig = { ...levelConfig('balanced'), models: [CHECK_MODEL] };

/**
 * A fetch that answers as OpenRouter: each pass by the end of its prompt, the check by its prompt.
 * `failing`: the ids of the passes that fail, or `check`.
 */
function fakeModel(byPass: Record<string, Answer>, verdicts: { index: number; keep: boolean; reason: string }[], failing: string[] = []) {
  const calls: { model: string; system: string; user: string }[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const system: string = body.messages[0].content;
    const user: string = body.messages[1].content;
    calls.push({ model: body.model, system, user });
    const pass = BASE_PASSES.find((p) => user.endsWith(`${p.focus}\n`));
    const id = pass?.id ?? 'check';
    if (failing.includes(id)) return new Response('down', { status: 503 });
    const content = JSON.stringify(pass ? byPass[pass.id] : { verdicts });
    return new Response(JSON.stringify({ model: body.model, provider: 'Fake', choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: pass ? 0.001 : 0.01 } }));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test('runs the three passes of base at once on one pack, then one check that keeps or drops each finding', async () => {
  const { fetch, calls } = fakeModel(
    {
      security: answer([finding('SQL injection', 'critical')], 3),
      data: answer([finding('SQL injection by id')]),
      contracts: answer([finding('Return without a type', 'minor')], 5),
    },
    [
      { index: 0, keep: true, reason: 'line 2 builds the query from id' },
      { index: 1, keep: false, reason: 'same defect as 0' },
    ],
  );
  const result = await reviewInPasses({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch, log: () => {} }, { passConfig, verifyConfig });

  // Three passes with the prompt of the review and the pack, then their focus at the end of the
  // pack (REV-113): the passes share the prefix of the prompt cache. One check with its prompt.
  const review = readFileSync(join(PROMPTS, 'review.md'), 'utf8');
  const passCalls = calls.filter((c) => c.model === PASS_MODEL);
  assert.equal(passCalls.length, 3);
  assert.ok(passCalls.every((c) => c.system === review), 'every pass has the same system prompt');
  for (const pass of BASE_PASSES) {
    assert.ok(passCalls.some((c) => c.user === `${result.pack}\n\n${pass.focus}\n`), `the pass ${pass.id} has its focus after the pack`);
  }
  const check = calls.filter((c) => c.model === CHECK_MODEL);
  assert.equal(check.length, 1);
  assert.equal(check[0]!.system, readFileSync(join(PROMPTS, 'verify.md'), 'utf8'));
  assert.ok(check[0]!.user.startsWith(`${result.pack}\n\n# Findings to check\n`));
  assert.match(check[0]!.user, /"index": 2,\n\s+"pass": "contracts"/);

  // The kept findings keep their pass; the dropped one keeps the reason of the check.
  assert.deepEqual(result.findings.map((f) => [f.pass, f.title]), [
    ['security', 'SQL injection'],
    ['contracts', 'Return without a type'],
  ]);
  assert.deepEqual(result.dropped.map((f) => [f.pass, f.title, f.reason]), [['data', 'SQL injection by id', 'same defect as 0']]);
  assert.equal(result.verification, 'done');
  assert.deepEqual(result.passes.map((p) => [p.id, p.model, p.findings]), [
    ['security', PASS_MODEL, 1],
    ['data', PASS_MODEL, 1],
    ['contracts', PASS_MODEL, 1],
  ]);
  // The cost is the sum of the calls; the review is as sure as its least sure pass, and the critical
  // finding on a changed line asks for changes.
  assert.ok(Math.abs(result.usage.cost! - 0.013) < 1e-9);
  assert.equal(result.verdict, 'REQUEST_CHANGES');
  assert.equal(result.score, 2);
  assert.equal(result.findings[0]!.anchor, 2);
});

test('a pass that fails does not stop the others, and the result names it', async () => {
  const { fetch } = fakeModel(
    { security: answer([finding('SQL injection', 'critical')]), data: answer([]), contracts: answer([]) },
    [{ index: 0, keep: true, reason: 'line 2' }],
    ['data'],
  );
  const result = await reviewInPasses({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch, log: () => {} }, { passConfig, verifyConfig });
  assert.deepEqual(result.findings.map((f) => f.title), ['SQL injection']);
  const failed = result.passes.find((p) => p.id === 'data')!;
  assert.equal(failed.model, null);
  assert.match(failed.error!, /no model gave a usable answer/);
});

test('a check that fails keeps every finding, and every pass failing throws', async () => {
  const logs: string[] = [];
  const kept = fakeModel(
    { security: answer([finding('SQL injection', 'critical')]), data: answer([finding('Other')]), contracts: answer([]) },
    [],
    ['check'],
  );
  const result = await reviewInPasses({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch: kept.fetch, log: (m) => logs.push(m) }, { passConfig, verifyConfig });
  assert.equal(result.verification, 'failed');
  assert.deepEqual(result.findings.map((f) => f.title), ['SQL injection', 'Other']);
  assert.ok(logs.some((m) => m.startsWith('the check of the findings failed, every finding is kept')));

  const none = fakeModel({}, [], ['security', 'data', 'contracts']);
  await assert.rejects(
    reviewInPasses({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch: none.fetch, log: () => {} }, { passConfig, verifyConfig }),
    /every pass failed: security: .*; data: .*; contracts: /,
  );
});

test('no finding: no check is called', async () => {
  const { fetch, calls } = fakeModel({ security: answer([]), data: answer([]), contracts: answer([]) }, []);
  const result = await reviewInPasses({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch, log: () => {} }, { passConfig, verifyConfig });
  assert.equal(result.verification, 'none');
  assert.equal(calls.filter((c) => c.model === CHECK_MODEL).length, 0);
  assert.equal(result.verdict, 'APPROVE');
});

test('the score is the lowest of the passes that still count: not a pass whose findings were all dropped, nor a score out of 1 to 5', () => {
  const [security, data, contracts] = BASE_PASSES as [typeof BASE_PASSES[0], typeof BASE_PASSES[0], typeof BASE_PASSES[0]];
  const answers = [
    { pass: security, answer: answer([finding('SQL injection', 'critical')], 1) },
    { pass: data, answer: answer([], 0) },
    { pass: contracts, answer: answer([finding('Return without a type', 'minor')], 4) },
  ];
  const kept = (title: string, pass: string) => ({ ...finding(title), pass });
  // The check kept the finding of security: its 1 counts.
  assert.equal(passesScore(answers, [kept('SQL injection', 'security'), kept('Return without a type', 'contracts')]), 1);
  // The check dropped it: security no longer counts, data has no valid score, contracts gives 4.
  assert.equal(passesScore(answers, [kept('Return without a type', 'contracts')]), 4);
  // Nothing left: 0, that score() reads as 3.
  assert.equal(passesScore([{ pass: data, answer: answer([], 0) }], []), 0);
});

test('two verdicts that disagree keep the finding, and a verdict that names no finding is logged', async () => {
  const logs: string[] = [];
  const { fetch } = fakeModel(
    { security: answer([finding('SQL injection', 'critical')]), data: answer([finding('Other')]), contracts: answer([]) },
    [
      { index: 0, keep: true, reason: 'line 2' },
      { index: 0, keep: false, reason: 'changed its mind' },
      { index: 1, keep: false, reason: 'not in the diff' },
      { index: 7, keep: false, reason: 'no such finding' },
    ],
  );
  const result = await reviewInPasses({ repoDir: repo, base, head, level: 'balanced', apiKey: 'k', fetch, log: (m) => logs.push(m) }, { passConfig, verifyConfig });
  assert.deepEqual(result.findings.map((f) => f.title), ['SQL injection']);
  assert.deepEqual(result.dropped.map((f) => f.title), ['Other']);
  assert.ok(logs.includes('the check named 1 finding(s) that the list does not hold: 7'));
});
