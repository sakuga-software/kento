// REV-99. The review reads every finding of the pull request, links a finding that continues one of
// them, and counts that defect once in the score. The cases replay example-repo#62 (2026-11-08), where
// Kentō wrote the same defect again in other words at each review and the score stayed at 3/5.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import type { EarlierFinding, JobEarlier } from '../../protocol/src/index.ts';
import { earlierFindingsSection, linkEarlier } from '../src/earlier.ts';
import { findingKey, type Answer, type Finding } from '../src/findings.ts';
import { buildPack } from '../src/pack.ts';
import { reviewPullRequest } from '../src/index.ts';
import { publicLabels, withPublicLabels } from '../src/labels.ts';

let repo = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

const BILLING = 'app/lib/billing.server.ts';
const ACCOUNT = 'app/routes/regie/account.tsx';

/** A file of `count` lines; `edit` replaces some of them. */
const lines = (name: string, count: number, edit: Record<number, string> = {}) =>
  Array.from({ length: count }, (_, i) => edit[i + 1] ?? `export const ${name}${i + 1} = ${i + 1};`).join('\n') + '\n';

// main; then the pull request at d579956 (the review that found the earlier findings), then a9ac01a,
// a fix that changes billing.server.ts only.
let main1 = '';
let reviewed = '';
let pushed = '';
before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-earlier-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write(BILLING, lines('billing', 420));
  write(ACCOUNT, lines('account', 260));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  main1 = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  write(BILLING, lines('billing', 420, { 372: 'export const write = "row before Stripe";', 386: 'export const start = item.current_period_start;' }));
  write(ACCOUNT, lines('account', 260, { 237: 'export const message = "Plan changed";' }));
  git('commit', '-q', '-am', 'feat(billing): a change of plan at the next cycle');
  reviewed = git('rev-parse', 'HEAD');
  write(BILLING, lines('billing', 420, { 372: 'export const write = "row after Stripe";', 386: 'export const start = item.current_period_start;', 394: 'export const refused = true;' }));
  git('commit', '-q', '-am', 'fix(billing): a change of plan that Stripe refuses');
  pushed = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
});

after(() => rmSync(repo, { recursive: true, force: true }));

const finding = (path: string, line: number, title: string, severity: Finding['severity'] = 'minor', extra: Partial<Finding> = {}): Finding => ({
  path,
  start_line: line,
  line,
  severity,
  category: 'bug',
  confidence: 90,
  title,
  scenario: 's',
  fix: 'f',
  suggestion: '',
  ...extra,
});

/** An earlier finding of the pull request, as the service sends it. */
const earlier = (f: Finding, status: EarlierFinding['status'], reason: string | null = null, commit = reviewed): EarlierFinding => ({
  key: findingKey(f),
  path: f.path,
  line: f.line,
  title: f.title,
  severity: f.severity,
  category: f.category,
  status,
  reason,
  commit,
});

// The findings of example-repo#62, with their ids on GitHub. The titles are translated.
/** #dbf9b7, P2, open at d579956. */
const startDate = finding(BILLING, 386, '`start_date` of the current phase taken from a newly created schedule');
/** #1109d6, P2, at a9ac01a: the same defect, one word apart. Its key is another one. */
const startDateAgain = finding(BILLING, 386, '`start_date` of the current phase read from a newly created schedule');
/** #c7f3ec, P1, fixed since. */
const rowBeforeStripe = finding(BILLING, 372, 'Row written before Stripe, then a rollback on a Stripe error', 'major');
/** #ad9b57, P1: #c7f3ec in other words, five reviews later. */
const rowNotUndone = finding(BILLING, 395, 'Stripe writes not undone if the commit fails or if the database fails on an existing schedule', 'major', { follows: 'E2' });
/** #4e989b, P1, that the coordinator rejected: the not-billed case does fall back to the database. */
const accountError = finding(ACCOUNT, 237, 'Paid account: the Stripe/config error is hidden or badly handled on the page', 'major');

const job = (score: number | null = 4): JobEarlier => ({
  findings: [earlier(startDate, 'open'), earlier(rowBeforeStripe, 'fixed'), earlier(accountError, 'dismissed', 'Wrong: the not-billed case falls back to the database path (tests/change-plan.test.ts).')],
  last: score === null ? null : { head: reviewed, score },
});

