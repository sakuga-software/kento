import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MAX_OTHER_FILES_BYTES, resolvePack, type OpenThread } from '../src/resolve.ts';

// KNT-197. On kento#49, `resolve` answered "could not confirm the fix, store.ts not in the message":
// the pack held the diff of the file of the thread only, and the fix was in another file. The pack
// now holds the diffs of the other files changed since the thread opened, within a budget.

let repo = '';
let base = '';
/** The commit of the thread: nothing fixed yet. */
let opened = '';
let head = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
/** A file of `n` lines of about 60 characters: its whole diff weighs about 60 n bytes. */
const big = (name: string, n: number) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = '${'x'.repeat(40)}';`).join('\n') + '\n';

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-resolve-pack-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'handler.ts'), 'export function handle(id: string) {\n  return store.read(id);\n}\n');
  writeFileSync(join(repo, 'store.ts'), 'export function read(id: string) {\n  return rows[id];\n}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  writeFileSync(join(repo, 'notes.md'), 'notes\n');
  git('add', '.');
  git('commit', '-q', '-m', 'docs: notes');
  opened = git('rev-parse', 'HEAD');
  // The fix is in store.ts; the push also adds three large files.
  writeFileSync(join(repo, 'store.ts'), 'export function read(id: string) {\n  if (!(id in rows)) throw new Error(`no row ${id}`);\n  return rows[id];\n}\n');
  writeFileSync(join(repo, 'a-large.ts'), big('a', 90));
  writeFileSync(join(repo, 'b-large.ts'), big('b', 90));
  writeFileSync(join(repo, 'c-large.ts'), big('c', 90));
  git('add', '.');
  git('commit', '-q', '-m', 'fix: read a missing row');
  head = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { recursive: true, force: true }));

const thread = (id: string, body: string, commit: string): OpenThread => ({
  id,
  path: 'handler.ts',
  line: 2,
  comments: [{ id: 1, author: 'kento-review', isBot: true, body, commit }],
});

test('the pack holds the diff of another file changed since the thread, where the fix is', () => {
  const t = thread('PRRT_store', '**A missing row returns undefined** The store does not check the id.', opened);
  const { pack, held, others } = resolvePack(repo, base, head, [t]);
  assert.deepEqual(held.map((h) => h.id), ['PRRT_store']);
  assert.match(pack, /### The diff of this file since the thread opened\n\nNo change\./);
  assert.match(pack, /### The other files changed since the thread opened\n\n#### `store\.ts`\n\n```diff\n[^]*\+  if \(!\(id in rows\)\) throw new Error/);
  // "The store" names store.ts by its stem: it comes before the large files.
  assert.equal(others.get('PRRT_store')![0], 'store.ts');
});

test('the files that the thread names come first, within MAX_OTHER_FILES_BYTES; the others are listed', () => {
  const t = thread('PRRT_named', 'See `c-large.ts` and store.ts.', opened);
  const { pack, others } = resolvePack(repo, base, head, [t]);
  const shown = others.get('PRRT_named')!;
  // c-large.ts and store.ts are named: they come first (the smaller diff first), then the others.
  assert.deepEqual(shown.slice(0, 2), ['store.ts', 'c-large.ts']);
  assert.ok(!shown.includes('b-large.ts'), 'three large diffs do not fit in the budget');
  assert.match(pack, /Other files changed, not shown: [^\n]*`b-large\.ts`/);
  const part = pack.slice(pack.indexOf('### The other files changed'));
  assert.ok(part.length < MAX_OTHER_FILES_BYTES + 1000, `${part.length} bytes`);
});

test('a thread whose commit a force-push removed shows the other files of the whole pull request, and counts none as a change', () => {
  const t = thread('PRRT_gone', 'The store does not check the id.', 'f'.repeat(40));
  const { pack, others } = resolvePack(repo, base, head, [t]);
  assert.match(pack, /### The other files of the whole pull request \(a force-push removed the commit of the thread\)/);
  assert.deepEqual(others.get('PRRT_gone'), []);
});
