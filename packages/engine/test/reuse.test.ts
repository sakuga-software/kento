// REV-89. A head whose reviewed files did not change since the last review calls no model.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { reviewPullRequest, reviewUnlessUnchanged, type Answer } from '../src/index.ts';
import { diffHash } from '../src/reuse.ts';
import type { OpenThread } from '../src/resolve.ts';

let repo = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (path: string, text: string) => writeFileSync(join(repo, path), text);

// main: base, then a commit on another file. pr: one commit on sum.ts and on the lock file.
let main1 = '';
let main2 = '';
let pr1 = '';
before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-reuse-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('sum.ts', 'export function sum(a: number, b: number) {\n  return a + b;\n}\n');
  write('pnpm-lock.yaml', 'lock: 1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  main1 = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  write('sum.ts', 'export function sum(a: number, b: number) {\n  return a - b;\n}\n');
  write('pnpm-lock.yaml', 'lock: 2\n');
  git('commit', '-q', '-am', 'fix: sum');
  pr1 = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  write('other.ts', 'export const other = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'main moves on');
  main2 = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { recursive: true, force: true }));

/** A head of the pull request after `steps`, on a new branch from pr1. */
function branchFrom(name: string, start: string, steps: () => void): string {
  git('checkout', '-q', '-b', name, start);
  steps();
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  return head;
}

const answer = (): Answer => ({
  confidence_score: 4,
  risk: 'Faible',
  summary: 'Résumé',
  diagram: '',
  findings: [],
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
});

function fakeModel() {
  let calls = 0;
  const fetch = (async (_url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        model: body.model,
        provider: 'Fake',
        choices: [{ message: { content: JSON.stringify(answer()) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 50, cost: 0.002, prompt_tokens_details: { cached_tokens: 600 } },
      }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

test('the diff hash stays after a merge of main and a rebase, and changes with a reviewed file', () => {
  const merged = branchFrom('merged', pr1, () => git('merge', '-q', '--no-edit', main2));
  const rebased = branchFrom('rebased', pr1, () => git('rebase', '-q', main2));
  const changed = branchFrom('changed', pr1, () => {
    write('sum.ts', 'export function sum(a: number, b: number) {\n  return b - a;\n}\n');
    git('commit', '-q', '-am', 'again');
  });
  const lockOnly = branchFrom('lock-only', pr1, () => {
    write('pnpm-lock.yaml', 'lock: 3\n');
    git('commit', '-q', '-am', 'lock');
  });
  const first = diffHash(repo, main1, pr1);
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(diffHash(repo, git('merge-base', main2, merged), merged), first, 'a merge of main changes no reviewed blob');
  assert.equal(diffHash(repo, git('merge-base', main2, rebased), rebased), first, 'a rebase with no conflict changes no reviewed blob');
  assert.notEqual(diffHash(repo, main1, changed), first, 'a new blob of sum.ts');
  assert.equal(diffHash(repo, main1, lockOnly), first, 'the lock file is not reviewed');
});

test('a merge of main reuses the last review: same key, and no model call', async () => {
  const merged = branchFrom('merged-2', pr1, () => git('merge', '-q', '--no-edit', main2));
  const model = fakeModel();
  const first = await reviewPullRequest({ repoDir: repo, base: main1, head: pr1, level: 'lite', apiKey: 'k', fetch: model.fetch, log: () => {} });
  assert.equal(model.calls(), 1);
  assert.equal(first.usage.cache_read_tokens, 600, 'OpenRouter gives the cached tokens in prompt_tokens_details');

  const again = await reviewUnlessUnchanged({ repoDir: repo, base: main2, head: merged, level: 'lite', apiKey: 'k', fetch: model.fetch, log: () => {}, previousKey: first.reuseKey });
  assert.equal(model.calls(), 1, 'no model call');
  assert.ok('unchanged' in again);
  assert.equal(again.head, merged);
  assert.equal(again.diffHash, first.diffHash);
  assert.equal(again.reuseKey, first.reuseKey);
});

test('a new reply, another level or a changed file gives a new review', async () => {
  const model = fakeModel();
  const first = await reviewPullRequest({ repoDir: repo, base: main1, head: pr1, level: 'lite', apiKey: 'k', fetch: model.fetch, log: () => {} });
  const changed = branchFrom('changed-2', pr1, () => {
    write('sum.ts', 'export function sum(a: number, b: number) {\n  return b - a;\n}\n');
    git('commit', '-q', '-am', 'again');
  });
  const thread: OpenThread = {
    id: 'T1',
    path: 'sum.ts',
    line: 2,
    comments: [
      { id: 1, author: 'kento-review[bot]', isBot: true, body: 'Soustraction', commit: pr1 },
      { id: 2, author: 'alex', isBot: false, body: 'Voulu : la fonction calcule une différence.', commit: pr1 },
    ],
  };
  const calls = model.calls();
  const cases = [
    { head: changed, level: 'lite' as const, threads: [] },
    { head: pr1, level: 'balanced' as const, threads: [] },
    { head: pr1, level: 'lite' as const, threads: [thread] },
  ];
  for (const c of cases) {
    const out = await reviewUnlessUnchanged({ repoDir: repo, base: main1, ...c, apiKey: 'k', fetch: model.fetch, log: () => {}, previousKey: first.reuseKey });
    assert.ok(!('unchanged' in out), `${c.level} ${c.head.slice(0, 7)} ${c.threads.length} threads: a new review`);
    assert.notEqual(out.reuseKey, first.reuseKey);
  }
  assert.equal(model.calls(), calls + cases.length);
});
