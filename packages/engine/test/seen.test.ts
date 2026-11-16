// REV-100. A new finding on code that an earlier review already read does not block, unless it is
// critical. The case replays dojo#91: « STUDIO_HOST n'est ni dans .env.example ni documenté »
// came at the second review, on a file that did not change since the first one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import type { JobEarlier } from '../../protocol/src/index.ts';
import { findingKey, isBlocking, toConsider, type Answer, type Finding } from '../src/findings.ts';
import { reviewPullRequest } from '../src/index.ts';
import { descriptionBlock } from '../src/render.ts';
import { changedZonesSection, isSeen, seenCode } from '../src/seen.ts';

let repo = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const lines = (name: string, count: number, edit: Record<number, string> = {}) =>
  Array.from({ length: count }, (_, i) => edit[i + 1] ?? `export const ${name}${i + 1} = ${i + 1};`).join('\n') + '\n';

const SETTINGS = 'apps/app/src/routes/investigations/id/settings/page.tsx';
const ENGINE = 'packages/engine/src/operations.ts';
/** A path that git quotes in the header of a patch. */
const ACCENT = 'packages/engine/src/opérations [v2].ts';

// main; the pull request at its first review (`reviewed`); a push that changes operations.ts only
// (`pushed`); and, on another line, a force-push of the same change (`forced`).
let main1 = '';
let reviewed = '';
let pushed = '';
let forced = '';
before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-seen-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write(SETTINGS, lines('settings', 60));
  write(ENGINE, lines('op', 200));
  write(ACCENT, lines('acc', 40));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  main1 = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  write(SETTINGS, lines('settings', 60, { 33: 'const host = process.env.STUDIO_HOST;' }));
  write(ENGINE, lines('op', 200, { 100: 'export const set = (locale: string) => locale;' }));
  git('commit', '-q', '-am', 'feat: settings and text.set');
  reviewed = git('rev-parse', 'HEAD');
  write(ENGINE, lines('op', 200, { 100: 'export const set = (locale: string) => locale;', 150: 'export const apply = true;' }));
  write(ACCENT, lines('acc', 40, { 20: 'export const accent = true;' }));
  git('commit', '-q', '-am', 'fix: apply the operations');
  pushed = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'forced', main1);
  write(SETTINGS, lines('settings', 60, { 33: 'const host = process.env.STUDIO_HOST;' }));
  write(ENGINE, lines('op', 200, { 100: 'export const set = (locale: string) => locale;', 150: 'export const apply = true;' }));
  git('commit', '-q', '-am', 'feat: settings, text.set and apply, squashed');
  forced = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
});

after(() => rmSync(repo, { recursive: true, force: true }));

const finding = (path: string, line: number, title: string, severity: Finding['severity'] = 'major', extra: Partial<Finding> = {}): Finding => ({
  path,
  start_line: line,
  line,
  severity,
  category: 'contract',
  confidence: 90,
  title,
  scenario: 's',
  fix: 'f',
  suggestion: '',
  ...extra,
});

/** The finding of dojo#91, at its line on the unchanged settings page, as a P1. */
const studioHost = finding(SETTINGS, 33, "STUDIO_HOST n'est ni dans .env.example ni documenté");
/** A defect in the zone that the push changed. */
const applyBug = finding(ENGINE, 150, "L'opération est appliquée deux fois", 'major', { category: 'bug' });

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
  risk: 'r',
  summary: 's',
  diagram: '',
  findings,
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
});

const earlier = (score = 4): JobEarlier => ({ findings: [], last: { head: reviewed, score } });

const input = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof reviewPullRequest>[0]> = {}) => ({
  repoDir: repo,
  base: main1,
  head: pushed,
  level: 'balanced' as const,
  apiKey: 'k',
  fetch,
  log: () => {},
  ...extra,
});

