import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FINAL_INSTRUCTION, SECTION_PROMPT_FILES, sectionNotes } from '../src/sections.ts';
import { PROMPT_FILES } from '../src/reuse.ts';

const PROMPTS = join(import.meta.dirname, '..', 'prompts');

test('a first review gets no note of the later sections (KNT-110)', () => {
  assert.deepEqual(sectionNotes([{ text: '# Pull request a...b\n\n## Commits\n\nfix\n\n## Diff\n\n+x\n' }]), []);
});

test('a later review gets the note of each section that its pack holds, and only those', () => {
  const notes = sectionNotes([{ text: '## Diff\n\n+x\n' }, { text: '\n## Earlier findings\n\nE1\n\n## Changed since the last review\n\nzones\n' }]);
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /^## How to read the `Earlier findings` section/);
  assert.match(notes[1]!, /^## How to read the `Changed since the last review` section/);
});

test('a heading inside the diff is not a section: it starts with a mark of the diff', () => {
  assert.deepEqual(sectionNotes([{ text: '## Diff\n\n+## Answered threads\n ## Rejected findings\n' }]), []);
});

test('a prompt of the client replaces the file of a note, as for review.md', () => {
  assert.deepEqual(sectionNotes([{ text: '## Rejected findings\n' }], { 'sections/rejected-findings.md': 'MY NOTE\n' }), ['MY NOTE']);
});

test('the system prompt names the later sections but no longer explains them; the notes do', () => {
  const review = readFileSync(join(PROMPTS, 'review.md'), 'utf8');
  assert.match(review, /When the message holds one, its end says how to read it\./);
  assert.doesNotMatch(review, /For each thread, give\s+one entry in `threads`/);
  assert.doesNotMatch(review, /You have no tool/);
  assert.doesNotMatch(review, /50 to 79: the defect depends on a caller or a data shape that you could not\s+confirm/);
  for (const file of SECTION_PROMPT_FILES) assert.ok(readFileSync(join(PROMPTS, file), 'utf8').length > 100, file);
});

test('a change of a note changes the key of a reuse, as a change of review.md does', () => {
  for (const file of SECTION_PROMPT_FILES) assert.ok((PROMPT_FILES as readonly string[]).includes(file), file);
});

test('the last instruction names the Method and the JSON answer', () => {
  assert.match(FINAL_INSTRUCTION, /Method[\s\S]*JSON object/);
});
