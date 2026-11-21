// REV-117. The link call: after the review, one small call links the findings to the rules and to
// the earlier findings. The review never asks for these links in its own answer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { HeldEarlier } from '../src/earlier.ts';
import type { Finding } from '../src/findings.ts';
import { providerLevelConfig, reviewPullRequest, type Answer } from '../src/index.ts';
import { levelConfig } from '../src/levels.ts';
import { LINK_SCHEMA, linkConfig, linkFindings, withLinkUsage } from '../src/link.ts';
import { rulesSection, type Rule } from '../src/rules.ts';
import { messageResponse } from './sse.ts';

const quiet = () => {};

const finding = (title: string, overrides: Partial<Finding> = {}): Finding => ({
  path: 'src/pay.ts',
  start_line: 2,
  line: 2,
  severity: 'minor',
  category: 'bug',
  confidence: 90,
  title,
  scenario: `${title}.`,
  fix: 'f',
  suggestion: '',
  ...overrides,
});

const RULE: Rule = { id: 'rule-any', scope: 'repo', title: 'No any', text: 'No `any` in TypeScript.', paths: ['**/*.ts'], severityFloor: 'major' };
const { packed: RULES } = rulesSection([RULE]);
const EARLIER: HeldEarlier[] = [
  { key: 'k1', path: 'src/pay.ts', line: 2, title: 'Amount read as any', severity: 'major', category: 'bug', status: 'open', reason: null, commit: 'c', ref: 'E1', changed: true },
];

/** A fetch that answers each request with `reply(body)`, as OpenRouter, and records the bodies. */
function openRouter(reply: (body: any) => object | Response) {
  const bodies: any[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const out = reply(body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ model: body.model, provider: 'Fake', choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.0002 } }));
  }) as typeof globalThis.fetch;
  return { fetch, bodies };
}

test('no rule and no earlier finding, or no finding: no call, and no stray link stays', async () => {
  const { fetch, bodies } = openRouter(() => ({ links: [] }));
  const client = { apiKey: 'k', fetch, log: quiet };
  const none = await linkFindings(client, levelConfig('lite'), [finding('A', { rule_id: 'R1', follows: 'E1' })], [], []);
  assert.deepEqual(none.findings, [finding('A')]);
  assert.equal(none.report.status, 'none');
  assert.equal((await linkFindings(client, levelConfig('lite'), [], RULES, EARLIER)).report.status, 'none');
  assert.equal(bodies.length, 0);
});

test('the links go on their findings; an unknown index or reference is ignored, and the first link of a finding wins', async () => {
  const { fetch, bodies } = openRouter(() => ({
    links: [
      { finding: 0, rule_id: 'r1', follows: 'E1' },
      { finding: 0, rule_id: null, follows: null },
      { finding: 1, rule_id: 'R9', follows: 'E7' },
      { finding: 5, rule_id: 'R1', follows: 'E1' },
      { finding: -1, rule_id: 'R1', follows: null },
      { finding: 1.5, rule_id: 'R1', follows: null },
      { finding: 2, rule_id: 'R1', follows: null },
      null,
    ],
  }));
  const out = await linkFindings({ apiKey: 'k', fetch, log: quiet }, levelConfig('balanced'), [finding('A'), finding('B'), finding('C')], RULES, EARLIER);
  assert.deepEqual(
    out.findings.map((f) => [f.title, f.rule_id, f.follows]),
    [
      ['A', 'R1', 'E1'],
      ['B', undefined, undefined],
      ['C', 'R1', undefined],
    ],
  );
  assert.deepEqual({ ...out.report, usage: null }, { status: 'done', rules: 2, follows: 1, reverses: 0, usage: null });
  // The cheapest model of OpenRouter, at low effort, with the link schema and its prompt.
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, 'anthropic/claude-haiku-5.5');
  assert.equal(bodies[0].reasoning.effort, 'low');
  assert.deepEqual(bodies[0].response_format.json_schema, { name: 'links', strict: true, schema: LINK_SCHEMA });
  assert.match(bodies[0].messages[0].content, /You link the findings of a review/);
  assert.match(bodies[0].messages[1].content, /# Findings[\s\S]*"index": 2[\s\S]*# Rules[\s\S]*"ref": "R1"[\s\S]*# Earlier findings[\s\S]*"ref": "E1"/);
});

test('an answer with no list of links gives no link', async () => {
  const { fetch } = openRouter(() => ({ links: 'R1' }));
  const out = await linkFindings({ apiKey: 'k', fetch, log: quiet }, levelConfig('lite'), [finding('A')], RULES, []);
  assert.deepEqual(out.findings, [finding('A')]);
  assert.equal(out.report.status, 'done');
});

