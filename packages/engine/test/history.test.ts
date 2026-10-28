// A pull request that a force-push rewrote: the commit of an open thread leaves its history.
// Run with `pnpm test`, or `node --test packages/engine/test/`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { diffStart, fileChangedSince, fileDiff, inHistory } from '../src/history.ts';

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

describe('a thread whose commit a force-push removed', () => {
  const root = mkdtempSync(join(process.env.SAKUGA_TEST_TMP ?? tmpdir(), 'sakuga-review-history-'));
  const origin = join(root, 'origin');
  const clone = join(root, 'clone');
  let base = '';
  let reviewed = '';
  let kept = '';
  let head = '';

  before(() => {
    git(root, 'init', '-q', origin);
    base = commit(origin, { 'SECURITY.md': 'v1\n', 'other.md': 'a\n' }, 'base');
    git(origin, 'switch', '-q', '-c', 'pr');
    kept = commit(origin, { 'other.md': 'b\n' }, 'kept');
    reviewed = commit(origin, { 'SECURITY.md': 'v2\n' }, 'reviewed');
    // The force-push: the branch starts again from the kept commit, and the reviewed commit leaves it.
    git(origin, 'reset', '-q', '--hard', kept);
    head = commit(origin, { 'SECURITY.md': 'v3\n' }, 'after the force-push');
    // A fresh clone, as in CI: it fetches only the commits that a ref reaches.
    git(root, 'clone', '-q', '--no-local', '--branch', 'pr', origin, clone);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test('the clone does not hold the reviewed commit, and a plain diff from it fails', () => {
    assert.throws(() => git(clone, 'diff', '--name-only', `${reviewed}..${head}`, '--', 'SECURITY.md'));
    assert.equal(inHistory(clone, reviewed, head), false);
  });

  test('a commit absent from the clone: the change is unknown, and nothing throws', () => {
    assert.equal(fileChangedSince(clone, reviewed, head, 'SECURITY.md'), null);
  });

  test('a commit still in the repository but off the history of the head: the change is unknown', () => {
    assert.equal(git(origin, 'cat-file', '-t', reviewed), 'commit');
    assert.equal(inHistory(origin, reviewed, head), false);
    assert.equal(fileChangedSince(origin, reviewed, head, 'SECURITY.md'), null);
  });

  test('the diff of the thread falls back to the whole pull request from the merge base', () => {
    for (const repo of [clone, origin]) {
      const start = diffStart(repo, reviewed, base, head);
      assert.deepEqual(start, { from: base, gone: true });
      const diff = fileDiff(repo, start!, head, 'SECURITY.md');
      assert.match(diff, /^-v1$/m);
      assert.match(diff, /^\+v3$/m);
    }
  });

  test('a commit in the history of the head keeps the diff since that commit', () => {
    assert.equal(inHistory(clone, kept, head), true);
    assert.equal(fileChangedSince(clone, kept, head, 'SECURITY.md'), true);
    assert.equal(fileChangedSince(clone, kept, head, 'other.md'), false);
    assert.equal(fileChangedSince(clone, head, head, 'SECURITY.md'), false);
    assert.deepEqual(diffStart(clone, kept, base, head), { from: kept, gone: false });
    assert.equal(fileChangedSince(clone, undefined, head, 'SECURITY.md'), false);
    assert.equal(diffStart(clone, undefined, base, head), null);
  });
});
