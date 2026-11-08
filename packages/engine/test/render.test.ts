import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { descriptionBlock, findingKey, inlineBody, reviewBody, type Answer, type Finding, type Usage } from '../src/index.ts';
import { shortId } from '../src/render.ts';
import { LEVEL_COST_CENTS, levelCost } from '../src/levels.ts';

const finding: Finding = {
  path: 'src/auth.ts',
  start_line: 12,
  line: 12,
  severity: 'major',
  category: 'security',
  confidence: 90,
  title: 'Le jeton expiré passe',
  scenario: 'Un jeton expiré depuis une heure ouvre la session.',
  fix: 'Comparer exp à Date.now().',
  suggestion: '',
};
const answer = {
  confidence_score: 2,
  summary: 'La PR change la vérification du jeton.',
  risk: 'Un jeton expiré passe.',
  findings: [finding],
  not_reviewed: [],
  diagram: '',
  deeper_review: { recommended: true, reason: 'le changement touche la vérification des jetons.' },
} as unknown as Answer;
const anchors = () => 12;
const usage: Usage = { model: 'anthropic/claude-haiku-5.5', cost: 0.0112, cost_source: 'table' };
const kento = { by: 'Kentō', handle: '@kento-review' };

test('the body of a review by Kentō names its command and the cost of each level', () => {
  assert.equal(
    reviewBody(answer, anchors, 'lite', usage, kento),
    [
      '<!-- sakuga-review:summary -->',
      '**Score de confiance : 2/5** · ⛔ 1 point bloquant · Un jeton expiré passe.',
      '',
      '**Une review plus poussée est conseillée :** le changement touche la vérification des jetons.',
      'Commentez `@kento-review balanced` (de 10 à 20 centimes) ou `@kento-review heavy` (de 30 à 50 centimes).',
      '',
      '<sub>Kentō · Niveau `lite` · `anthropic/claude-haiku-5.5` · 0,011 $ · Le résumé, le diagramme et la liste des constats sont à la fin de la description de la PR.</sub>',
    ].join('\n'),
  );
});

test('the body of a review by the Action keeps the command of the Action', () => {
  const body = reviewBody(answer, anchors, 'lite', usage);
  assert.match(body, /^Commentez `@sakuga-review review balanced` \(de 10 à 20 centimes\) ou `@sakuga-review review heavy` \(de 30 à 50 centimes\)\.$/m);
  assert.match(body, /^<sub>Niveau `lite`/m);
});

test('the block of the description by Kentō carries its name, and the markers that the next review reads', () => {
  const context = { count: 2, head: '1'.repeat(40), subject: 'fix(auth): check the expiry', commitUrl: `https://github.com/o/n/commit/${'1'.repeat(40)}`, level: 'lite' as const };
  const block = descriptionBlock(answer, [{ finding, url: 'https://github.com/o/n/pull/1#discussion_r1' }], [], 1, usage, anchors, { ...context, poster: kento });
  assert.match(block, /^<!-- sakuga-review:start -->\n/);
  assert.match(block, /^<h2>Kentō · Score de confiance : 2\/5<\/h2>$/m);
  assert.match(block, /^Commentez `@kento-review balanced` \(de 10 à 20 centimes\) ou `@kento-review heavy` \(de 30 à 50 centimes\)\.$/m);
  assert.match(block, /^1 constat d'une review précédente n'apparait plus : le fil peut être résolu\.$/m);
  assert.match(block, /^<sub>Reviews \(2\) · Dernier commit relu : \[fix\(auth\): check the expiry\]\(https:\/\/github\.com\/o\/n\/commit\/1{40}\) · Kentō · Niveau `lite`/m);
  assert.match(block, /<!-- sakuga-review:count 2 -->\n<!-- sakuga-review:end -->$/);
  assert.doesNotMatch(block, /Sakuga Review|revue|🔍/);
  assert.match(descriptionBlock(answer, [], [], 0, usage, anchors, context), /^<h2>Sakuga Review · Score de confiance : 2\/5<\/h2>$/m);
});

test('a finding shows its short id in its comment and in the list of the description (REV-93)', () => {
  const id = `#${findingKey(finding).slice(0, 6)}`;
  assert.equal(shortId(finding), id);
  assert.match(id, /^#[0-9a-f]{6}$/);
  const body = inlineBody(finding, false);
  assert.equal(body.split('\n')[0]!.endsWith(`**Le jeton expiré passe** \`${id}\``), true);
  // The hidden key stays whole: the next review reads it back.
  assert.match(body, new RegExp(`<!-- sakuga-review:finding ${findingKey(finding)} -->`));
  const context = { count: 1, head: '1'.repeat(40), subject: 's', commitUrl: `https://github.com/o/n/commit/${'1'.repeat(40)}`, level: 'lite' as const };
  const withThread = descriptionBlock(answer, [{ finding, url: 'https://github.com/o/n/pull/1#discussion_r1' }], [], 0, usage, anchors, context);
  assert.match(withThread, new RegExp(`^1\\. .*\\*\\*Le jeton expiré passe\\*\\* \`${id}\` \`src/auth\\.ts:12\``, 'm'));
  const withoutThread = descriptionBlock(answer, [{ finding, url: null }], [], 0, usage, () => null, context);
  assert.match(withoutThread, new RegExp(`^1\\. .*\`${id}\``, 'm'));
});

test('the cost of a level reads as a range of cents', () => {
  assert.equal(levelCost('lite'), 'environ 1 centime');
  assert.equal(levelCost('balanced'), 'de 10 à 20 centimes');
  assert.equal(levelCost('heavy'), 'de 30 à 50 centimes');
});

test('the prompt gives the model the same ratio of cost as LEVEL_COST_CENTS', () => {
  const prompt = readFileSync(join(import.meta.dirname, '..', 'prompts', 'review.md'), 'utf8');
  const lite = LEVEL_COST_CENTS.lite[0];
  const low = LEVEL_COST_CENTS.balanced[0] / lite;
  const high = LEVEL_COST_CENTS.heavy[1] / lite;
  assert.match(prompt.replace(/\s+/g, ' '), new RegExp(`for ${low} to ${high} times the cost of this review`));
});