test('each provider gets a link model: the lite models of OpenRouter and Anthropic, else the models of the review', () => {
  assert.deepEqual(linkConfig('openrouter', levelConfig('heavy')).models, ['anthropic/claude-haiku-5.5', 'z-ai/glm-5.3']);
  assert.deepEqual(linkConfig('anthropic', providerLevelConfig('heavy', 'anthropic')).models, ['claude-haiku-5-5']);
  assert.deepEqual(linkConfig('openai_compatible', providerLevelConfig('heavy', 'openai_compatible', ['my-model', 'my-fallback'])).models, ['my-model', 'my-fallback']);
  assert.deepEqual(linkConfig('ollama', providerLevelConfig('lite', 'ollama', ['qwen'])).models, ['qwen']);
  const config = linkConfig('anthropic', levelConfig('heavy'));
  assert.equal(config.effort, 'low');
  assert.equal(config.thinking, false);
  assert.equal(config.patch, false);
  assert.equal(config.tools, undefined);
});

test('at Anthropic, the link call asks Haiku with no thinking, and sends one request only', async () => {
  const bodies: any[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return messageResponse('claude-haiku-5-5', [{ type: 'text', text: '{"links": [' }], 'max_tokens', { input: 50, output: 8000 });
  }) as typeof globalThis.fetch;
  const logs: string[] = [];
  const out = await linkFindings({ kind: 'anthropic', apiKey: 'k', fetch, log: (m) => logs.push(m) }, providerLevelConfig('balanced', 'anthropic'), [finding('A')], RULES, []);
  assert.equal(bodies.length, 1, 'no second request without thinking: the first one had none');
  assert.equal(bodies[0].model, 'claude-haiku-5-5');
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  assert.equal(bodies[0].output_config.effort, 'low');
  assert.equal(out.report.status, 'failed');
  assert.ok(logs.some((m) => /link of the findings .* failed/.test(m)));
});

test('the usage of the review counts the tokens and the cost of the link call, and keeps its own model and hashes', () => {
  const review = { model: 'claude-sonnet-5-5', prompt_tokens: 1000, completion_tokens: 200, cost: 0.01, schema_hash: 'abc', stop_reason: 'end_turn' };
  const link = { status: 'done' as const, rules: 1, follows: 0, usage: { model: 'claude-haiku-5-5', prompt_tokens: 300, completion_tokens: 40, cost: 0.0005, schema_hash: 'zzz' } };
  assert.deepEqual(withLinkUsage(review, link), { ...review, prompt_tokens: 1300, completion_tokens: 240, cost: 0.0105 });
  assert.deepEqual(withLinkUsage({ model: 'passes', cost: 0.01 }, link), { model: 'passes', cost: 0.0105 }, 'no tokens in the usage: only the cost');
  assert.equal(withLinkUsage(review, { status: 'failed', rules: 0, follows: 0, usage: null }), review);
});

let repo = '';
let base = '';
let head = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-link-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'pay.ts'), 'export function pay(amount: number) {\n  return amount;\n}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src', 'pay.ts'), 'export function pay(amount: any) {\n  return amount as any;\n}\n');
  git('commit', '-q', '-am', 'any');
  head = git('rev-parse', 'HEAD');
});
after(() => rmSync(repo, { recursive: true, force: true }));

const ANSWER: Answer = {
  confidence_score: 4,
  risk: 'Low',
  summary: 'Summary',
  diagram: '',
  findings: [finding('Amount typed as any', { suggestion: '  return amount;' })],
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
};

test('a failed link call leaves the review valid, with no link and the cost of the review only', async () => {
  const logs: string[] = [];
  const { fetch, bodies } = openRouter((body) => (body.response_format.json_schema.name === 'links' ? new Response('down', { status: 503 }) : ANSWER));
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'lite', apiKey: 'k', fetch, log: (m) => logs.push(m), rules: [RULE] });
  assert.ok(bodies.some((b) => b.response_format.json_schema.name === 'links'), 'the link call went out');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.rule_id, undefined);
  assert.equal(result.findings[0]!.severity, 'minor', 'no rule: no floor');
  assert.deepEqual(result.findings[0]!.suggestion_range, [2, 2]);
  assert.equal(result.link.status, 'failed');
  assert.equal(result.usage.cost, 0.0002);
  assert.ok(logs.some((m) => /the findings have no link/.test(m)));
});

test('a review with rules: the plain schema for the review, then the link that sets the rule and its floor', async () => {
  const { fetch, bodies } = openRouter((body) => (body.response_format.json_schema.name === 'links' ? { links: [{ finding: 0, rule_id: 'R1', follows: null }] } : ANSWER));
  const result = await reviewPullRequest({ repoDir: repo, base, head, level: 'lite', apiKey: 'k', fetch, log: quiet, rules: [RULE] });
  const [review, link] = bodies;
  assert.equal(review.response_format.json_schema.name, 'review');
  assert.ok(!JSON.stringify(review.response_format.json_schema.schema).includes('rule_id'));
  assert.doesNotMatch(review.messages[1].content, /`rule_id`/, 'the Rules section asks for no link');
  assert.equal(link.response_format.json_schema.name, 'links');
  assert.equal(result.findings[0]!.rule_id, RULE.id);
  assert.equal(result.findings[0]!.severity, 'major');
  assert.deepEqual(result.findings[0]!.suggestion_range, [2, 2], 'the link keeps the suggestion');
  assert.equal(result.usage.cost, 0.0004);
  assert.equal(result.usage.prompt_tokens, 14);
});
