import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanBody } from '../src/threads.ts';

// KNT-197. CodeQL: the expressions of `cleanBody` read the rest of the text from each opener, so a
// comment of openers with no closer took a time in the square of its length. A comment is text that
// anyone who can comment writes.

test('cleanBody removes comments, details and media tags, as before', () => {
  const body = 'Fix it <!-- hidden --> now.<details>log</details> See <img src="x"> <a href="y">the doc</a>.<!-- no end';
  assert.equal(cleanBody(body), 'Fix it  now. See  the doc</a>.<!-- no end');
  // A removal that joins two halves of a comment: removed too.
  assert.equal(cleanBody('a <!<!---->-- x --> b'), 'a  b');
  assert.equal(cleanBody('<picture><source srcset="z"><img alt="P1" src="p"></picture> **Title**'), '</picture> **Title**');
  assert.equal(cleanBody('an <abbr>abbr</abbr> stays'), 'an <abbr>abbr</abbr> stays');
});

test('cleanBody reads a long comment of openers with no closer in linear time', () => {
  for (const opener of ['<!--', '<details>', '<img ']) {
    const body = opener.repeat(50_000);
    const start = performance.now();
    cleanBody(body);
    const ms = performance.now() - start;
    assert.ok(ms < 500, `${opener}: ${ms.toFixed(0)} ms`);
  }
});
