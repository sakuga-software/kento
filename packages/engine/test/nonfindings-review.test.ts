import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ANSWER_SCHEMA, type Answer, type Finding } from '../src/findings.ts';
import { levelConfig, reviewInPasses, reviewPullRequest } from '../src/index.ts';
import { BASE_PASSES } from '../src/passes.ts';

// KNT-153. The filter of non-findings in a whole review: after the floor of the rules, over the
// findings that an incremental review carries, and across the passes.

let repo = '';
let base = '';
let first = '';
let second = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-nonfindings-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'list.ts'), 'export const list = (n: number) => n;\n');
  writeFileSync(join(repo, 'save.ts'), 'export const save = (n: number) => n;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'list.ts'), 'export const list = (n: number) => n + 1;\n');
  writeFileSync(join(repo, 'save.ts'), 'export const save = (n: number) => n + 1;\n');
  git('commit', '-q', '-am', 'feat: count from one');
  first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'list.ts'), 'export const list = (n: number) => n + 2;\n');
  git('commit', '-q', '-am', 'fix: count from two');
  second = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { recursive: true, force: true }));

const finding = (path: string, fix: string, extra: Partial<Finding> = {}): Finding => ({
  path,
  start_line: 1,
  line: 1,
  severity: 'minor',
  category: 'bug',
  confidence: 80,
  title: `A note on ${path}`,
  scenario: 'The scenario.',
  fix,
  suggestion: '',
  ...extra,
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

/** A model that gives `reply` to the review and `links` to the link call. */
function model(reply: Answer, links: unknown[] = []) {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const content = body.response_format?.json_schema?.name === 'links' ? { links } : reply;
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  }) as typeof globalThis.fetch;
}

test('a review drops a minor finding whose fix is "No change needed", and logs it', async () => {
  const logs: string[] = [];
  const result = await reviewPullRequest({ repoDir: repo, base, head: first, level: 'balanced', apiKey: 'k', fetch: model(answer([finding('list.ts', 'No change needed.')])), log: (m) => logs.push(m) });
  assert.deepEqual(result.findings, []);
  assert.match(logs.join('\n'), /finding dropped, its fix says that no change is needed: list\.ts: A note on list\.ts/);
});

test('the floor of a rule applies before the filter: a finding that the rule makes major stays', async () => {
  const rules = [{ id: 'r-1', scope: 'repo' as const, title: 'Each migration is reversible', text: 'Every migration has a way back.', paths: [], severityFloor: 'major' as const }];
  const asks = finding('list.ts', 'Please confirm that the migration is reversible.');
  const result = await reviewPullRequest({ repoDir: repo, base, head: first, level: 'balanced', apiKey: 'k', rules, fetch: model(answer([asks]), [{ finding: 0, rule_id: 'R1', follows: null }]), log: () => {} });
  assert.equal(result.findings.length, 1, 'the request to confirm stays a finding');
  assert.equal(result.findings[0]!.severity, 'major');
  assert.deepEqual(result.answer.questions ?? [], []);
});

test('an incremental review drops the non-findings that it carries from the last review', async () => {
  const carried = { ...finding('save.ts', 'No change needed.'), anchor: 1, blocking: false, suggestion_range: null, fingerprint: '0'.repeat(16) };
  const delta = { since: first, score: 4, findings: [carried], settled: [] };
  const result = await reviewPullRequest({ repoDir: repo, base, head: second, level: 'balanced', apiKey: 'k', delta, fetch: model(answer([])), log: () => {} });
  assert.ok(result.delta, 'an incremental review');
  assert.deepEqual(result.findings.filter((f) => f.path === 'save.ts'), []);
});

test('a review in passes keeps the questions of every pass, once each', async () => {
  const shared = { path: 'list.ts', question: 'Does the product count from one?' };
  const byPass: Record<string, Answer> = {
    security: answer([], { questions: [shared] }),
    data: answer([], { questions: [shared, { path: 'save.ts', question: 'Is a saved count of zero allowed?' }] }),
    contracts: answer([], { questions: [] }),
  };
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const user: string = body.messages[1].content;
    const pass = BASE_PASSES.find((p) => user.endsWith(`${p.focus}\n`));
    const content = JSON.stringify(pass ? byPass[pass.id] : { verdicts: [] });
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  }) as typeof globalThis.fetch;
  const config = (level: 'lite' | 'balanced') => ({ ...levelConfig(level), models: ['test/model'] });
  const result = await reviewInPasses({ repoDir: repo, base, head: first, level: 'balanced', apiKey: 'k', fetch, log: () => {} }, { passConfig: config('lite'), verifyConfig: config('balanced') });
  assert.deepEqual(result.answer.questions, [shared, { path: 'save.ts', question: 'Is a saved count of zero allowed?' }]);
});

test('a review in passes survives a null question of a pass', async () => {
  const byPass: Record<string, unknown> = {
    security: { ...answer([]), questions: [null, { path: 'list.ts' }, { path: 'list.ts', question: 'Does the product count from one?' }] },
    data: answer([]),
    contracts: answer([]),
  };
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const user: string = body.messages[1].content;
    const pass = BASE_PASSES.find((p) => user.endsWith(`${p.focus}\n`));
    const content = JSON.stringify(pass ? byPass[pass.id] : { verdicts: [] });
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  }) as typeof globalThis.fetch;
  const config = (level: 'lite' | 'balanced') => ({ ...levelConfig(level), models: ['test/model'] });
  const result = await reviewInPasses({ repoDir: repo, base, head: first, level: 'balanced', apiKey: 'k', fetch, log: () => {} }, { passConfig: config('lite'), verifyConfig: config('balanced') });
  assert.deepEqual(result.answer.questions, [{ path: 'list.ts', question: 'Does the product count from one?' }]);
});

test('the answer schema asks for the questions', () => {
  assert.ok(ANSWER_SCHEMA.required.includes('questions'));
  assert.deepEqual((ANSWER_SCHEMA.properties as Record<string, { items?: { required?: string[] } }>).questions?.items?.required, ['path', 'question']);
});
