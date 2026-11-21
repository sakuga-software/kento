import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { earlierFindingsSection, isNewDefect, linkEarlier, type HeldEarlier } from '../src/earlier.ts';
import { findingKey, isBlocking, reversesAFix, score, verdict, type Answer, type Finding } from '../src/findings.ts';
import { levelConfig } from '../src/levels.ts';
import { linkFindings, linkMessage } from '../src/link.ts';
import { descriptionBlock, inlineBody } from '../src/render.ts';

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
  const fixedAnswer = answer(finding('Delete the old session only after a success', { reverses: 'E1', path: 'app/auth/other.ts' }));
  linkEarlier(fixedAnswer, [held('fixed')], () => 30);
  assert.equal(fixedAnswer.findings[0]!.reverses, findingKey(earlierFinding));
  const openAnswer = answer(finding('Delete the old session only after a success', { reverses: 'E1', path: 'app/auth/other.ts' }));
  linkEarlier(openAnswer, [held('open')], () => 30);
  assert.equal(openAnswer.findings[0]!.reverses, undefined, 'an open finding has no fix to undo');
  const stray = answer(finding('x', { reverses: 'E9', path: 'app/auth/other.ts' }));
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
  assert.match(review, /Before you report a change that undoes the fix of a `fixed` earlier finding \(the opposite change at the same place\), read that fix in the diff\. Report it only when the fix is wrong\./);
  const link = readFileSync(join(import.meta.dirname, '..', 'prompts', 'link.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(link, /`reverses`: the reference of an earlier finding of status `fixed` whose fix this finding asks to undo/);
  const { key, path, line, title, severity, category, status, reason, commit } = held('fixed');
  const { section } = earlierFindingsSection(process.cwd(), 'HEAD', [{ key, path, line, title, severity, category, status, reason, commit }]);
  assert.match(section.replace(/\s+/g, ' '), /Before you report a change that undoes one of these fixes \(the opposite change at the same place\), read that fix in the diff\./);
});