test('dojo#91 replayed: a new P1 on code that the first review read is to consider, does not block, and does not lower the score', async () => {
  const model = fakeModel(() => answer(3, [studioHost]));
  const before = await reviewPullRequest(input(model.fetch, { earlier: earlier() }));
  assert.equal(before.verdict, 'REQUEST_CHANGES', 'without the last reviewed commit, the P1 blocks');
  assert.equal(before.score, 2);

  const result = await reviewPullRequest(input(model.fetch, { earlier: earlier(), reviewed }));
  const [f] = result.findings;
  assert.equal(f?.seen, true);
  assert.ok(toConsider(f!));
  assert.equal(f?.blocking, false);
  assert.notEqual(result.verdict, 'REQUEST_CHANGES');
  assert.equal(result.score, 4, 'the score of the first review stays: the model said 3');
  assert.equal(result.seenSince, reviewed);
  // The block lists it apart.
  const block = descriptionBlock(result.answer, [{ finding: f!, url: null }], [], 0, {}, result.lines, {
    count: 2,
    head: pushed,
    subject: 's',
    commitUrl: 'https://github.com/o/r/commit/x',
    level: 'balanced',
  });
  assert.match(block, /<h3>To consider \(code already reviewed\)<\/h3>[\s\S]*STUDIO_HOST n'est ni dans \.env\.example ni documenté/);
  assert.doesNotMatch(block, /<h3>Findings<\/h3>/);
});

test('guard: a critical finding on code already read keeps blocking', async () => {
  const critical = { ...studioHost, severity: 'critical' as const, title: 'Le jeton de session passe dans STUDIO_HOST' };
  const model = fakeModel(() => answer(2, [critical]));
  const result = await reviewPullRequest(input(model.fetch, { earlier: earlier(), reviewed }));
  assert.equal(result.findings[0]?.seen, true);
  assert.equal(result.findings[0]?.blocking, true);
  assert.equal(result.verdict, 'REQUEST_CHANGES');
  assert.equal(result.score, 2);
});

test('guard: a new defect in the zone that the push changed blocks and lowers the score', async () => {
  const model = fakeModel(() => answer(2, [applyBug]));
  const result = await reviewPullRequest(input(model.fetch, { earlier: earlier(), reviewed }));
  assert.equal(result.findings[0]?.seen, undefined);
  assert.equal(result.findings[0]?.blocking, true);
  assert.equal(result.verdict, 'REQUEST_CHANGES');
  assert.equal(result.scoreFloor, null);
});

test('guard: a finding that follows an earlier finding blocks as before, even on code already read', async () => {
  const known: JobEarlier = {
    findings: [{ key: findingKey(studioHost), path: SETTINGS, line: 33, title: studioHost.title, severity: 'major', category: 'contract', status: 'open', reason: null, commit: reviewed }],
    last: { head: reviewed, score: 2 },
  };
  const model = fakeModel(() => answer(2, [studioHost]));
  const result = await reviewPullRequest(input(model.fetch, { earlier: known, reviewed }));
  assert.equal(result.findings[0]?.follows, findingKey(studioHost));
  assert.equal(result.findings[0]?.blocking, true, 'the open P1 of the first review still blocks');
});

test('everything is new on the first review and after a force-push that removed the reviewed commit', async () => {
  const model = fakeModel(() => answer(3, [studioHost]));
  const first = await reviewPullRequest(input(model.fetch, { reviewed: null }));
  assert.equal(first.findings[0]?.seen, undefined);
  assert.equal(first.verdict, 'REQUEST_CHANGES');
  const afterForce = await reviewPullRequest(input(model.fetch, { head: forced, reviewed }));
  assert.equal(afterForce.findings[0]?.seen, undefined);
  assert.equal(afterForce.seenSince, null);
  assert.equal(afterForce.verdict, 'REQUEST_CHANGES');
});

test('the zone of a finding is its lines and 5 lines around; a file that the reviewed commit did not hold is new', () => {
  const seen = seenCode(repo, reviewed, pushed)!;
  assert.equal(isSeen(finding(ENGINE, 144, 'x'), seen), true);
  assert.equal(isSeen(finding(ENGINE, 145, 'x'), seen), false);
  assert.equal(isSeen(finding(ENGINE, 155, 'x'), seen), false);
  assert.equal(isSeen(finding(ENGINE, 156, 'x'), seen), true);
  assert.equal(isSeen(finding(ENGINE, 160, 'x', 'major', { start_line: 152 }), seen), false, 'a range that starts near the change');
  assert.equal(isSeen(finding('new.ts', 1, 'x'), seen), false);
  // git quotes this path in the header of a patch: the change must still count (cubic on #167).
  assert.equal(isSeen(finding(ACCENT, 20, 'x'), seen), false);
  assert.equal(isSeen(finding(ACCENT, 35, 'x'), seen), true);
  assert.equal(isBlocking({ ...studioHost, seen: true }, () => 33), false);
  assert.equal(isBlocking({ ...studioHost, seen: true, follows: 'abcdefabcdef' }, () => 33), true);
});

test('the pack of a whole review names the zones that changed since the last reviewed commit', async () => {
  const model = fakeModel(() => answer(4, []));
  await reviewPullRequest(input(model.fetch, { reviewed }));
  assert.match(model.packs[0]!, /## Changed since the last review\n\nAn earlier review of Kentō read this pull request at commit [0-9a-f]{9}\./);
  assert.match(model.packs[0]!, /- `packages\/engine\/src\/operations\.ts`: lines 150\n/);
  assert.doesNotMatch(model.packs[0]!, /settings\/page\.tsx`: lines/);
  assert.equal(changedZonesSection(null, [SETTINGS]), '');
});

test('with no earlier finding and no finding to consider, a whole review keeps the score of the model', async () => {
  const model = fakeModel(() => answer(3, []));
  const result = await reviewPullRequest(input(model.fetch, { earlier: earlier(4), reviewed }));
  assert.equal(result.scoreFloor, null);
  assert.equal(result.score, 3);
});