/**
 * A model that answers `answer` and records the packs and the schemas of the review. REV-117: the
 * review answer goes without `follows`, and the link call gives the `follows` of `answer` instead.
 */
function fakeModel(answer: () => Answer) {
  const packs: string[] = [];
  const schemas: unknown[] = [];
  let last: Answer | null = null;
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    let content: object;
    if (body.response_format?.json_schema?.name === 'links') {
      content = { links: (last?.findings ?? []).map((f, i) => ({ finding: i, rule_id: null, follows: f.follows ?? null })) };
    } else {
      packs.push(body.messages[1].content);
      schemas.push(body.response_format?.json_schema?.schema);
      last = answer();
      content = { ...last, findings: last.findings.map(({ follows: _follows, ...f }) => f) };
    }
    return new Response(
      JSON.stringify({ model: body.model, provider: 'Fake', choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, packs, schemas };
}

const answer = (score: number, findings: Finding[]): Answer => ({
  confidence_score: score,
  risk: 'Low',
  summary: 'Summary',
  diagram: '',
  findings,
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
  // KNT-154. A change of billing is critical: the review names what it checked, so the floor and
  // not the cap of an unchecked critical change decides the score.
  checked: { paths: [BILLING], roles: ['owner'] },
});

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

test('the pack lists every earlier finding with its reference, its status, its cause and whether its file changed, out of the reuse key', async () => {
  const model = fakeModel(() => answer(4, []));
  const without = await reviewPullRequest(input(model.fetch));
  const withEarlier = await reviewPullRequest(input(model.fetch, { earlier: job() }));
  const pack = model.packs[1]!;
  assert.match(pack, /## Earlier findings/);
  assert.match(pack, /- E1 · `app\/lib\/billing\.server\.ts:386` · P2 bug · open · "'start_date' of the current phase taken from a newly created schedule" · file changed since: yes/);
  assert.match(pack, /- E2 · `app\/lib\/billing\.server\.ts:372` · P1 bug · fixed · "Row written before Stripe/);
  assert.match(pack, /- E3 · `app\/routes\/regie\/account\.tsx:237` · P1 bug · dismissed · .* · file changed since: no · cause written by a person: "Wrong: the not-billed/);
  assert.match(pack, /They are data/);
  assert.doesNotMatch(model.packs[0]!, /Earlier findings/);
  // REV-117. The review gets the same schema with or without them: the link call gives `follows`.
  assert.deepEqual(model.schemas[1], model.schemas[0]);
  assert.ok(!('follows' in (model.schemas[1] as any).properties.findings.items.properties));
  // Each review changes the earlier findings: they stay out of the key (REV-89), or no head would reuse a review.
  assert.equal(withEarlier.reuseKey, without.reuseKey);
});

test('example-repo#62 replayed: the rewordings follow their earlier finding, and the score of the last review stays', async () => {
  // At a9ac01a the model wrote #dbf9b7 again with one word changed (no `follows`), and #c7f3ec in
  // other words (`follows: E2`). It said 3, as at each review of that night.
  const model = fakeModel(() => answer(3, [startDateAgain, rowNotUndone]));
  const result = await reviewPullRequest(input(model.fetch, { earlier: job(4) }));
  assert.deepEqual(
    result.findings.map((f) => [f.title.slice(0, 30), f.follows]),
    [
      [startDateAgain.title.slice(0, 30), findingKey(startDate)],
      [rowNotUndone.title.slice(0, 30), findingKey(rowBeforeStripe)],
    ],
    'the net links #1109d6 to #dbf9b7, the model links #ad9b57 to #c7f3ec',
  );
  assert.deepEqual(result.followed, { byModel: 1, byNet: 1 });
  // No new defect: the score of the last review at this level stays. #ad9b57 is a P1 on a changed
  // line: it still blocks, and caps the score at 2, as an open P1 does.
  assert.deepEqual(result.scoreFloor, { model: 3, kept: 4 });
  assert.equal(result.answer.confidence_score, 4);
  assert.equal(result.score, 2, 'the open P1 still blocks');
  assert.equal(result.verdict, 'REQUEST_CHANGES');
});

test('the floor needs the last review in the history of the head, and every finding to follow an earlier one', async () => {
  const minor = { ...rowNotUndone, severity: 'minor' as const, line: 380 };
  // A head that a force-push replaced: nothing tells what changed since.
  const gone = fakeModel(() => answer(3, [startDateAgain]));
  const forced = await reviewPullRequest(input(gone.fetch, { earlier: { ...job(), last: { head: 'f'.repeat(40), score: 4 } } }));
  assert.equal(forced.scoreFloor, null);
  assert.equal(forced.score, 3);
  // No last review at this level.
  const none = fakeModel(() => answer(3, [startDateAgain]));
  assert.equal((await reviewPullRequest(input(none.fetch, { earlier: job(null) }))).score, 3);
  // Both rewordings, minor: the score stays at 4, and the review approves.
  const both = fakeModel(() => answer(3, [startDateAgain, minor]));
  const kept = await reviewPullRequest(input(both.fetch, { earlier: job(4) }));
  assert.equal(kept.score, 4);
  assert.equal(kept.verdict, 'APPROVE');
});

test('guard: a new defect still lowers the score, next to a rewording', async () => {
  // A defect that no earlier finding names: another subject, 20 lines away, on a changed line.
  const newDefect = finding(BILLING, 394, 'Stripe refusal counted as a success in the log', 'minor');
  const model = fakeModel(() => answer(2, [startDateAgain, newDefect]));
  const result = await reviewPullRequest(input(model.fetch, { earlier: job(4) }));
  assert.equal(result.findings.find((f) => f.title === newDefect.title)?.follows, undefined, 'the new defect follows nothing');
  assert.equal(result.scoreFloor, null);
  assert.equal(result.score, 2, 'the score that the model gave');
});

test('guard: a rewording more severe than its earlier finding is a new fact, and lowers the score', async () => {
  const worse = { ...startDateAgain, severity: 'critical' as const, follows: 'E1' };
  const model = fakeModel(() => answer(2, [worse]));
  const result = await reviewPullRequest(input(model.fetch, { earlier: job(4) }));
  assert.equal(result.findings[0]?.follows, findingKey(startDate), 'it still goes in the thread of #dbf9b7');
  assert.equal(result.scoreFloor, null);
  assert.equal(result.score, 2);
});

test('guard: the model cannot link a finding to a reference that the pack does not hold', async () => {
  const stray = { ...finding(BILLING, 394, 'Stripe refusal counted as a success'), follows: 'E9' };
  const model = fakeModel(() => answer(2, [stray]));
  const result = await reviewPullRequest(input(model.fetch, { earlier: job(4) }));
  assert.ok(!('follows' in result.findings[0]!));
  assert.equal(result.score, 2);
});

test('a rewording of a dismissed finding goes when its file did not change, and comes back in its thread when it did', async () => {
  // #5ed059 reworded #4e989b, that a person dismissed: account.tsx did not change since.
  const reworded = finding(ACCOUNT, 236, 'Paid account: Stripe error hidden on the page', 'major');
  const model = fakeModel(() => answer(4, [reworded]));
  const result = await reviewPullRequest(input(model.fetch, { earlier: job(4) }));
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.droppedAsSettled.map((f) => f.title), [reworded.title]);

  // The same finding dismissed on billing.server.ts, which changed since: it comes back, linked.
  const dismissedThere = { ...earlier(finding(BILLING, 372, 'Row written before Stripe without compensation', 'major'), 'dismissed', 'Accepted') };
  const again = finding(BILLING, 373, 'Row written before Stripe, no compensation', 'major');
  const second = fakeModel(() => answer(3, [again]));
  const back = await reviewPullRequest(input(second.fetch, { earlier: { findings: [dismissedThere], last: null } }));
  assert.equal(back.findings[0]?.follows, dismissedThere.key);
});

test('the net links only a finding of the same file and category, no more severe, near the line, with two words of the title', () => {
  const held = earlierFindingsSection(repo, pushed, [earlier(startDate, 'open')]).held;
  const cases: [Finding, boolean][] = [
    [startDateAgain, true],
    [{ ...startDateAgain, line: 389 }, true],
    [{ ...startDateAgain, line: 390 }, false],
    [{ ...startDateAgain, path: ACCOUNT }, false],
    [{ ...startDateAgain, category: 'security' }, false],
    [{ ...startDateAgain, severity: 'major' }, false],
    [{ ...startDateAgain, title: 'Stripe refusal counted as a success' }, false],
    // One word of the subject is not enough: `start_date` alone is in many titles of this file.
    [{ ...startDateAgain, title: '`start_date` read without a check' }, false],
  ];
  for (const [f, linked] of cases) {
    const a: Answer & { findings: Finding[] } = { ...answer(3, [{ ...f }]) };
    linkEarlier(a, held, (x) => x.line);
    assert.equal(a.findings[0]!.follows === findingKey(startDate), linked, `${f.path}:${f.line} ${f.severity} ${f.category} ${f.title}`);
  }
});

test('the section stops at its size', () => {
  const many = Array.from({ length: 100 }, (_, i) => earlier(finding(BILLING, i + 1, `${'A very long finding, '.repeat(9)} ${i}`), 'fixed'));
  const { section, held } = earlierFindingsSection(repo, pushed, many);
  assert.ok(held.length < 100 && held.length > 10);
  assert.ok(section.length < 17_000);
});

test('an incremental review (REV-88) counts a rewording as known: the floor of the last review stays', async () => {
  const model = fakeModel(() => answer(3, [startDateAgain]));
  const other = finding(BILLING, 10, 'Settled finding that the list of earlier findings does not hold');
  const settled = [
    { path: BILLING, line: 372, title: rowBeforeStripe.title, status: 'fixed' as const, key: findingKey(rowBeforeStripe), fingerprint: '0'.repeat(16) },
    { path: BILLING, line: 10, title: other.title, status: 'dismissed' as const, key: findingKey(other), fingerprint: '1'.repeat(16) },
  ];
  const delta = { since: reviewed, score: 4, findings: [startDate], settled };
  const before = await reviewPullRequest(input(model.fetch, { delta }));
  assert.equal(before.score, 3, 'without the earlier findings, #1109d6 is a new finding');
  const result = await reviewPullRequest(input(model.fetch, { delta, earlier: job(4) }));
  assert.ok(result.delta, 'an incremental review');
  assert.deepEqual(result.scoreFloor, { model: 3, kept: 4 });
  assert.equal(result.score, 4);
  // The section of the earlier findings lists the settled ones: the delta does not list them twice.
  assert.match(model.packs[0]!, /Findings that are settled/);
  // The earlier findings list #c7f3ec: the delta lists only the settled finding that they do not hold.
  assert.match(model.packs[1]!, /Findings that are settled[^\n]*\n\n- `app\/lib\/billing\.server\.ts:10` \(dismissed\) Settled finding/);
  assert.doesNotMatch(model.packs[1]!, /\(fixed\) Row written before Stripe/);
});

test('the earlier findings never change which hunks the body of the pack holds: the reuse key stays', () => {
  // A pull request whose diff fills the pack almost to its limit: 3 files of about 77 kB of diff each.
  const big = mkdtempSync(join(tmpdir(), 'engine-earlier-big-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: big, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  const body = (tag: string) => Array.from({ length: 400 }, (_, i) => `export const v${i} = '${tag}${'x'.repeat(70)}';`).join('\n') + '\n';
  for (const n of [1, 2, 3]) writeFileSync(join(big, `f${n}.ts`), body('a'));
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  const from = g('rev-parse', 'HEAD');
  for (const n of [1, 2, 3]) writeFileSync(join(big, `f${n}.ts`), body('b'));
  g('commit', '-q', '-am', 'change');
  const to = g('rev-parse', 'HEAD');
  try {
    const without = buildPack(big, from, to, 'definitions');
    const withEarlier = buildPack(big, from, to, 'definitions', [], '', undefined, 'E'.repeat(16_000));
    assert.deepEqual(withEarlier.skipped, without.skipped);
    assert.equal(withEarlier.body, without.body);
    assert.ok(withEarlier.pack.includes('E'.repeat(16_000)));
  } finally {
    rmSync(big, { recursive: true, force: true });
  }
});

// KNT-196. The labels of the pack never reach a reader.

test('a label of an open earlier finding is written as its public id and title; a sentence on a finding that is not open goes', () => {
  const open = finding(BILLING, 386, 'The start date comes from a new schedule');
  const settled = finding(ACCOUNT, 237, 'The message is not translated');
  const held = earlierFindingsSection(repo, pushed, [earlier(open, 'open'), earlier(settled, 'dismissed', 'Translated by the layout')]).held;
  const reply: Answer = {
    ...answer(4, [finding(BILLING, 394, 'Refused change leaves the row', 'major', { scenario: 'As in E1, the start is wrong. Stripe refuses the change.' })]),
    summary: 'The fix handles the refusal. The open earlier finding E1 still stands. E2 still stands too. Tests cover it, e.g. the 409 path.',
    risk: 'E2 is not rechecked.',
    not_reviewed: [`${ACCOUNT}: not in the changed zone, so E2 was not rechecked`, 'docs/a.md: generated'],
  };
  assert.ok(publicLabels(reply, held) > 0);
  const id = (f: Finding) => `#${findingKey(f).slice(0, 6)}`;
  assert.equal(reply.summary, `The fix handles the refusal. The open earlier finding ${id(open)} ("The start date comes from a new schedule") still stands. Tests cover it, e.g. the 409 path.`);
  assert.equal(reply.risk, '');
  assert.deepEqual(reply.not_reviewed, ['docs/a.md: generated']);
  assert.equal(reply.findings[0]!.scenario, `As in ${id(open)} ("The start date comes from a new schedule"), the start is wrong. Stripe refuses the change.`);
  assert.doesNotMatch(JSON.stringify(reply), /\bE[12]\b/);
});

test('a label that the pack did not hold goes with its sentence; a code such as E11000 or E2E stays', () => {
  const held = earlierFindingsSection(repo, pushed, [earlier(finding(BILLING, 386, 'The start date comes from a new schedule'), 'open')]).held;
  assert.equal(withPublicLabels('The earlier finding E7 still stands. Mongo answers E11000 on a duplicate, and the E2E tests pass.', held), 'Mongo answers E11000 on a duplicate, and the E2E tests pass.');
  // Kentō on #55 (#1bf345): an error code next to the word « finding » is no label.
  assert.equal(withPublicLabels('Error code E42 is a finding of the new review.', held), 'Error code E42 is a finding of the new review.');
});

test('a title keeps its sentence, without the stale label (Kentō on #55)', () => {
  const settled = finding(ACCOUNT, 237, 'The message is not translated');
  const held = earlierFindingsSection(repo, pushed, [earlier(settled, 'dismissed', 'Translated by the layout')]).held;
  const reply: Answer = answer(4, [finding(BILLING, 394, 'E1 comes back on the refusal', 'major')]);
  publicLabels(reply, held);
  assert.equal(reply.findings[0]!.title, 'an earlier finding comes back on the refusal');
});

test('a sentence that cites an open finding and a stale one keeps its note on the open one (Kentō on #55)', () => {
  const open = finding(BILLING, 386, 'The start date comes from a new schedule');
  const settled = finding(ACCOUNT, 237, 'The message is not translated');
  const held = earlierFindingsSection(repo, pushed, [earlier(open, 'open'), earlier(settled, 'fixed')]).held;
  assert.equal(withPublicLabels('E1 still stands, unlike E2.', held), `#${findingKey(open).slice(0, 6)} ("The start date comes from a new schedule") still stands, unlike an earlier finding.`);
});

test('the review publishes no label of the pack: a « still stands » on a dismissed finding is gone', async () => {
  const settled = finding(ACCOUNT, 237, 'The message is not translated');
  const model = fakeModel(() => ({ ...answer(4, []), summary: 'The change is small. The open earlier finding E1 still stands.', not_reviewed: [`${ACCOUNT}: not in the changed zone, so E1 was not rechecked`] }));
  const result = await reviewPullRequest(input(model.fetch, { earlier: { findings: [earlier(settled, 'dismissed', 'Translated by the layout')], last: null } }));
  // The fixture is a critical change (KNT-154), whose lines of checks follow the summary.
  assert.match(result.answer.summary, /^The change is small\.( |$)/);
  assert.doesNotMatch(result.answer.summary, /\bE1\b|still stands/);
  assert.deepEqual(result.answer.not_reviewed, []);
});
