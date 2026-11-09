// REV-88. The review of a push reads only the files of the pull request that changed since the last
// reviewed head, keeps the findings of the others, and keeps its score without a new finding.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Delta } from '../src/delta.ts';
import { findingKey, type Answer, type Finding } from '../src/findings.ts';
import { reviewPullRequest, reviewUnlessUnchanged } from '../src/index.ts';

let repo = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (path: string, text: string) => writeFileSync(join(repo, path), text);

const fn = (name: string, body: string) => `export function ${name}(a: number, b: number) {\n  return ${body};\n}\n`;

// main: a.ts and b.ts. pr: a commit on both (reviewed), then a commit on b.ts only.
let main1 = '';
let reviewed = '';
let pushed = '';
before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-delta-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('a.ts', fn('sum', 'a + b'));
  write('b.ts', fn('mul', 'a * b'));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  main1 = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  write('a.ts', fn('sum', 'a - b'));
  write('b.ts', fn('mul', 'a / b'));
  git('commit', '-q', '-am', 'change a and b');
  reviewed = git('rev-parse', 'HEAD');
  write('b.ts', fn('mul', 'a * b * 1'));
  git('commit', '-q', '-am', 'fix b');
  pushed = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
});

after(() => rmSync(repo, { recursive: true, force: true }));

const finding = (path: string, title: string, severity: Finding['severity'] = 'minor'): Finding => ({
  path,
  start_line: 2,
  line: 2,
  severity,
  category: 'bug',
  confidence: 90,
  title,
  scenario: 's',
  fix: 'f',
  suggestion: '',
});

