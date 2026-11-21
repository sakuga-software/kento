import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { earlierFindingsSection, isNewDefect, linkEarlier, MAX_EARLIER_BYTES, type HeldEarlier } from '../src/earlier.ts';
import { findingKey, isBlocking, reversesAFix, score, verdict, type Answer, type Finding } from '../src/findings.ts';
import { levelConfig } from '../src/levels.ts';
import { linkFindings, linkMessage } from '../src/link.ts';
import { descriptionBlock, inlineBody } from '../src/render.ts';
import { mergeDelta } from '../src/delta.ts';

// KNT-167. A review asked for a fix, then for its opposite: the author could follow neither. A
// finding that undoes the fix of an earlier finding says so, and does not block alone.

const finding = (title: string, extra: Partial<Finding> = {}): Finding => ({
  path: 'app/auth/sign-in.ts',
  start_line: 30,
  line: 30,
  severity: 'major',
  category: 'bug',
  confidence: 90,
  title,
  scenario: 'The scenario.',
  fix: 'The fix.',
  suggestion: '',
  ...extra,
});

const earlierFinding = finding('The old session goes before the new one is stored');
const held = (status: HeldEarlier['status']): HeldEarlier => ({
  key: findingKey(earlierFinding),
  path: earlierFinding.path,
  line: 30,
  title: earlierFinding.title,
  severity: 'major',
  category: 'bug',
  status,
  reason: null,
  commit: 'a'.repeat(40),
  ref: 'E1',
  changed: true,
});

const lines = new Map<string, Set<number>>([['app/auth/sign-in.ts', new Set([30])]]);

test('a finding that undoes a fix does not block alone; a critical one does', () => {
  const reversing = finding('Delete the old session only after a success', { reverses: findingKey(earlierFinding) });
  assert.equal(reversesAFix(reversing), true);
  assert.equal(isBlocking(reversing, lines), false);
  assert.equal(isBlocking({ ...reversing, severity: 'critical' }, lines), true);
  assert.equal(isBlocking(finding('Delete the old session only after a success'), lines), true, 'with no reversal it blocks');
  const answer: Answer = { confidence_score: 4, risk: 'r', summary: 's', diagram: '', findings: [reversing], not_reviewed: [], deeper_review: { recommended: false, reason: '' } };
  assert.equal(score(answer, lines), 4);
  assert.equal(verdict(answer, lines, 'balanced'), 'APPROVE');
});

test('a reversal does not lower the score alone: it is no new defect', () => {
  const reversing = finding('Delete the old session only after a success', { reverses: findingKey(earlierFinding) });
  assert.equal(isNewDefect(reversing, [held('fixed')]), false);
  assert.equal(isNewDefect({ ...reversing, severity: 'critical' }, [held('fixed')]), true);
});

