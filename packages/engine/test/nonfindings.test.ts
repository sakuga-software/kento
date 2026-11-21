import assert from 'node:assert/strict';
import { test } from 'node:test';
import { score, verdict, type Answer, type Finding } from '../src/findings.ts';
import { askModel } from '../src/model.ts';
import { levelConfig } from '../src/levels.ts';
import { asksToConfirm, MAX_QUESTIONS, saysNoChange, splitNonFindings } from '../src/nonfindings.ts';
import { descriptionBlock } from '../src/render.ts';

// KNT-153. A finding that names no defect: its fix says no change, or it asks the author to confirm.

const finding = (fix: string, extra: Partial<Finding> = {}): Finding => ({
  path: 'app/routes/items.ts',
  start_line: 4,
  line: 4,
  severity: 'minor',
  category: 'bug',
  confidence: 80,
  title: 'Items sorted by name',
  scenario: 'The list shows the items by name.',
  fix,
  suggestion: '',
  ...extra,
});

test('a fix that says that no change is needed', () => {
  for (const fix of [
    'None.',
    'None needed.',
    'No change.',
    'No change needed.',
    'No change is required.',
    'No code change is necessary: the guard of the caller covers it.',
    'Nothing needs to change.',
    'No fix needed',
    'No action required.',
    'Leave as is.',
    'Keep it as is.',
    'Cosmetic, leave it as is.',
    'Accept the behaviour.',
    'Accept this trade-off.',
  ]) {
    assert.equal(saysNoChange(finding(fix)), true, fix);
  }
});

test('a fix that asks for a change stays a fix', () => {
  for (const fix of [
    'Accept a null id and return 404.',
    'Leave the cache as is and add a check before the write.',
    'No change is needed in `list`. Add the check in `remove`.',
    'Return the error instead of `null`.',
    'Keep the old column for one release, then drop it.',
    '',
  ]) {
    assert.equal(saysNoChange(finding(fix)), false, fix);
  }
});

test('a finding that asks the author to confirm', () => {
  assert.equal(asksToConfirm(finding('Please confirm that every other caller of the route still gets a 200.')), true);
  assert.equal(asksToConfirm(finding('Confirm that the product wants a sort by name.')), true);
  assert.equal(asksToConfirm(finding('Verify that `list` is the only caller.')), true);
  assert.equal(asksToConfirm(finding('Sort by date.', { title: 'Is this sort intended?' })), true);
  assert.equal(asksToConfirm(finding('Check the id before the delete.')), false, 'a fix that names the change');
  assert.equal(asksToConfirm(finding('Add a test that confirms the order.')), false);
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

test('the answer drops the findings that say no change, and moves the requests to confirm to the questions', () => {
  const real = finding('Return 404 for a missing id.', { title: 'A missing id gives 500', severity: 'major' });
  const none = finding('No change needed.', { severity: 'major' });
  const ask = finding('Please confirm that every other caller still behaves.', { title: 'Other callers of the route' });
  const hole = finding('Accept the risk.', { severity: 'critical', title: 'Any member can delete the org' });
  const given = { path: 'app/routes/items.ts', question: 'Does the product want the sort by name?' };
  const { answer: kept, dropped, asked } = splitNonFindings(answer([real, none, ask, hole], { questions: [given] }));
  assert.deepEqual(kept.findings, [real, hole], 'a critical finding stays, whatever its fix');
  assert.deepEqual(dropped, [none]);
  assert.deepEqual(asked, [ask]);
  assert.deepEqual(kept.questions, [given, { path: 'app/routes/items.ts', question: 'Please confirm that every other caller still behaves.' }]);
  const many = splitNonFindings(answer([], { questions: Array.from({ length: 9 }, (_, i) => ({ path: '', question: `Q${i}?` })) }));
  assert.equal(many.answer.questions?.length, MAX_QUESTIONS);
});

test('askModel gives no finding for a fix of "No change needed", and logs it', async () => {
  const reply = answer([finding('No change needed.', { severity: 'major' })]);
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  }) as typeof globalThis.fetch;
  const logs: string[] = [];
  const { answer: got } = await askModel({ apiKey: 'k', fetch, log: (m) => logs.push(m) }, { ...levelConfig('lite'), models: ['test/model'] }, 'pack');
  assert.deepEqual(got.findings, []);
  assert.match(logs.join('\n'), /finding dropped, its fix says that no change is needed: app\/routes\/items\.ts: Items sorted by name/);
});

test('a question renders in the Questions block, opens no finding and keeps the score', () => {
  const lines = new Map<string, Set<number>>([['app/routes/items.ts', new Set([4])]]);
  const withQuestion = answer([], { questions: [{ path: 'app/routes/items.ts', question: 'Does every other caller of `/api/items` still get a 200?' }] });
  assert.equal(score(withQuestion, lines), 4);
  assert.equal(verdict(withQuestion, lines, 'balanced'), 'APPROVE');
  const context = { count: 1, head: 'a'.repeat(40), subject: 'feat: items', commitUrl: 'https://github.com/acme/app/commit/aaa', level: 'balanced' as const };
  const block = descriptionBlock(withQuestion, [], [], 0, { model: 'm' }, lines, context);
  assert.match(block, /<h3>Questions<\/h3>/);
  assert.match(block, /1\. `app\/routes\/items\.ts` Does every other caller of `\/api\/items` still get a 200\?/);
  assert.doesNotMatch(block, /<h3>Findings<\/h3>/);
  assert.doesNotMatch(descriptionBlock(answer([]), [], [], 0, { model: 'm' }, lines, context), /Questions/);
});