/** A model that answers `answer` and records the packs that it reads. */
function fakeModel(answer: () => Answer) {
  const packs: string[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    packs.push(body.messages[1].content);
    return new Response(
      JSON.stringify({ model: body.model, provider: 'Fake', choices: [{ message: { content: JSON.stringify(answer()) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, packs };
}

const answer = (score: number, findings: Finding[]): Answer => ({
  confidence_score: score,
  risk: 'Faible',
  summary: 'Résumé',
  diagram: '',
  findings,
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
});

const subtraction = finding('a.ts', 'La somme soustrait');
const division = finding('b.ts', 'Le produit divise');

/** The last review, at `reviewed`, with its two findings, scored 4. */
const delta = (settled: Delta['settled'] = []): Delta => ({ since: reviewed, score: 4, findings: [subtraction, division], settled });

const input = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof reviewPullRequest>[0]> = {}) => ({
  repoDir: repo,
  base: main1,
  head: pushed,
  level: 'lite' as const,
  apiKey: 'k',
  fetch,
  log: () => {},
  ...extra,
});

test('the pack holds only the files changed since the last review, and the earlier findings', async () => {
  const model = fakeModel(() => answer(3, []));
  const full = await reviewPullRequest(input(model.fetch));
  const incremental = await reviewPullRequest(input(model.fetch, { delta: delta() }));
  const [wholePack, deltaPack] = model.packs;
  assert.match(wholePack!, /a\.ts/);
  assert.doesNotMatch(deltaPack!, /^diff --git a\/a\.ts/m, 'a.ts did not change since the last review');
  assert.match(deltaPack!, /^diff --git a\/b\.ts/m);
  assert.match(deltaPack!, /This pull request was reviewed at commit/);
  assert.match(deltaPack!, /`b\.ts:2` \(minor\) Le produit divise/, 'the finding of a file read again, to report again if it stays');
  const diff = (pack: string) => pack.slice(pack.indexOf('## Diff'));
  assert.ok(diff(deltaPack!).length < diff(wholePack!).length, 'a smaller diff');
  assert.deepEqual(incremental.delta, { since: reviewed, files: ['b.ts'], pullFiles: ['a.ts', 'b.ts'] });
  assert.equal(full.delta, null);
  // The key reads the whole pull request: the same for both.
  assert.equal(incremental.reuseKey, full.reuseKey);
});

test('the findings of the files not read again stay, a finding fixed since goes, and the score stays without a new finding', async () => {
  const model = fakeModel(() => answer(3, []));
  const result = await reviewPullRequest(input(model.fetch, { delta: delta() }));
  assert.deepEqual(
    result.findings.map((f) => f.title),
    ['La somme soustrait'],
    'a.ts did not change: its finding stays; b.ts changed and the model did not report its finding again',
  );
  assert.equal(result.findings[0]!.anchor, 2, 'the finding kept anchors on the changed lines of the pull request');
  assert.equal(result.score, 4, 'the model said 3 with no new finding: the score of the last review stays');
});

test('a new finding is a new fact: the score of the model holds', async () => {
  const model = fakeModel(() => answer(3, [finding('b.ts', 'Le produit oublie le signe')]));
  const result = await reviewPullRequest(input(model.fetch, { delta: delta() }));
  assert.equal(result.score, 3);
  assert.deepEqual(result.findings.map((f) => f.title).sort(), ['La somme soustrait', 'Le produit oublie le signe']);
});

test('a finding found again is no new fact, and a dismissed one raised again is dropped', async () => {
  const dismissed = finding('b.ts', 'Le produit déborde');
  const settled: Delta['settled'] = [{ path: 'b.ts', line: 2, title: dismissed.title, status: 'dismissed', key: findingKey(dismissed), fingerprint: '0'.repeat(16) }];
  const model = fakeModel(() => answer(2, [division, dismissed]));
  const result = await reviewPullRequest(input(model.fetch, { delta: delta(settled) }));
  assert.deepEqual(result.findings.map((f) => f.title).sort(), ['La somme soustrait', 'Le produit divise']);
  assert.deepEqual(result.settledAgain.map((f) => f.title), ['Le produit déborde']);
  assert.equal(result.score, 4, 'only known findings: the score stays');
  assert.match(model.packs[0]!, /Findings that are settled[\s\S]*`b\.ts:2` \(dismissed\) Le produit déborde/);
});

test('a force-push or a rebase reads the whole pull request again', async () => {
  // A head whose history does not hold the last reviewed head.
  git('checkout', '-q', '-b', 'rewritten', main1);
  write('a.ts', fn('sum', 'a - b'));
  write('b.ts', fn('mul', 'a * b'));
  git('commit', '-q', '-am', 'squashed');
  const rewritten = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  const model = fakeModel(() => answer(3, []));
  const result = await reviewPullRequest(input(model.fetch, { head: rewritten, delta: delta() }));
  assert.equal(result.delta, null);
  assert.match(model.packs[0]!, /^diff --git a\/a\.ts/m);
  assert.doesNotMatch(model.packs[0]!, /This pull request was reviewed at commit/);
  assert.equal(result.score, 3, 'no floor on a whole review');
});

test('a merge of main that changes no file of the pull request: the same key calls no model, another key reads the whole pull request', async () => {
  git('checkout', '-q', 'main');
  write('other.ts', 'export const other = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'main moves on');
  const main2 = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'merged', reviewed);
  git('merge', '-q', '--no-edit', main2);
  const merged = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  const model = fakeModel(() => answer(3, []));
  const key = (await reviewPullRequest(input(model.fetch, { base: main1, head: reviewed }))).reuseKey;
  const calls = model.packs.length;
  const same = await reviewUnlessUnchanged(input(model.fetch, { base: main2, head: merged, delta: delta(), previousKey: key }));
  assert.ok('unchanged' in same, 'the same input: no model call');
  assert.equal(model.packs.length, calls);
  // Another key with no file of the pull request changed (a rule, a reply, the context): the change
  // is not in the diff, so the review reads the whole pull request, and is not reused.
  const other = await reviewUnlessUnchanged(input(model.fetch, { base: main2, head: merged, delta: delta(), previousKey: 'e'.repeat(64) }));
  assert.ok(!('unchanged' in other));
  assert.equal(other.delta, null);
  assert.match(model.packs.at(-1)!, /^diff --git a\/a\.ts/m)
});

test('a file whose change the pull request reverted since is read again, and its findings go', async () => {
  git('checkout', '-q', '-b', 'reverted', reviewed);
  write('b.ts', fn('mul', 'a * b'));
  git('commit', '-q', '-am', 'revert b');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  const model = fakeModel(() => answer(4, []));
  const result = await reviewPullRequest(input(model.fetch, { head, delta: delta() }));
  assert.deepEqual(result.delta?.files, ['b.ts']);
  assert.match(model.packs[0]!, /^diff --git a\/b\.ts/m, 'the revert is in the pack');
  assert.deepEqual(result.findings.map((f) => f.title), ['La somme soustrait'], 'b.ts is no longer in the pull request');
});

test('a file renamed since the last review is read again under its new path, and its old finding goes', async () => {
  git('checkout', '-q', '-b', 'renamed', pushed);
  git('mv', 'a.ts', 'c.ts');
  git('commit', '-q', '-m', 'rename a');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  const model = fakeModel(() => answer(4, []));
  const result = await reviewPullRequest(input(model.fetch, { head, delta: { ...delta(), since: pushed } }));
  assert.deepEqual(result.delta?.files, ['a.ts', 'c.ts'], 'both paths of the rename are read again');
  assert.match(model.packs[0]!, /c\.ts/);
  assert.ok(!result.findings.some((f) => f.path === 'a.ts'), 'a.ts is no longer in the pull request');
  assert.deepEqual(result.findings.map((f) => f.title), ['Le produit divise'], 'b.ts did not change since: its finding comes back');
});

test('a finding on the old path of a file renamed before the last review does not come back', async () => {
  git('checkout', '-q', '-b', 'renamed-before', pushed);
  git('mv', 'a.ts', 'c.ts');
  git('commit', '-q', '-m', 'rename a');
  const since = git('rev-parse', 'HEAD');
  write('b.ts', fn('mul', 'a * b * 2'));
  git('commit', '-q', '-am', 'change b');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  const model = fakeModel(() => answer(4, []));
  // The last review still carried a finding on a.ts, which no longer exists at the head.
  const result = await reviewPullRequest(input(model.fetch, { head, delta: { ...delta(), since } }));
  assert.deepEqual(result.delta?.files, ['b.ts']);
  assert.ok(!result.findings.some((f) => f.path === 'a.ts'), 'a.ts is not at the head');
});

test('a finding of the last review settled since does not come back on a file not read again, by its key', async () => {
  const model = fakeModel(() => answer(4, []));
  // a.ts did not change since: its finding was marked fixed, with another fingerprint (its lines moved).
  const settled: Delta['settled'] = [{ path: 'a.ts', line: 9, title: subtraction.title, status: 'fixed', key: findingKey(subtraction), fingerprint: '0'.repeat(16) }];
  const result = await reviewPullRequest(input(model.fetch, { delta: delta(settled) }));
  assert.ok(!result.findings.some((f) => f.title === subtraction.title));
});

test('the floor of the score never lifts it over a blocking finding carried from the last review', async () => {
  const blocking = finding('a.ts', 'La somme soustrait', 'major');
  const model = fakeModel(() => answer(5, []));
  const result = await reviewPullRequest(input(model.fetch, { delta: { since: reviewed, score: 4, findings: [blocking], settled: [] } }));
  assert.deepEqual(result.findings.map((f) => [f.title, f.blocking]), [['La somme soustrait', true]]);
  assert.equal(result.score, 2, 'a blocking finding caps the score at 2, floor or not');
});

test('a fixed finding raised again is a regression: it stays, and the score of the model holds', async () => {
  const back = finding('b.ts', 'Le produit oublie le signe');
  const settled: Delta['settled'] = [{ path: 'b.ts', line: 2, title: back.title, status: 'fixed', key: findingKey(back), fingerprint: '0'.repeat(16) }];
  const model = fakeModel(() => answer(2, [back]));
  const result = await reviewPullRequest(input(model.fetch, { delta: delta(settled) }));
  assert.ok(result.findings.some((f) => f.title === back.title), 'a fixed finding back is kept');
  assert.deepEqual(result.settledAgain, [], 'only a dismissed or kept finding is dropped');
  assert.equal(result.score, 2, 'a finding back is a new fact: no floor');
});

test('a known finding found again more severe is a new fact: no floor', async () => {
  // Not blocking (a low confidence), so that only the floor decides the score.
  const worse = { ...division, severity: 'major' as const, confidence: 40 };
  const model = fakeModel(() => answer(3, [worse]));
  const result = await reviewPullRequest(input(model.fetch, { delta: delta() }));
  assert.equal(result.findings.find((f) => f.title === division.title)?.blocking, false);
  assert.equal(result.score, 3, 'minor before, major now: the score of the model holds, not the 4 of the last review');
});

test('each lift of the score by the floor is in the log', async () => {
  const logs: string[] = [];
  const model = fakeModel(() => answer(3, []));
  const lifted = await reviewPullRequest(input(model.fetch, { delta: delta(), log: (m) => logs.push(m) }));
  assert.deepEqual(lifted.scoreFloor, { model: 3, kept: 4 });
  assert.ok(logs.includes('score kept at 4 by the floor: the model said 3 with no new finding on 1 files read again'), logs.join('\n'));
  const quiet: string[] = [];
  await reviewPullRequest(input(fakeModel(() => answer(5, [])).fetch, { delta: delta(), log: (m) => quiet.push(m) }));
  assert.ok(!quiet.some((m) => m.startsWith('score kept')), 'no line when the floor changes nothing');
});

test('a blocking finding fixed in a file read again lets the score rise: the floor never holds it down', async () => {
  // The last review scored 2 because of a blocking finding on b.ts; this push fixes it.
  const blocker = finding('b.ts', 'Le produit divise', 'major');
  const model = fakeModel(() => answer(5, []));
  const result = await reviewPullRequest(input(model.fetch, { delta: { since: reviewed, score: 2, findings: [subtraction, blocker], settled: [] } }));
  assert.deepEqual(result.findings.map((f) => f.title), ['La somme soustrait'], 'the fixed one goes, the one of a.ts stays');
  assert.equal(result.score, 5, 'the floor is a minimum: the score of the model rises over it');
  assert.equal(result.scoreFloor, null);
});

test('a blocking finding carried on a file not read again keeps its anchor and stays blocking after a merge of main', async () => {
  git('checkout', '-q', 'main');
  write('z.ts', 'export const z = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'main moves on, another file');
  const main3 = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'merged-blocking', pushed);
  git('merge', '-q', '--no-edit', main3);
  write('b.ts', fn('mul', 'a * b * 3'));
  git('commit', '-q', '-am', 'change b again');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  // The last review, at `pushed`, had a blocking finding on a.ts line 2, anchored on a changed line.
  const blocking = { ...finding('a.ts', 'La somme soustrait', 'major'), anchor: 2, blocking: true, suggestion_range: null };
  const model = fakeModel(() => answer(5, []));
  const result = await reviewPullRequest(input(model.fetch, { base: main3, head, delta: { since: pushed, score: 2, findings: [blocking], settled: [] } }));
  assert.deepEqual(result.delta?.files, ['b.ts'], 'a.ts did not change since: not read again');
  const carried = result.findings.find((f) => f.path === 'a.ts')!;
  assert.deepEqual([carried.anchor, carried.blocking], [2, true], 'the same anchor, still blocking');
  assert.equal(result.score, 2);
});