test('the net keeps `reverses` only for a fixed earlier finding, as its key', () => {
  const answer = (f: Finding): Answer & { findings: Finding[] } => ({ confidence_score: 4, risk: '', summary: '', diagram: '', findings: [f], not_reviewed: [], deeper_review: { recommended: false, reason: '' } });
  const fixedAnswer = answer(finding('Delete the old session only after a success', { reverses: 'E1' }));
  linkEarlier(fixedAnswer, [held('fixed')], () => 30);
  assert.equal(fixedAnswer.findings[0]!.reverses, findingKey(earlierFinding));
  const openAnswer = answer(finding('Delete the old session only after a success', { reverses: 'E1' }));
  linkEarlier(openAnswer, [held('open')], () => 30);
  assert.equal(openAnswer.findings[0]!.reverses, undefined, 'an open finding has no fix to undo');
  // The net links a finding to the same earlier finding that it reverses: it repeats that defect,
  // and is no reversal (Kentō #66919e).
  const both = answer(finding(earlierFinding.title, { reverses: 'E1' }));
  linkEarlier(both, [held('fixed')], () => 30);
  assert.equal(both.findings[0]!.follows, findingKey(earlierFinding));
  assert.equal(both.findings[0]!.reverses, undefined);
  // A reversal with other words for the same place is not that defect again: the net does not link
  // it to the finding that it reverses, and it keeps its reversal.
  const reworded = answer(finding('The old session stays until the new one is stored', { reverses: 'E1' }));
  linkEarlier(reworded, [held('fixed')], () => 30);
  assert.equal(reworded.findings[0]!.follows, undefined);
  assert.equal(reworded.findings[0]!.reverses, findingKey(earlierFinding));
  // The critique of #62: a reversal holds only on the file of the earlier finding, and only when
  // the finding is no more severe. A worse defect that the fix opened blocks.
  const elsewhere = answer(finding('Delete the old session only after a success', { reverses: 'E1', path: 'app/auth/other.ts' }));
  linkEarlier(elsewhere, [held('fixed')], () => 30);
  assert.equal(elsewhere.findings[0]!.reverses, undefined, 'another file');
  const minorEarlier = { ...held('fixed'), severity: 'minor' as const };
  const worse = answer(finding('The sign-in answers 500 with no body', { reverses: 'E1' }));
  linkEarlier(worse, [minorEarlier], () => 30);
  assert.equal(worse.findings[0]!.reverses, undefined, 'a major reversal of a minor finding');
  assert.equal(isBlocking(worse.findings[0]!, lines), true);
  // A finding that follows a reversing earlier finding keeps the reversal.
  const reversingEarlier: HeldEarlier = { ...held('open'), key: 'c'.repeat(12), ref: 'E2', title: 'Delete the old session only after a success', reverses: findingKey(earlierFinding) };
  const again = answer(finding('Delete the old session only after a success', { follows: 'E2' }));
  linkEarlier(again, [held('fixed'), reversingEarlier], () => 30);
  assert.equal(again.findings[0]!.follows, 'c'.repeat(12));
  assert.equal(again.findings[0]!.reverses, findingKey(earlierFinding));
  assert.equal(isBlocking(again.findings[0]!, lines), false);
  const stray = answer(finding('x', { reverses: 'E9' }));
  linkEarlier(stray, [held('fixed')], () => 30);
  assert.equal(stray.findings[0]!.reverses, undefined);
});

test('the link call gives `reverses` for a fixed earlier finding only, and sends the status', async () => {
  const bodies: any[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const links = [
      { finding: 0, rule_id: null, follows: null, reverses: 'E1' },
      { finding: 1, rule_id: null, follows: null, reverses: 'E2' },
    ];
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify({ links }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  }) as typeof globalThis.fetch;
  const open = { ...held('open'), ref: 'E2', key: 'b'.repeat(12) };
  const { findings, report } = await linkFindings({ apiKey: 'k', fetch, log: () => {} }, levelConfig('lite'), [finding('A'), finding('B')], [], [held('fixed'), open]);
  assert.equal(report.status, 'done');
  assert.equal(findings[0]!.reverses, 'E1');
  assert.equal(findings[1]!.reverses, undefined, 'E2 is open');
  assert.match(linkMessage([finding('A')], [], [held('fixed')]), /"status": "fixed"/);
  assert.equal(report.reverses, 1, 'the report counts the reversals');
  assert.ok(bodies[0].response_format.json_schema.schema.properties.links.items.required.includes('reverses'));
});

test('Kentō says that it changes its mind, in the thread and in the block', () => {
  const reversing = finding('Delete the old session only after a success', { reverses: findingKey(earlierFinding) });
  const short = findingKey(earlierFinding).slice(0, 6);
  assert.match(inlineBody(reversing, false), new RegExp(`Kentō changes its mind: this finding asks to undo the fix of \`#${short}\`, an earlier finding of this PR\\. The scenario says why that finding was wrong\\. It does not block the PR alone\\.`));
  assert.doesNotMatch(inlineBody({ ...reversing, severity: 'critical' }, false), /does not block/);
  assert.doesNotMatch(inlineBody(finding('x'), false), /changes its mind/);
  const answer: Answer = { confidence_score: 4, risk: 'r', summary: 's', diagram: '', findings: [reversing], not_reviewed: [], deeper_review: { recommended: false, reason: '' } };
  const block = descriptionBlock(answer, [{ finding: reversing, url: null }], [], 0, { model: 'm' }, lines, { count: 2, head: 'a'.repeat(40), subject: 's', commitUrl: 'https://github.com/acme/app/commit/a', level: 'balanced' });
  assert.match(block, new RegExp(`Kentō changes its mind: this finding asks to undo the fix of \`#${short}\``));
});

