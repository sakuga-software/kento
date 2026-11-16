import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// REV-42. The text of the findings and of the replies is published: each prompt asks for plain
// English (REV-114), without the tics of generated text.
const prompt = (name: string) => readFileSync(join(import.meta.dirname, '..', 'prompts', name), 'utf8').replace(/\s+/g, ' ');
const BANNED = ['Additionally', 'Moreover', 'Furthermore', 'crucial', 'essential', 'vital', 'ensure', 'guarantee', 'leverage', 'robust', 'in order to', 'it is important to note'];

for (const name of ['review.md', 'resolve.md']) {
  test(`${name} gives the rules of style of the published text`, () => {
    const text = prompt(name);
    const style = /# Style (.*?) # Answer/.exec(text)?.[1];
    assert.ok(style, `${name} has a "# Style" section before "# Answer"`);
    assert.match(style, /One idea per sentence\./);
    assert.match(style, /Use the active voice, and name the actor/);
    assert.match(style, /Never write an em dash \(—\) or an en dash \(–\)\./);
    assert.match(style, /Do not join two clauses with a colon, and do not open a sentence with a label and a colon\./);
    for (const word of BANNED) assert.ok(style.includes(`"${word}"`), `${name} bans "${word}"`);
    assert.match(style, /No closing formula/);
    assert.match(style, /Write (them|it) in plain English, even when/);
    assert.doesNotMatch(text, /French/);
  });
}

test('the style of review.md covers each published text field', () => {
  const style = /# Style (.*?) # Answer/.exec(prompt('review.md'))![1];
  // The style must not soften a finding: on the replay of REV-42, a borderline `major` came back `minor`.
  assert.match(style, /These rules change the words only\. They change no severity, no confidence and no score/);
  for (const field of ['risk', 'summary', 'title', 'scenario', 'fix', 'deeper_review.reason', 'not_reviewed']) {
    assert.ok(style.includes(`\`${field}\``), `the style names \`${field}\``);
  }
});

// REV-108. Two answers of the bench of REV-104 passed 25 kB of JSON and reached `max_tokens`.
test('review.md limits a suggestion to 10 lines and gives no diagram under 50 changed lines', () => {
  const text = prompt('review.md');
  assert.match(text, /A suggestion holds 10 lines at most: for a longer fix, give `""`\./);
  assert.match(text, /When the diff adds and removes fewer than 50 lines in all, give `""`\./);
});
