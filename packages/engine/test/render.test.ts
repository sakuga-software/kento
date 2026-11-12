import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { descriptionBlock, findingKey, inlineBody, reviewBody, type Answer, type Finding, type Usage } from '../src/index.ts';
import type { Anchors } from '../src/findings.ts';
import { fileCommentBody, icon, shortId, toCheck, variantReplyBody, withBlock, type Icons } from '../src/render.ts';
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
const BASE = 'https://review.test/assets/pr/';
const images: Icons = { base: BASE };
const kento = { by: 'Kentō', handle: '@kento-review', icons: images };
const picture = (name: string, alt: string) =>
  `<picture><source media="(prefers-color-scheme: dark)" srcset="${BASE}${name}-dark.v1.svg"><img alt="${alt}" src="${BASE}${name}.v1.svg" height="20" align="top"></picture>`;

test('the body of a review by Kentō names its command and the cost of each level', () => {
  assert.equal(
    reviewBody(answer, anchors, 'lite', usage, kento),
    [
      '<!-- sakuga-review:summary -->',
      `**Score de confiance : 2/5** · ${picture('bloquant', 'Bloquant')} 1 point bloquant · Un jeton expiré passe.`,
      '',
      `${picture('avertissement', 'À vérifier')} **Une review plus poussée est conseillée :** le changement touche la vérification des jetons.`,
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
  assert.ok(block.includes(`\n<h2>Kentō · Score de confiance : 2/5 ${picture('jauge-2', '2/5')}</h2>\n`));
  assert.match(block, /^Commentez `@kento-review balanced` \(de 10 à 20 centimes\) ou `@kento-review heavy` \(de 30 à 50 centimes\)\.$/m);
  assert.match(block, /^1 constat d'une review précédente n'apparait plus : le fil peut être résolu\.$/m);
  assert.match(block, /^<sub>Reviews \(2\) · Dernier commit relu : \[fix\(auth\): check the expiry\]\(https:\/\/github\.com\/o\/n\/commit\/1{40}\) · Kentō · Niveau `lite`/m);
  assert.match(block, /<!-- sakuga-review:count 2 -->\n<!-- sakuga-review:end -->$/);
  assert.doesNotMatch(block, /Sakuga Review|revue|🔍/);
  assert.match(descriptionBlock(answer, [], [], 0, usage, anchors, context), /^<h2>Sakuga Review · Score de confiance : 2\/5<\/h2>$/m);
});

test('the block of Kentō ends with one line that lists its commands and links their page (REV-105)', () => {
  const docsUrl = 'https://review.sakuga.dev/docs/commandes';
  const context = { count: 1, head: '1'.repeat(40), subject: 's', commitUrl: `https://github.com/o/n/commit/${'1'.repeat(40)}`, level: 'lite' as const, poster: kento, docsUrl };
  const line =
    '<sub>Commandes de Kentō : `@kento-review [lite|balanced|heavy]` · `@kento-review resolve` · `@kento-review reject <cause>` (dans un fil) ou `reject #<id> <cause>` · `@kento-review feedback <avis>` · [Les commandes de Kentō](https://review.sakuga.dev/docs/commandes)</sub>';
  const first = descriptionBlock(answer, [{ finding, url: null }], [], 0, usage, anchors, context);
  assert.ok(first.endsWith(`${line}\n\n<!-- sakuga-review:count 1 -->\n<!-- sakuga-review:end -->`));
  // A later review writes its block in place of the earlier one: the line stays unique.
  const body = withBlock(withBlock('Le texte de l\'auteur.', first), descriptionBlock(answer, [], [], 1, usage, anchors, { ...context, count: 2 }));
  assert.equal(body.split(line).length - 1, 1);
  assert.ok(body.startsWith('Le texte de l\'auteur.\n\n<!-- sakuga-review:start -->'));
  // Without the page, or for the Action, the block lists no command.
  for (const other of [{ ...context, docsUrl: null }, { ...context, poster: undefined }]) {
    assert.doesNotMatch(descriptionBlock(answer, [], [], 0, usage, anchors, other), /Commandes de/);
  }
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

test('a P0 or P1 that does not block has a mark next to its priority (REV-103)', () => {
  const first = (f: Finding) => inlineBody(f, false, null, images).split('\n')[0]!;
  assert.doesNotMatch(first(finding), /à vérifier|à considérer/);
  assert.ok(first({ ...finding, confidence: 69 }).startsWith(`${picture('p1', 'P1')} ${picture('securite', 'sécurité')} ${picture('a-verifier', 'à vérifier')} **`));
  assert.ok(first({ ...finding, seen: true }).includes(`${picture('a-considerer', 'à considérer')} **`));
  assert.ok(first({ ...finding, seen: true, confidence: 50 }).includes(`${picture('a-considerer', 'à considérer')} **`));
  assert.doesNotMatch(first({ ...finding, severity: 'minor', confidence: 50 }), /à vérifier/);
});

test('the comment on a file links the lines of its finding, then gives the comment of the finding (REV-103)', () => {
  const body = fileCommentBody({ ...finding, start_line: 10 }, 'https://github.com/o/n/blob/abc/src/auth.ts#L10-L12');
  assert.ok(body.startsWith('Hors du diff de la PR : [`src/auth.ts:10-12`](https://github.com/o/n/blob/abc/src/auth.ts#L10-L12)\n\n'));
  assert.ok(body.endsWith(inlineBody({ ...finding, start_line: 10 }, false)));
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

const patch = '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -12 +12 @@\n-  return true;\n+  return exp > Date.now();';

test('a thread shows the patch of a finding under its fix, and an applicable suggestion wins over it (REV-104)', () => {
  const withPatch = { ...finding, patch };
  assert.match(inlineBody(withPatch, false), /\*\*Correction :\*\* Comparer exp à Date\.now\(\)\.\n\n```diff\n--- a\/src\/auth\.ts\n[\s\S]*\+  return exp > Date\.now\(\);\n```\n/);
  const both = inlineBody({ ...withPatch, suggestion: '  return exp > Date.now();' }, true);
  assert.match(both, /```suggestion\n  return exp > Date\.now\(\);\n```/);
  assert.doesNotMatch(both, /```diff/);
  assert.doesNotMatch(inlineBody({ ...finding, patch: Array.from({ length: 41 }, () => '+x').join('\n') }, false), /```diff/);
});

test('a finding without a thread shows its patch in the description, in a details block (REV-104)', () => {
  const context = { count: 1, head: '1'.repeat(40), subject: 's', commitUrl: `https://github.com/o/n/commit/${'1'.repeat(40)}`, level: 'lite' as const };
  const withPatch = { ...finding, patch };
  const block = descriptionBlock({ ...answer, findings: [withPatch] }, [{ finding: withPatch, url: null }], [], 0, usage, () => null, context);
  assert.match(
    block,
    /Comparer exp à Date\.now\(\)\.\n\n {3}<details><summary>Correction<\/summary>\n\n {3}```diff\n {3}--- a\/src\/auth\.ts\n {3}\+\+\+ b\/src\/auth\.ts\n {3}@@ -12 \+12 @@\n {3}- {2}return true;\n {3}\+ {2}return exp > Date\.now\(\);\n {3}```\n {3}<\/details>\n/,
  );
  const threaded = descriptionBlock({ ...answer, findings: [withPatch] }, [{ finding: withPatch, url: 'https://github.com/o/n/pull/1#discussion_r1' }], [], 0, usage, anchors, context);
  assert.doesNotMatch(threaded, /```diff/);
});

// REV-106. Every text that a review posts, for each priority and each mark.
function everyText(icons: Icons): string[] {
  const findings: Finding[] = [
    { ...finding, severity: 'critical' },
    finding,
    { ...finding, confidence: 60 },
    { ...finding, seen: true },
    { ...finding, severity: 'minor', category: 'bug' as const },
  ];
  const full = { ...answer, findings, not_reviewed: ['src/big.ts : plus de 400 lignes modifiées'] } as Answer;
  const poster = icons === 'emoji' ? undefined : { ...kento, icons };
  const context = { count: 1, head: '1'.repeat(40), subject: 's', commitUrl: `https://github.com/o/n/commit/${'1'.repeat(40)}`, level: 'lite' as const, poster };
  const links = findings.map((f, i) => ({ finding: f, url: i % 2 ? null : `https://github.com/o/n/pull/1#discussion_r${i}` }));
  return [
    reviewBody(full, anchors, 'lite', usage, poster, true),
    reviewBody({ ...full, findings: [{ ...finding, confidence: 60 }] }, anchors, 'lite', usage, poster),
    reviewBody({ ...full, findings: [{ ...finding, severity: 'minor' }] }, anchors, 'lite', usage, poster),
    descriptionBlock(full, links, ['dist/app.js : fichier généré ou binaire'], 1, usage, anchors, context),
    ...findings.flatMap((f) => [
      inlineBody(f, false, 'https://review.test/docs', icons),
      fileCommentBody(f, 'https://github.com/o/n/blob/abc/a.ts#L1', null, icons),
      variantReplyBody(f, '2'.repeat(40), 'fixed', icons),
    ]),
    ...(['resolu', 'a-resoudre', 'reste-ouvert'] as const).map((name) => icon(name, icons)),
  ];
}

const EMOJI = /\p{Extended_Pictographic}/u;

test('every image of a review has an alt, an absolute URL and a dark variant (REV-106)', () => {
  const all = everyText(images).join('\n');
  const pictures = all.match(/<picture>.*?<\/picture>/g) ?? [];
  assert.ok(pictures.length > 20);
  for (const p of pictures) {
    assert.match(
      p,
      /^<picture><source media="\(prefers-color-scheme: dark\)" srcset="https:\/\/review\.test\/assets\/pr\/[a-z0-9-]+-dark\.v1\.svg"><img alt="[^"]+" src="https:\/\/review\.test\/assets\/pr\/[a-z0-9-]+\.v1\.svg" height="20" align="top"><\/picture>$/,
    );
  }
  assert.equal(all.match(/<img /g)!.length, pictures.length, 'every image is in a picture');
  assert.doesNotMatch(all, /shields\.io/);
});

test('a review of the service shows no emoji, with images or with text only (REV-106)', () => {
  for (const icons of [images, 'text'] as const) {
    for (const text of everyText(icons)) assert.doesNotMatch(text, EMOJI, text);
  }
  const text = everyText('text').join('\n');
  assert.doesNotMatch(text, /<img|<picture/);
  assert.match(text, /^`P1` `sécurité` `à vérifier` \*\*/m);
  assert.match(text, /^<h2>Kentō · Score de confiance : 2\/5<\/h2>$/m);
  assert.match(text, /<a href="https:\/\/github\.com\/o\/n\/pull\/1#discussion_r0">`Fil`<\/a>/);
});

test('the Action keeps its emojis, and shows no image (REV-106)', () => {
  const text = everyText('emoji').join('\n');
  assert.doesNotMatch(text, /<img|<picture|shields\.io/);
  assert.match(text, /⛔ 2 points bloquants/);
  assert.match(text, /<a href="[^"]+">▶<\/a>/);
});

test('the head of a review: blocking, else points to check, else nothing blocks (REV-106)', () => {
  const head = (findings: Finding[], raised = false, lines: Anchors = anchors) =>
    reviewBody({ ...answer, findings } as Answer, lines, 'lite', usage, kento, raised).split('\n')[1]!;
  const p1At60 = { ...finding, confidence: 60 };
  const p2 = { ...finding, severity: 'minor' as const, category: 'bug' as const };
  assert.ok(head([finding, p1At60, p2]).includes(`· ${picture('bloquant', 'Bloquant')} 1 point bloquant ·`));
  assert.ok(head([p1At60, p2]).includes(`· ${picture('avertissement', 'À vérifier')} 1 point à vérifier ·`));
  assert.ok(head([p1At60, { ...p1At60, line: 40 }]).includes(' 2 points à vérifier ·'));
  // A P1 outside the diff gets a comment on its file, and does not block.
  assert.ok(head([finding], false, () => null).includes(' 1 point à vérifier ·'));
  assert.ok(head([p2]).includes(`· ${picture('ok', 'Rien de bloquant')} Rien de bloquant ·`));
  // A P1 to consider counts only when the review gives it a thread.
  assert.ok(head([{ ...finding, seen: true }, p2]).includes(' Rien de bloquant ·'));
  assert.ok(head([{ ...finding, seen: true }, p2], true).includes(' 1 point à vérifier ·'));
  assert.equal(toCheck({ ...answer, findings: [finding, p1At60, p2] } as Answer, anchors, false), 1);
  // The warning is for a point to check: a review with P2 findings only, and no advice, has none.
  const quiet = reviewBody({ ...answer, findings: [p2], deeper_review: { recommended: false, reason: '' } } as Answer, anchors, 'lite', usage, kento);
  assert.doesNotMatch(quiet, /avertissement/);
  assert.equal(head([], false), `**Score de confiance : 2/5** · ${picture('ok', 'Rien de bloquant')} Rien de bloquant · Un jeton expiré passe.`);
});
