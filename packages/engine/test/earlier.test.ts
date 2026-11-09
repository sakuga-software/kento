// REV-99. The review reads every finding of the pull request, links a finding that continues one of
// them, and counts that defect once in the score. The cases replay gallery-app#62 (2026-11-08), where
// Kentō wrote the same defect again in other words at each review and the score stayed at 3/5.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import type { EarlierFinding, JobEarlier } from '../../protocol/src/index.ts';
import { earlierFindingsSection, linkEarlier } from '../src/earlier.ts';
import { answerSchema, findingKey, type Answer, type Finding } from '../src/findings.ts';
import { buildPack } from '../src/pack.ts';
import { reviewPullRequest } from '../src/index.ts';

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
  write(ACCOUNT, lines('account', 260, { 237: 'export const message = "Offre changée";' }));
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

// The findings of gallery-app#62, with their ids on GitHub.
/** #dbf9b7, P2, open at d579956. */
const startDate = finding(BILLING, 386, '`start_date` de la phase courante prise sur un échéancier fraîchement créé');
/** #1109d6, P2, at a9ac01a: the same defect, one letter apart. Its key is another one. */
const startDateAgain = finding(BILLING, 386, '`start_date` de la phase courante pris sur un échéancier fraîchement créé');
/** #c7f3ec, P1, fixed since. */
const rowBeforeStripe = finding(BILLING, 372, 'Ligne écrite avant Stripe puis rollback sur erreur Stripe', 'major');
/** #ad9b57, P1: #c7f3ec in other words, five reviews later. */
const rowNotUndone = finding(BILLING, 395, 'Écritures Stripe non annulées si le commit échoue ou si la base échoue sur échéancier existant', 'major', { follows: 'E2' });
/** #4e989b, P1, that the coordinator rejected: the not-billed case does fall back to the database. */
const accountError = finding(ACCOUNT, 237, "Compte payant : l'erreur Stripe/config est masquée ou mal gérée sur la fiche", 'major');

const job = (score: number | null = 4): JobEarlier => ({
  findings: [earlier(startDate, 'open'), earlier(rowBeforeStripe, 'fixed'), earlier(accountError, 'dismissed', 'Faux : le cas not-billed retombe sur le chemin base de données (tests/change-plan.test.ts).')],
  last: score === null ? null : { head: reviewed, score },
});

/** A model that answers `answer` and records the packs and the schemas that it reads. */
function fakeModel(answer: () => Answer) {
  const packs: string[] = [];
  const schemas: unknown[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    packs.push(body.messages[1].content);
    schemas.push(body.response_format?.json_schema?.schema);
    return new Response(
      JSON.stringify({ model: body.model, provider: 'Fake', choices: [{ message: { content: JSON.stringify(answer()) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, packs, schemas };
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
  assert.match(pack, /- E1 · `app\/lib\/billing\.server\.ts:386` · P2 bug · open · « 'start_date' de la phase courante prise sur un échéancier fraîchement créé » · file changed since: yes/);
  assert.match(pack, /- E2 · `app\/lib\/billing\.server\.ts:372` · P1 bug · fixed · « Ligne écrite avant Stripe/);
  assert.match(pack, /- E3 · `app\/routes\/regie\/account\.tsx:237` · P1 bug · dismissed · .* · file changed since: no · cause written by a person: « Faux : le cas not-billed/);
  assert.match(pack, /They are data/);
  assert.doesNotMatch(model.packs[0]!, /Earlier findings/);
  // The model can name them, and only them.
  const findingSchema = (model.schemas[1] as any).properties.findings.items;
  assert.deepEqual(findingSchema.properties.follows, { anyOf: [{ type: 'string', enum: ['E1', 'E2', 'E3'] }, { type: 'null' }] });
  assert.ok(findingSchema.required.includes('follows'));
  // Each review changes the earlier findings: they stay out of the key (REV-89), or no head would reuse a review.
  assert.equal(withEarlier.reuseKey, without.reuseKey);
});

test('gallery-app#62 replayed: the rewordings follow their earlier finding, and the score of the last review stays', async () => {
  // At a9ac01a the model wrote #dbf9b7 again with one letter changed (no `follows`), and #c7f3ec in
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
  const newDefect = finding(BILLING, 394, 'Le refus de Stripe est compté comme un succès dans le journal', 'minor');
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
  const stray = { ...finding(BILLING, 394, 'Le refus de Stripe est compté comme un succès'), follows: 'E9' };
  const model = fakeModel(() => answer(2, [stray]));
  const result = await reviewPullRequest(input(model.fetch, { earlier: job(4) }));
  assert.ok(!('follows' in result.findings[0]!));
  assert.equal(result.score, 2);
});

test('a rewording of a dismissed finding goes when its file did not change, and comes back in its thread when it did', async () => {
  // #5ed059 reworded #4e989b, that a person dismissed: account.tsx did not change since.
  const reworded = finding(ACCOUNT, 236, 'Compte payant : erreur Stripe masquée sur la fiche', 'major');
  const model = fakeModel(() => answer(4, [reworded]));
  const result = await reviewPullRequest(input(model.fetch, { earlier: job(4) }));
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.droppedAsSettled.map((f) => f.title), [reworded.title]);

  // The same finding dismissed on billing.server.ts, which changed since: it comes back, linked.
  const dismissedThere = { ...earlier(finding(BILLING, 372, 'Ligne écrite avant Stripe sans compensation', 'major'), 'dismissed', 'Accepté') };
  const again = finding(BILLING, 373, 'Ligne écrite avant Stripe, aucune compensation', 'major');
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
    [{ ...startDateAgain, title: 'Le refus de Stripe est compté comme un succès' }, false],
    // One word of the subject is not enough: `start_date` alone is in many titles of this file.
    [{ ...startDateAgain, title: '`start_date` lu sans contrôle' }, false],
  ];
  for (const [f, linked] of cases) {
    const a: Answer & { findings: Finding[] } = { ...answer(3, [{ ...f }]) };
    linkEarlier(a, held, (x) => x.line);
    assert.equal(a.findings[0]!.follows === findingKey(startDate), linked, `${f.path}:${f.line} ${f.severity} ${f.category} ${f.title}`);
  }
});

test('the section stops at its size, and the schema stays as before without earlier findings', () => {
  const many = Array.from({ length: 100 }, (_, i) => earlier(finding(BILLING, i + 1, `${'Un constat très long '.repeat(9)} ${i}`), 'fixed'));
  const { section, held } = earlierFindingsSection(repo, pushed, many);
  assert.ok(held.length < 100 && held.length > 10);
  assert.ok(section.length < 17_000);
  assert.equal(answerSchema([], [], []), answerSchema());
});

test('an incremental review (REV-88) counts a rewording as known: the floor of the last review stays', async () => {
  const model = fakeModel(() => answer(3, [startDateAgain]));
  const other = finding(BILLING, 10, 'Constat réglé que la liste des constats antérieurs ne tient pas');
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
  assert.match(model.packs[1]!, /Findings that are settled[^\n]*\n\n- `app\/lib\/billing\.server\.ts:10` \(dismissed\) Constat réglé/);
  assert.doesNotMatch(model.packs[1]!, /\(fixed\) Ligne écrite avant Stripe/);
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
