// REV-68. The tools read the head of the pull request, and nothing else.
// Run with `pnpm test`, or `node --test packages/engine/test/`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MAX_FILE_BYTES, MAX_GREP_LINES, MAX_READ_LINES, RepoTools, safePath, TOOL_BUDGETS, TOOL_DEFINITIONS } from '../src/tools.ts';

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const big = { rounds: 10, calls: 100, bytes: 1_000_000 };

describe('the tools of a review', () => {
  const root = mkdtempSync(join(process.env.SAKUGA_TEST_TMP ?? tmpdir(), 'sakuga-review-tools-'));
  const repo = join(root, 'repo');
  let head = '';

  before(() => {
    git(root, 'init', '-q', repo);
    mkdirSync(join(repo, 'src', 'mail'), { recursive: true });
    writeFileSync(join(repo, 'src', 'mail', 'send.ts'), 'export function sendEmail(to: string) {\n  return disableStandardEmails ? null : to;\n}\n');
    writeFileSync(join(repo, 'src', 'caller.ts'), "import { sendEmail } from './mail/send';\nsendEmail('a@b');\n");
    writeFileSync(join(repo, 'long.txt'), Array.from({ length: 1000 }, (_, i) => `row ${i + 1}`).join('\n') + '\n');
    writeFileSync(join(repo, 'many.txt'), Array.from({ length: 200 }, () => 'needle').join('\n') + '\n');
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
    writeFileSync(join(repo, '-dash.ts'), 'const x = 1;\n');
    // A U+FFFD of the file itself, then two-byte characters: the cut must keep the first and split none.
    writeFileSync(join(repo, 'fffd.txt'), `${'a'.repeat(100)}\uFFFD${'é'.repeat(50)}\n`);
    symlinkSync('/etc/hosts', join(repo, 'link'));
    writeFileSync(join(repo, 'empty.txt'), '');
    writeFileSync(join(repo, 'huge.txt'), 'x'.repeat(MAX_FILE_BYTES + 1));
    git(repo, 'add', '-A');
    // A submodule: a gitlink in the tree, whose commit the repository does not hold.
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/lib`);
    git(repo, 'commit', '-q', '-m', 'head');
    head = git(repo, 'rev-parse', 'HEAD');
    // The working tree changes after the commit: the tools must still read the head.
    writeFileSync(join(repo, 'src', 'caller.ts'), 'changed after the head\n');
    writeFileSync(join(repo, 'untracked.ts'), 'sendEmail\n');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test('read_file gives numbered lines of the file at the head, not of the working tree', () => {
    const tools = new RepoTools(repo, head, big);
    assert.equal(tools.run({ name: 'read_file', input: { path: 'src/caller.ts' } }), "src/caller.ts\n1| import { sendEmail } from './mail/send';\n2| sendEmail('a@b');");
    assert.equal(tools.run({ name: 'read_file', input: { path: './src/mail/send.ts', from: 2, to: 2 } }), 'src/mail/send.ts\n2|   return disableStandardEmails ? null : to;\n[src/mail/send.ts: lines 2-2 of 3]');
    assert.match(tools.run({ name: 'read_file', input: { path: 'untracked.ts' } }), /not in the repository at the head/);
  });

  test('read_file gives at most MAX_READ_LINES lines, and says where the file goes on', () => {
    const out = new RepoTools(repo, head, big).run({ name: 'read_file', input: { path: 'long.txt', from: 10, to: 5000 } });
    const lines = out.split('\n');
    assert.equal(lines[1], '10| row 10');
    assert.equal(lines.at(-2), `${10 + MAX_READ_LINES - 1}| row ${10 + MAX_READ_LINES - 1}`);
    assert.equal(lines.at(-1), `[long.txt: lines 10-${10 + MAX_READ_LINES - 1} of 1000]`);
    assert.match(new RepoTools(repo, head, big).run({ name: 'read_file', input: { path: 'long.txt', from: 2000 } }), /has 1000 lines/);
    // Kentō on #146: an empty file says so.
    assert.equal(new RepoTools(repo, head, big).run({ name: 'read_file', input: { path: 'empty.txt' } }), 'empty.txt is empty.');
  });

  test('read_file refuses a path out of the repository, a folder and a binary file', () => {
    const tools = new RepoTools(repo, head, big);
    for (const path of ['../etc/passwd', '/etc/passwd', 'src/../../x', 'src//caller.ts', '', 42, ':(top)src', 'src\\caller.ts']) {
      assert.match(tools.run({ name: 'read_file', input: { path } }), /needs a path/, String(path));
    }
    assert.match(tools.run({ name: 'read_file', input: { path: 'src/mail' } }), /is a folder/);
    // Kentō on #146: a submodule and a file too big to read get a clear answer, not « The tool failed ».
    assert.equal(tools.run({ name: 'read_file', input: { path: 'vendor/lib' } }), 'vendor/lib is a submodule: its code is not in this repository.');
    assert.match(tools.run({ name: 'read_file', input: { path: 'huge.txt' } }), /^huge\.txt has \d+ bytes, more than the \d+ that read_file reads\. Use grep on it\.$/);
    assert.equal(tools.run({ name: 'read_file', input: { path: 'blob.bin' } }), 'blob.bin is a binary file.');
    // A symbolic link is a blob that holds its target: the tool gives the target, never the file it names.
    assert.equal(tools.run({ name: 'read_file', input: { path: 'link' } }), 'link\n1| /etc/hosts');
  });

  test('grep gives path:line:text at the head, in the glob', () => {
    const tools = new RepoTools(repo, head, big);
    assert.equal(
      tools.run({ name: 'grep', input: { pattern: 'sendEmail\\(' } }),
      "src/caller.ts:2:sendEmail('a@b');\nsrc/mail/send.ts:1:export function sendEmail(to: string) {",
    );
    assert.equal(tools.run({ name: 'grep', input: { pattern: 'disableStandardEmails', glob: 'src/**/*.ts' } }), 'src/mail/send.ts:2:  return disableStandardEmails ? null : to;');
    assert.equal(tools.run({ name: 'grep', input: { pattern: 'sendEmail', glob: 'src/*.ts' } }), "src/caller.ts:1:import { sendEmail } from './mail/send';\nsrc/caller.ts:2:sendEmail('a@b');");
    assert.equal(tools.run({ name: 'grep', input: { pattern: 'nothing-here' } }), 'No match.');
    // A pattern that starts with a dash stays a pattern.
    assert.equal(tools.run({ name: 'grep', input: { pattern: '-dash|const x' } }), '-dash.ts:1:const x = 1;');
    assert.match(tools.run({ name: 'grep', input: { pattern: 'x', glob: '../*' } }), /needs a glob/);
    assert.match(tools.run({ name: 'grep', input: { pattern: '' } }), /needs a pattern/);
    assert.match(tools.run({ name: 'grep', input: { pattern: '(' } }), /grep failed/);
  });

  test('grep gives at most MAX_GREP_LINES lines', () => {
    const out = new RepoTools(repo, head, big).run({ name: 'grep', input: { pattern: 'needle' } }).split('\n');
    assert.equal(out.length, MAX_GREP_LINES + 1);
    assert.equal(out.at(-1), `[${200 - MAX_GREP_LINES} more lines: narrow the pattern or the glob]`);
  });

  test('an unknown tool is an answer, not an error', () => {
    assert.match(new RepoTools(repo, head, big).run({ name: 'write_file', input: {} }), /Unknown tool "write_file"/);
  });

  test('the budget caps the calls, the bytes and the rounds', () => {
    const tools = new RepoTools(repo, head, { rounds: 2, calls: 2, bytes: 1_000_000 });
    assert.equal(tools.startRound(0), true);
    assert.equal(tools.startRound(1), true);
    assert.equal(tools.startRound(2), false);
    // Another conversation of the same review (a pass) has its own rounds.
    assert.equal(tools.startRound(0), true);
    // Only a round whose tools ran counts.
    assert.equal(tools.used.rounds, 0);
    tools.ranRound();
    assert.equal(tools.used.rounds, 1);
    tools.run({ name: 'grep', input: { pattern: 'sendEmail' } });
    tools.run({ name: 'grep', input: { pattern: 'sendEmail' } });
    assert.equal(tools.run({ name: 'grep', input: { pattern: 'sendEmail' } }), 'Tool budget used: answer now with what you have read.');
    assert.equal(tools.used.calls, 2);

    const small = new RepoTools(repo, head, { rounds: 5, calls: 50, bytes: 500 });
    const out = small.run({ name: 'read_file', input: { path: 'long.txt' } });
    assert.ok(Buffer.byteLength(out) <= 500);
    assert.match(out, /\[cut: the tool budget of this review is used\]$/);
    assert.equal(small.startRound(0), false);
    assert.match(small.run({ name: 'read_file', input: { path: 'long.txt' } }), /budget used/);

    // Kentō on #146: a room smaller than the cut note overran the budget. Every room gives at most the budget.
    for (const bytes of [1, 10, 54, 55, 79, 80, 99, 100, 101, 130]) {
      const tight = new RepoTools(repo, head, { rounds: 5, calls: 50, bytes });
      const text = tight.run({ name: 'read_file', input: { path: 'long.txt' } });
      assert.ok(tight.used.bytes <= bytes, `bytes ${bytes}: used ${tight.used.bytes}`);
      if (!/^Tool budget used/.test(text)) assert.ok(Buffer.byteLength(text) <= bytes, `bytes ${bytes}: gave ${Buffer.byteLength(text)}`);
    }
  });

  test('a cut keeps a U+FFFD of the file and never splits a character (Kentō on #146)', () => {
    const note = '\n[cut: the tool budget of this review is used]';
    // `fffd.txt\n1| ` is 12 bytes, then 100 `a`, then U+FFFD (3 bytes) ends at byte 115.
    const cutAt = 12 + 100 + 3;
    const expected = `fffd.txt\n1| ${'a'.repeat(100)}\uFFFD${note}`;
    for (const extra of [0, 1]) {
      // extra 1: the room ends in the middle of the first `é`, which the cut leaves out whole.
      const bytes = cutAt + Buffer.byteLength(note) + extra;
      const text = new RepoTools(repo, head, { rounds: 5, calls: 50, bytes }).run({ name: 'read_file', input: { path: 'fffd.txt' } });
      assert.equal(text, expected, `extra ${extra}`);
      assert.ok(Buffer.byteLength(text) <= bytes);
    }
    // Two more bytes: one whole `é` fits.
    const bytes = cutAt + Buffer.byteLength(note) + 2;
    assert.equal(new RepoTools(repo, head, { rounds: 5, calls: 50, bytes }).run({ name: 'read_file', input: { path: 'fffd.txt' } }), `fffd.txt\n1| ${'a'.repeat(100)}\uFFFDé${note}`);
  });

  test('every level has a budget, and the definitions name the two tools', () => {
    for (const level of ['lite', 'balanced', 'heavy'] as const) assert.ok(TOOL_BUDGETS[level].rounds >= 1);
    assert.ok(TOOL_BUDGETS.lite.bytes <= TOOL_BUDGETS.balanced.bytes && TOOL_BUDGETS.balanced.bytes <= TOOL_BUDGETS.heavy.bytes);
    assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name), ['read_file', 'grep']);
    assert.equal(safePath('a/b.ts'), 'a/b.ts');
  });
});
