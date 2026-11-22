import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Answer, Finding } from '../src/findings.ts';
import { dropRejected, rejectedSection, rejectionArea } from '../src/rejected.ts';
import type { RejectedFinding } from '../../protocol/src/index.ts';

// KNT-197. A finding that a person rejected came back under another id: on kento#50, 26 lines from
// the rejected one, with 3 words of its title in common, after a push that changed its file
// elsewhere. The rejection now covers the area of the file, and a push away from it brings no new
// fact. A push near it does: the finding stays, and cites the rejection.

const PATH = 'src/fallback.ts';
let repo = '';
/** The commit of the rejection: the line 20 holds the rejected defect. */
let rejectedAt = '';
/** A push that changes the line 55 only: far from the rejection. */
let far = '';
/** A push that adds 3 lines at the top, and changes the line 22: near the rejection. */
let near = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const LINES = Array.from({ length: 60 }, (_, i) => `const line${i + 1} = ${i + 1};`);

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-rejected-area-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, PATH), LINES.join('\n') + '\n');
  git('add', '.');
  git('commit', '-q', '-m', 'feat: the fallback');
  rejectedAt = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, PATH), LINES.map((l, i) => (i === 54 ? 'const line55 = 550;' : l)).join('\n') + '\n');
  git('commit', '-q', '-am', 'fix: line 55');
  far = git('rev-parse', 'HEAD');
  const shifted = ['// a', '// b', '// c', ...LINES.map((l, i) => (i === 54 ? 'const line55 = 550;' : i === 21 ? 'const line22 = 220;' : l))];
  writeFileSync(join(repo, PATH), shifted.join('\n') + '\n');
  git('commit', '-q', '-am', 'fix: line 22, and a header');
  near = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { recursive: true, force: true }));

const REJECTED_TITLE = 'Fallback runs the whole review again after a partial first run';
const CAUSE = 'only the main model call can throw in a review';

const rejection = (over: Partial<RejectedFinding> = {}): RejectedFinding => ({
  path: PATH,
  line: 20,
  title: REJECTED_TITLE,
  category: 'bug',
  severity: 'major',
  status: 'dismissed',
  reason: CAUSE,
  commit: rejectedAt,
  ...over,
});

const finding = (line: number, title: string, over: Partial<Finding> = {}): Finding => ({
  path: PATH,
  start_line: line,
  line,
  severity: 'major',
  category: 'bug',
  confidence: 90,
  title,
  scenario: 'A usage limit runs the review again.',
  fix: 'Keep what the first run did.',
  suggestion: '',
  ...over,
});

const answer = (findings: Finding[]): Answer & { findings: Finding[] } => ({
  confidence_score: 4,
  risk: '',
  summary: '',
  diagram: '',
  findings,
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
});

/** The findings left after the rejections, read at `head`. */
function afterRejections(head: string, findings: Finding[], rejected: RejectedFinding[] = [rejection()]) {
  const { held } = rejectedSection(repo, head, rejected);
  const a = answer(findings);
  const dropped = dropRejected(a, held, (f) => f.line);
  return { kept: a.findings, dropped };
}

// The finding of kento#50 written again: 26 lines away, 3 words of the title in common.
const AGAIN = 'Fallback reruns the whole review, including already billed work';

test('the rejected defect written again 26 lines away, with words of its title in common, goes on an unchanged file', () => {
  const { kept, dropped } = afterRejections(rejectedAt, [finding(46, AGAIN)]);
  assert.deepEqual(kept, []);
  assert.deepEqual(dropped.map((d) => d.why), ['unchanged']);
});

test('a push that changed the file far from the rejection brings no new fact: the finding goes', () => {
  const { kept, dropped } = afterRejections(far, [finding(46, AGAIN)]);
  assert.deepEqual(kept, []);
  assert.deepEqual(dropped.map((d) => [d.finding.title, d.why]), [[AGAIN, 'elsewhere']]);
});

test('a push near the rejection can bring a new fact: the finding stays, and cites the rejection and what changed', () => {
  // The header moved the rejected line from 20 to 23 at the head.
  const { kept, dropped } = afterRejections(near, [finding(49, AGAIN)]);
  assert.deepEqual(dropped, []);
  assert.equal(kept.length, 1);
  assert.match(
    kept[0]!.scenario,
    /^A usage limit runs the review again\.\n\nKentō set this defect aside before\. A person marked "Fallback runs the whole review again after a partial first run" dismissed, with the cause "only the main model call can throw in a review"\. Since then, line 22 of this file changed near it \(a line of the file at the rejection\)\.$/,
  );
  // A second pass does not cite it twice.
  const again = afterRejections(near, kept).kept;
  assert.equal(again[0]!.scenario.match(/set this defect aside before/g)!.length, 1);
});

test('the line of a rejection moves with the lines that a push added above it', () => {
  assert.deepEqual(rejectionArea(repo, rejectedAt, near, PATH, 20), { lineAtHead: 23, changedNear: { from: 22, to: 22 } });
  assert.deepEqual(rejectionArea(repo, rejectedAt, far, PATH, 20), { lineAtHead: 20, changedNear: null });
  // A finding 3 lines from the moved line (6 from the old one), with one word in common, is the
  // rejected one: it cites the rejection.
  const { kept } = afterRejections(near, [finding(26, 'The fallback is not logged')]);
  assert.match(kept[0]!.scenario, /Kentō set this defect aside before\./);
});

test('the pack says whether the file changed near the rejection', () => {
  assert.match(rejectedSection(repo, near, [rejection()]).section, /- The file changed since the rejection: Yes, near its line \(line 22 before the change\)\./);
  assert.match(rejectedSection(repo, far, [rejection()]).section, /- The file changed since the rejection: Yes, not near its line\./);
});

test('another defect in the area stays: one word in common is not enough beyond 3 lines, and another category is another defect', () => {
  const oneWord = finding(46, 'The fallback provider has no timeout');
  const security = finding(46, AGAIN, { category: 'security' });
  const tooFar = finding(61, AGAIN);
  const { kept } = afterRejections(rejectedAt, [oneWord, security, tooFar]);
  assert.deepEqual(kept.map((f) => f.title), [oneWord.title, AGAIN, AGAIN]);
  assert.ok(kept.every((f) => !f.scenario.includes('set this defect aside')), 'a finding that is not the rejected one cites nothing');
});

test('a rejection whose commit is gone keeps the finding, and says that nobody can tell what changed', () => {
  const { kept } = afterRejections(far, [finding(20, REJECTED_TITLE)], [rejection({ commit: 'f'.repeat(40) })]);
  assert.equal(kept.length, 1);
  assert.match(kept[0]!.scenario, /Kentō set this defect aside before\..*The commit of that decision is gone from the history/s);
});
