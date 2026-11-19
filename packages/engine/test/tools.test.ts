// REV-68. The tools read the head of the pull request, and nothing else.
// Run with `pnpm test`, or `node --test packages/engine/test/`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { GIT_TIMEOUT_MS, gitFailure, MAX_FILE_BYTES, MAX_GREP_COPIES, MAX_GREP_LINES, MAX_READ_LINES, RepoTools, safePath, TOOL_BUDGETS, TOOL_DEFINITIONS, unsafeGrepPattern } from '../src/tools.ts';

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
    // Long lines of a and b, as the author of a pull request can write them (REV-130).
    let seed = 7;
    for (const n of [1, 2, 3]) {
      const line = Array.from({ length: 1_500_000 }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 1 ? 'a' : 'b')).join('');
      writeFileSync(join(repo, `ab-${n}.txt`), `${line}\n`);
    }
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

  test('read_file gives numbered lines of the file at the head, not of the working tree', async () => {
    const tools = new RepoTools(repo, head, big);
    assert.equal(await tools.run({ name: 'read_file', input: { path: 'src/caller.ts' } }), "src/caller.ts\n1| import { sendEmail } from './mail/send';\n2| sendEmail('a@b');");
    assert.equal(await tools.run({ name: 'read_file', input: { path: './src/mail/send.ts', from: 2, to: 2 } }), 'src/mail/send.ts\n2|   return disableStandardEmails ? null : to;\n[src/mail/send.ts: lines 2-2 of 3]');
    assert.match(await tools.run({ name: 'read_file', input: { path: 'untracked.ts' } }), /not in the repository at the head/);
  });

  test('read_file gives at most MAX_READ_LINES lines, and says where the file goes on', async () => {
    const out = await new RepoTools(repo, head, big).run({ name: 'read_file', input: { path: 'long.txt', from: 10, to: 5000 } });
    const lines = out.split('\n');
    assert.equal(lines[1], '10| row 10');
    assert.equal(lines.at(-2), `${10 + MAX_READ_LINES - 1}| row ${10 + MAX_READ_LINES - 1}`);
    assert.equal(lines.at(-1), `[long.txt: lines 10-${10 + MAX_READ_LINES - 1} of 1000]`);
    assert.match(await new RepoTools(repo, head, big).run({ name: 'read_file', input: { path: 'long.txt', from: 2000 } }), /has 1000 lines/);
    // Kentō on #146: an empty file says so.
    assert.equal(await new RepoTools(repo, head, big).run({ name: 'read_file', input: { path: 'empty.txt' } }), 'empty.txt is empty.');
  });

  test('read_file refuses a path out of the repository, a folder and a binary file', async () => {
    const tools = new RepoTools(repo, head, big);
    for (const path of ['../etc/passwd', '/etc/passwd', 'src/../../x', 'src//caller.ts', '', 42, ':(top)src', 'src\\caller.ts']) {
      assert.match(await tools.run({ name: 'read_file', input: { path } }), /needs a path/, String(path));
    }
    assert.match(await tools.run({ name: 'read_file', input: { path: 'src/mail' } }), /is a folder/);
    // Kentō on #146: a submodule and a file too big to read get a clear answer, not "The tool failed".
    assert.equal(await tools.run({ name: 'read_file', input: { path: 'vendor/lib' } }), 'vendor/lib is a submodule: its code is not in this repository.');
    assert.match(await tools.run({ name: 'read_file', input: { path: 'huge.txt' } }), /^huge\.txt has \d+ bytes, more than the \d+ that read_file reads\. Use grep on it\.$/);
    assert.equal(await tools.run({ name: 'read_file', input: { path: 'blob.bin' } }), 'blob.bin is a binary file.');
    // A symbolic link is a blob that holds its target: the tool gives the target, never the file it names.
    assert.equal(await tools.run({ name: 'read_file', input: { path: 'link' } }), 'link\n1| /etc/hosts');
  });

  test('grep gives path:line:text at the head, in the glob', async () => {
    const tools = new RepoTools(repo, head, big);
    assert.equal(
      await tools.run({ name: 'grep', input: { pattern: 'sendEmail\\(' } }),
      "src/caller.ts:2:sendEmail('a@b');\nsrc/mail/send.ts:1:export function sendEmail(to: string) {",
    );
    assert.equal(await tools.run({ name: 'grep', input: { pattern: 'disableStandardEmails', glob: 'src/**/*.ts' } }), 'src/mail/send.ts:2:  return disableStandardEmails ? null : to;');
    assert.equal(await tools.run({ name: 'grep', input: { pattern: 'sendEmail', glob: 'src/*.ts' } }), "src/caller.ts:1:import { sendEmail } from './mail/send';\nsrc/caller.ts:2:sendEmail('a@b');");
    assert.equal(await tools.run({ name: 'grep', input: { pattern: 'nothing-here' } }), 'No match.');
    // A pattern that starts with a dash stays a pattern.
    assert.equal(await tools.run({ name: 'grep', input: { pattern: '-dash|const x' } }), '-dash.ts:1:const x = 1;');
    assert.match(await tools.run({ name: 'grep', input: { pattern: 'x', glob: '../*' } }), /needs a glob/);
    // REV-130: a back reference makes git grep exponential.
    assert.match(await tools.run({ name: 'grep', input: { pattern: '(a*)*(a*)*\\1\\2b' } }), /does not accept a back reference/);
    assert.equal((await tools.run({ name: 'grep', input: { pattern: 'sendEmail\\(' } })).startsWith('src/'), true, 'an escaped parenthesis is not a back reference');
    assert.match(await tools.run({ name: 'grep', input: { pattern: '\\\\\\1' } }), /does not accept a back reference/, 'an escaped backslash, then a reference');
    assert.equal(await tools.run({ name: 'grep', input: { pattern: 'x\\\\1' } }), 'No match.', 'a backslash then a 1 is not a reference');
    assert.match(await tools.run({ name: 'grep', input: { pattern: '' } }), /needs a pattern/);
    assert.match(await tools.run({ name: 'grep', input: { pattern: '(' } }), /grep failed/);
  });

  test('grep refuses a pattern whose repetitions fill the memory of git (REV-130)', async () => {
    // In the runner image under 2 GB, the first three made the kernel kill git after 3 to 10 s.
    const refused = [
      '((a{1,100}){1,100}){1,100}b',
      '(((a{1,30}){1,30}){1,30}){1,30}',
      '((a{1,255}){1,255}){1,255}',
      '(a{1,255}){1,255}',
      'a{1,100}{1,100}',
      '(.{1,100}){1,20}x',
      '(x(a{1,40}|b){1,40})+',
      '.{1001}',
      '.{1000,}',
      '[^x]{1,2000}y',
      // An empty group is a node of the matcher too (the second critique of #197).
      '((((){1,60}){1,60}){1,60}){1,60}b',
      '(((){1,255}){1,255}){1,255}b',
      '((((|){1,40}){1,40}){1,40}){1,40}',
      '(((((){1,20}){1,20}){1,20}){1,20}){1,20}',
    ];
    for (const pattern of refused) assert.match(unsafeGrepPattern(pattern) ?? 'accepted', /more than 1000 copies/, pattern);
    for (const pattern of ['(a*)*(a*)*\\1\\2b', '\\\\\\1', '(x)\\9']) assert.match(unsafeGrepPattern(pattern) ?? 'accepted', /back reference/, pattern);
    const accepted = [
      'sendEmail\\(',
      'function sendEmail|sendEmail\\(',
      '[0-9a-f]{40}',
      '.*?',
      '(foo\\s*)+bar',
      '(a|b)*c',
      '.*.*.*.*.*.*.*.*.*.*x',
      'a{1,1000}',
      '[[:alpha:]_]{1,100}',
      // A brace or a digit that is escaped, or in a bracket expression, is a character.
      '\\{1,100000\\}',
      '[{]1,100000}',
      'x\\\\1',
      '[\\]1',
    ];
    for (const pattern of accepted) assert.equal(unsafeGrepPattern(pattern), null, pattern);
    assert.equal(MAX_GREP_COPIES, 1000);

    const tools = new RepoTools(repo, head, big);
    const start = performance.now();
    assert.match(await tools.run({ name: 'grep', input: { pattern: '((a{1,100}){1,100}){1,100}b' } }), /grep does not accept this pattern/);
    assert.ok(performance.now() - start < 1000, 'git does not run');
  });

  test('a git call does not block the event loop, so the heartbeat of the runner goes on (REV-130)', async () => {
    const tools = new RepoTools(repo, head, big);
    let done = false;
    const answer = tools.run({ name: 'grep', input: { pattern: 'needle' } }).then((text) => {
      done = true;
      return text;
    });
    // With a synchronous git, the answer is ready before the next turn of the event loop.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false);
    assert.match(await answer, /^many\.txt:1:needle/);
    // The calls of the passes of a review run one after the other, in order.
    const both = await Promise.all([tools.run({ name: 'grep', input: { pattern: 'sendEmail\\(' } }), tools.run({ name: 'read_file', input: { path: 'empty.txt' } })]);
    assert.deepEqual(both.map((text) => text.split('\n')[0]), ["src/caller.ts:2:sendEmail('a@b');", 'empty.txt is empty.']);
  });

  test('a time limit stops one git call, and another stops the calls of the review (REV-130)', async () => {
    // Under the limit of copies, but slow on a long line: 17 s in the runner image, 60 s on macOS, for the 2 MB of huge.txt.
    const slowGrep = { name: 'grep', input: { pattern: '(.{1,50}){1,19}y', glob: 'huge.txt' } };
    const slow = new RepoTools(repo, head, big, { callMs: 200 });
    let start = performance.now();
    assert.equal(await slow.run(slowGrep), 'grep took too long and was stopped: use a simpler pattern or a narrower glob.');
    assert.ok(performance.now() - start < 5000, 'git is stopped at the limit of a call');
    assert.match(await slow.run({ name: 'grep', input: { pattern: 'sendEmail' } }), /^src\//, 'the next call runs');
    // The limit of the review: the first call uses it all, the next one does not run.
    const spent = new RepoTools(repo, head, big, { totalMs: 300 });
    start = performance.now();
    assert.match(await spent.run(slowGrep), /took too long/);
    assert.ok(performance.now() - start < 5000, 'the limit of a call is the time left to the review');
    assert.equal(spent.startRound(0), false);
    assert.equal(await spent.run({ name: 'grep', input: { pattern: 'sendEmail' } }), 'Tool budget used: answer now with what you have read.');
    assert.equal(spent.used.calls, 1);
  });

  test('a memory limit stops git, not the runner, when a pattern needs too much memory (REV-130)', { skip: process.platform !== 'linux' && 'RLIMIT_AS works on Linux only, as in the runner image' }, async () => {
    // Without the check of the pattern, these filled the 2 GB of the runner in 3 to 6 s: the kernel killed git, or node.
    const unchecked = new RepoTools(repo, head, big, { checkPattern: false });
    for (const pattern of ['((((){1,60}){1,60}){1,60}){1,60}b', '((a{1,100}){1,100}){1,100}b']) {
      const start = performance.now();
      assert.match(await unchecked.run({ name: 'grep', input: { pattern } }), /^grep stopped: the pattern needs more memory than git may use \(.*Memory exhausted\)/, pattern);
      assert.ok(performance.now() - start < GIT_TIMEOUT_MS, `${pattern} ends before the time limit`);
    }
    // A pattern under the limit of copies, on long lines that the author of the pull request chose:
    // it ends at the time limit of the call, under the memory limit.
    const start = performance.now();
    const answer = await new RepoTools(repo, head, big, { callMs: 2000 }).run({ name: 'grep', input: { pattern: '(.*a.{30}){20}z|(.*b.{20}){14}y', glob: 'ab-*.txt' } });
    assert.match(answer, /^(grep took too long and was stopped|grep stopped: the pattern needs more memory|No match\.)/);
    assert.ok(performance.now() - start < 5000);
    // The runner goes on: the next call answers.
    assert.match(await unchecked.run({ name: 'grep', input: { pattern: 'sendEmail\\(' } }), /^src\//);
  });

  test('only a signal of a process out of memory reads as a memory failure (REV-130, Kentō on #197)', () => {
    for (const signal of ['SIGKILL', 'SIGSEGV', 'SIGABRT', 'SIGBUS']) assert.equal(gitFailure({ signal }, ''), 'memory', signal);
    // The runner stops: git gets a SIGTERM or a SIGINT, which says nothing of the pattern.
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) assert.equal(gitFailure({ signal }, ''), 'other', signal);
    assert.equal(gitFailure({ code: 128 }, "fatal: -e option, 'x': Memory exhausted"), 'memory');
    assert.equal(gitFailure({ signal: 'SIGKILL', killed: true }, ''), 'time', 'node stopped it at the time limit');
    assert.equal(gitFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, ''), 'output');
    assert.equal(gitFailure({ code: 128 }, 'fatal: bad revision'), 'other');
  });

  test('grep gives the cause of a failure (REV-130)', async () => {
    const tools = new RepoTools(repo, head, big);
    assert.match(await tools.run({ name: 'grep', input: { pattern: '(' } }), /^grep failed: .+/);
    assert.match(await new RepoTools(join(root, 'missing'), head, big).run({ name: 'grep', input: { pattern: 'x' } }), /^grep failed: .+/);
  });

  test('grep gives at most MAX_GREP_LINES lines', async () => {
    const out = (await new RepoTools(repo, head, big).run({ name: 'grep', input: { pattern: 'needle' } })).split('\n');
    assert.equal(out.length, MAX_GREP_LINES + 1);
    assert.equal(out.at(-1), `[${200 - MAX_GREP_LINES} more lines: narrow the pattern or the glob]`);
  });

  test('an unknown tool is an answer, not an error', async () => {
    assert.match(await new RepoTools(repo, head, big).run({ name: 'write_file', input: {} }), /Unknown tool "write_file"/);
  });

  test('the budget caps the calls, the bytes and the rounds', async () => {
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
    await tools.run({ name: 'grep', input: { pattern: 'sendEmail' } });
    await tools.run({ name: 'grep', input: { pattern: 'sendEmail' } });
    assert.equal(await tools.run({ name: 'grep', input: { pattern: 'sendEmail' } }), 'Tool budget used: answer now with what you have read.');
    assert.equal(tools.used.calls, 2);

    const small = new RepoTools(repo, head, { rounds: 5, calls: 50, bytes: 500 });
    const out = await small.run({ name: 'read_file', input: { path: 'long.txt' } });
    assert.ok(Buffer.byteLength(out) <= 500);
    assert.match(out, /\[cut: the tool budget of this review is used\]$/);
    assert.equal(small.startRound(0), false);
    assert.match(await small.run({ name: 'read_file', input: { path: 'long.txt' } }), /budget used/);

    // Kentō on #146: a room smaller than the cut note overran the budget. Every room gives at most the budget.
    for (const bytes of [1, 10, 54, 55, 79, 80, 99, 100, 101, 130]) {
      const tight = new RepoTools(repo, head, { rounds: 5, calls: 50, bytes });
      const text = await tight.run({ name: 'read_file', input: { path: 'long.txt' } });
      assert.ok(tight.used.bytes <= bytes, `bytes ${bytes}: used ${tight.used.bytes}`);
      if (!/^Tool budget used/.test(text)) assert.ok(Buffer.byteLength(text) <= bytes, `bytes ${bytes}: gave ${Buffer.byteLength(text)}`);
    }
  });

  test('a cut keeps a U+FFFD of the file and never splits a character (Kentō on #146)', async () => {
    const note = '\n[cut: the tool budget of this review is used]';
    // `fffd.txt\n1| ` is 12 bytes, then 100 `a`, then U+FFFD (3 bytes) ends at byte 115.
    const cutAt = 12 + 100 + 3;
    const expected = `fffd.txt\n1| ${'a'.repeat(100)}\uFFFD${note}`;
    for (const extra of [0, 1]) {
      // extra 1: the room ends in the middle of the first `é`, which the cut leaves out whole.
      const bytes = cutAt + Buffer.byteLength(note) + extra;
      const text = await new RepoTools(repo, head, { rounds: 5, calls: 50, bytes }).run({ name: 'read_file', input: { path: 'fffd.txt' } });
      assert.equal(text, expected, `extra ${extra}`);
      assert.ok(Buffer.byteLength(text) <= bytes);
    }
    // Two more bytes: one whole `é` fits.
    const bytes = cutAt + Buffer.byteLength(note) + 2;
    assert.equal(await new RepoTools(repo, head, { rounds: 5, calls: 50, bytes }).run({ name: 'read_file', input: { path: 'fffd.txt' } }), `fffd.txt\n1| ${'a'.repeat(100)}\uFFFDé${note}`);
  });

  test('every level has a budget, and the definitions name the two tools', async () => {
    for (const level of ['lite', 'balanced', 'heavy'] as const) assert.ok(TOOL_BUDGETS[level].rounds >= 1);
    assert.ok(TOOL_BUDGETS.lite.bytes <= TOOL_BUDGETS.balanced.bytes && TOOL_BUDGETS.balanced.bytes <= TOOL_BUDGETS.heavy.bytes);
    assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name), ['read_file', 'grep']);
    assert.equal(safePath('a/b.ts'), 'a/b.ts');
  });
});