test('the prompts ask to read a fix before reporting its opposite, and to say why', () => {
  const review = readFileSync(join(import.meta.dirname, '..', 'prompts', 'review.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(review, /Before you report a change that undoes the fix of a `fixed` earlier finding \(the opposite change at the same place\), read the code at the head near its line\. Report it only when the fix is wrong\./);
  // The reader of the comment never sees `E1`: the scenario names the finding by its title.
  assert.match(review, /start the scenario with the title of that finding, in quotes, never its reference/);
  const link = readFileSync(join(import.meta.dirname, '..', 'prompts', 'link.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(link, /`reverses`: the reference of an earlier finding of status `fixed` whose fix this finding asks to undo/);
  const { key, path, line, title, severity, category, status, reason, commit } = held('fixed');
  const { section } = earlierFindingsSection(process.cwd(), 'HEAD', [{ key, path, line, title, severity, category, status, reason, commit }]);
  assert.match(section.replace(/\s+/g, ' '), /Before you report a change that undoes the fix of a `fixed` finding of this list \(the opposite change at the same place\), read the code at the head near its line\./);
  // Only with a fixed finding in the list, and its room is kept before the rows.
  const open = earlierFindingsSection(process.cwd(), 'HEAD', [{ key, path, line, title, severity, category, status: 'open', reason, commit }]).section;
  assert.doesNotMatch(open, /undoes the fix of a `fixed` finding of this list/);
  const many = Array.from({ length: 100 }, (_, i) => ({ key: `${i}`.padStart(12, '0'), path, line, title: `${'A long title of a fixed finding, '.repeat(6)}${i}`, severity, category, status: 'fixed' as const, reason, commit }));
  const full = earlierFindingsSection(process.cwd(), 'HEAD', many).section;
  assert.match(full, /undoes the fix of a `fixed` finding of this list/);
  const body = full.slice(full.indexOf('- E1 '));
  assert.ok(body.length <= MAX_EARLIER_BYTES + 2, `${body.length} bytes`);
  assert.match(section.replace(/\s+/g, ' '), /start the scenario with the title of that finding, in quotes, never its reference/);
});

test('the review call cannot set `reverses` itself: only the link call gives it', async () => {
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify({ links: [{ finding: 0, rule_id: null, follows: null, reverses: null }] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  }) as typeof globalThis.fetch;
  const given = finding('A', { reverses: 'E1' });
  const { findings } = await linkFindings({ apiKey: 'k', fetch, log: () => {} }, levelConfig('lite'), [given], [], [held('fixed')]);
  assert.equal(findings[0]!.reverses, undefined);
});

test('an incremental review carries a reversal that the service sends back: it stays non-blocking', () => {
  // The finding of the last review, as the service sends it back in `delta.findings` (store.ts sendableFinding).
  const stored = { ...finding('Delete the old session only after a success'), anchor: 30, blocking: false, suggestion_range: null, reverses: findingKey(earlierFinding) };
  const empty: Answer = { confidence_score: 4, risk: '', summary: '', diagram: '', findings: [], not_reviewed: [], deeper_review: { recommended: false, reason: '' } };
  const delta = { since: 'b'.repeat(40), score: 4, findings: [stored], settled: [] };
  const plan = { since: delta.since, files: ['README.md'], pullFiles: ['README.md', 'app/auth/sign-in.ts'] };
  const merged = mergeDelta(empty, delta, plan, () => ['x']);
  assert.equal(merged.answer.findings[0]!.reverses, findingKey(earlierFinding));
  assert.equal(verdict(merged.answer, lines, 'balanced'), 'APPROVE');
  // Without it (a service of the release before), the same finding blocks again: the reason the service sends it.
  const { reverses: _lost, ...plain } = stored;
  assert.equal(verdict(mergeDelta(empty, { ...delta, findings: [plain] }, plan, () => ['x']).answer, lines, 'balanced'), 'REQUEST_CHANGES');
});
