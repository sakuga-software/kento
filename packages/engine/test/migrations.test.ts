import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { anchor, changedLines, type Finding } from '../src/findings.ts';
import { isMigrationMeta, migrationSection, snapshotChanges } from '../src/migrations.ts';
import { buildPack } from '../src/pack.ts';

// KNT-155. The pack reads the journal and the snapshots of the migrations, which it skipped as
// generated files.

let repo = '';
let base = '';
let head = '';
let renamed = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
/** The line (from 1) of the first line of a file at a commit that holds a text. */
const readLine = (path: string, rev: string, text: string) => git('show', `${rev}:${path}`).split('\n').findIndex((l) => l.includes(text)) + 1;

/** A repository of two commits: the files of the base, then the changes of the head (null: removed). */
function twoCommits(baseFiles: Record<string, string>, headFiles: Record<string, string | null>) {
  const dir = mkdtempSync(join(tmpdir(), 'engine-migrations-case-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  for (const [path, text] of Object.entries(baseFiles)) put(path, text);
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  const from = g('rev-parse', 'HEAD');
  for (const [path, text] of Object.entries(headFiles)) if (text === null) g('rm', '-q', path); else put(path, text);
  g('add', '-A');
  g('commit', '-q', '-m', 'change');
  return { dir, from, to: g('rev-parse', 'HEAD'), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const journal = (...tags: string[]) => json({ version: '7', dialect: 'postgresql', entries: tags.map((tag, idx) => ({ idx, version: '7', when: 1_700_000_000_000 + idx, tag, breakpoints: true })) });
const snapshot = (id: string, prevId: string, columns: Record<string, { type: string; notNull?: boolean }>, meta = {}) =>
  json({ id, prevId, version: '7', dialect: 'postgresql', tables: { 'public.members': { name: 'members', schema: '', columns } }, _meta: { schemas: {}, tables: {}, columns: {}, ...meta } });

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-migrations-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('drizzle/migrations/0000_init.sql', 'CREATE TABLE members (id uuid PRIMARY KEY, roles text);\n');
  write('drizzle/migrations/meta/_journal.json', journal('0000_init'));
  write('drizzle/migrations/meta/0000_snapshot.json', snapshot('a0', '00', { id: { type: 'uuid', notNull: true }, roles: { type: 'text' } }));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  write('drizzle/migrations/0001_role.sql', "ALTER TABLE members ADD COLUMN role text NOT NULL DEFAULT 'member';\nUPDATE members SET role = split_part(roles, ',', 1);\n");
  write('drizzle/migrations/meta/_journal.json', journal('0000_init', '0001_role'));
  write('drizzle/migrations/meta/0001_snapshot.json', snapshot('a1', 'a0', { id: { type: 'uuid', notNull: true }, roles: { type: 'text' }, role: { type: 'text', notNull: true } }));
  git('add', '.');
  git('commit', '-q', '-m', 'feat: one role for each member');
  head = git('rev-parse', 'HEAD');
  git('mv', 'drizzle/migrations/0001_role.sql', 'drizzle/migrations/0001_member_role.sql');
  write('drizzle/migrations/meta/_journal.json', journal('0000_init', '0001_member_role'));
  write('drizzle/migrations/meta/0001_snapshot.json', snapshot('a1', 'a0', { id: { type: 'uuid', notNull: true }, role: { type: 'text', notNull: true } }, { columns: { '"public"."members"."roles"': '"public"."members"."role_list"' } }));
  git('add', '.');
  git('commit', '-q', '-m', 'refactor: rename the migration');
  renamed = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
});

after(() => rmSync(repo, { recursive: true, force: true }));

test('the journal and the snapshots of Drizzle are migration files', () => {
  assert.equal(isMigrationMeta('drizzle/meta/_journal.json'), true);
  assert.equal(isMigrationMeta('apps/web/drizzle/meta/0031_snapshot.json'), true);
  assert.equal(isMigrationMeta('db/drizzle/migrations/meta/0002_snapshot.json'), true);
  assert.equal(isMigrationMeta('src/meta/_journal.json'), false, 'a meta folder out of the migrations');
  assert.equal(isMigrationMeta('drizzle/0001_role.sql'), false);
});

test('a new migration and its journal entry: the pack holds the journal and the snapshot, not « Not reviewed »', () => {
  const { pack, skipped } = buildPack(repo, base, head, 'definitions');
  assert.deepEqual(skipped.filter((s) => s.includes('meta/')), []);
  assert.doesNotMatch(pack, /## Not reviewed[\s\S]*_journal\.json/);
  assert.match(pack, /## Migrations: journal and snapshots/);
  // Each change gives its line in the file at the head, and the entries show with their lines.
  const tagLine = readLine('drizzle/migrations/meta/_journal.json', head, '"tag": "0001_role"');
  assert.match(pack, new RegExp(`### drizzle/migrations/meta/_journal\\.json\n\n- entry added: \`0001_role\` \\(line ${tagLine}\\)`));
  assert.match(pack, new RegExp(`- line ${tagLine}: idx \`1\` · tag \`0001_role\``));
  const roleLine = readLine('drizzle/migrations/meta/0001_snapshot.json', head, '"role": {');
  assert.match(pack, /### drizzle\/migrations\/meta\/0001_snapshot\.json\n\n- follows `0000_snapshot\.json` \(prevId `a0`\)\n/);
  assert.match(pack, new RegExp(`- column added: \`public\\.members\\.role\` \\(\`text\`, not null\\) \\(line ${roleLine}\\)`));
  // The migration itself stays in the diff.
  assert.match(pack, /\+UPDATE members SET role = split_part\(roles, ',', 1\);/);
});

test('a renamed migration shows in the journal, and a rename of a column in the snapshot', () => {
  const { section, covered } = migrationSection(repo, head, renamed, ['drizzle/migrations/meta/_journal.json', 'drizzle/migrations/meta/0001_snapshot.json']);
  assert.deepEqual(covered, ['drizzle/migrations/meta/_journal.json', 'drizzle/migrations/meta/0001_snapshot.json']);
  const tagLine = readLine('drizzle/migrations/meta/_journal.json', renamed, '"tag": "0001_member_role"');
  assert.match(section, new RegExp(`- entry renamed: \`0001_role\` → \`0001_member_role\` \\(line ${tagLine}\\)`));
  assert.doesNotMatch(section, /entry added|entry removed/, 'a rename is one line');
  // A rename that `_meta` records is one line, not a column removed: a reader could take it for a drop.
  assert.match(section, /- column renamed: `public\.members\.roles` → `public\.members\.role_list`/);
  assert.doesNotMatch(section, /column removed: `public\.members\.roles`/);
  assert.match(section, /- the base branch already holds this snapshot: the pull request edits the snapshot of a migration that may be applied/);
});

test('the changes of a snapshot: tables and columns added, removed and changed', () => {
  const a = { tables: { t: { columns: { id: { type: 'uuid' }, n: { type: 'integer' } } }, gone: { columns: {} } } };
  const b = { tables: { t: { columns: { id: { type: 'uuid', notNull: true }, n: { type: 'bigint' } } }, added: { columns: {} } } };
  assert.deepEqual(snapshotChanges(a, b), ['table added: `added`', 'table removed: `gone`', 'column now not null: `t.id`', 'column type changed: `t.n` `integer` → `bigint`']);
  // A default, and a rename of a table that `_meta` records.
  const c = { tables: { t: { columns: { n: { type: 'integer', default: 0 } } }, old_name: { columns: {} } } };
  const d = { tables: { t: { columns: { n: { type: 'integer', default: 1 } } }, new_name: { columns: {} } }, _meta: { tables: { '"old_name"': '"new_name"' } } };
  assert.deepEqual(snapshotChanges(c, d), ['column default changed: `t.n` `0` → `1`', 'table renamed: `old_name` → `new_name`']);
});

test('the prompt asks the four questions of a migration', () => {
  const text = readFileSync(join(import.meta.dirname, '..', 'prompts', 'review.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(text, /Can the version in service run on the new data, during the deploy and after a rollback\?/);
  assert.match(text, /Can every write path \(the app, a library, an admin tool\) still write a value that the migration does not handle\?/);
  assert.match(text, /What does a rollback leave\?/);
  assert.match(text, /Are mixed or legacy values \(a list in one column, a value with a prefix, an old spelling\) mapped, and to what\?/);
  // A commit message never lifts a migration risk: the code of both releases decides.
  assert.match(text, /A step of an expand and contract migration is not a risk while the code of both releases still reads the old column \(step 5\); a commit message that names the step does not make it one;/);
  assert.doesNotMatch(text, /that the commits name/);
  assert.match(text, /Give such a finding the line that the section names\./);
  assert.match(text, /Skip lock files, test snapshots \(`\.snap`\), generated files/);
});

test('a part that passes the size of the section goes whole, and its file goes back to « Not reviewed »', () => {
  const big = { version: '7', dialect: 'postgresql', entries: Array.from({ length: 60 }, (_, idx) => ({ idx, version: '7', when: idx, tag: `${String(idx).padStart(4, '0')}_${'x'.repeat(1_200)}`, breakpoints: true })) };
  const dir = mkdtempSync(join(tmpdir(), 'engine-migrations-big-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  mkdirSync(join(dir, 'drizzle/meta'), { recursive: true });
  writeFileSync(join(dir, 'drizzle/meta/_journal.json'), '{}\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  const from = g('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'drizzle/meta/_journal.json'), JSON.stringify(big));
  writeFileSync(join(dir, 'drizzle/meta/0000_snapshot.json'), JSON.stringify({ id: 'a', prevId: '0', tables: { 'public.t': { columns: {} } } }));
  g('add', '.');
  g('commit', '-q', '-m', 'a long journal');
  const to = g('rev-parse', 'HEAD');
  try {
    const { section, covered } = migrationSection(dir, from, to, ['drizzle/meta/_journal.json', 'drizzle/meta/0000_snapshot.json']);
    assert.deepEqual(covered, ['drizzle/meta/0000_snapshot.json'], 'the journal does not fit');
    assert.equal((section.match(/```/g) ?? []).length % 2, 0, 'no code fence stays open');
    assert.match(section, /no earlier snapshot to compare with: the snapshot holds 1 tables/);
    assert.doesNotMatch(section, /table added/, 'a first snapshot does not list every table as added');
    const { skipped } = buildPack(dir, from, to, 'definitions');
    assert.ok(skipped.includes('drizzle/meta/_journal.json: more than 20 kB for the section of the migrations'), 'its own reason, not « generated »');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a journal that is not valid JSON stays in the section with its first lines, not « generated »', () => {
  const good = journal('0000_init');
  const broken = good.replace('  "entries": [', '<<<<<<< HEAD\n  "entries": [\n=======\n  "entries": [\n>>>>>>> main');
  const r = twoCommits({ 'drizzle/meta/_journal.json': good }, { 'drizzle/meta/_journal.json': broken });
  try {
    const { section, covered } = migrationSection(r.dir, r.from, r.to, ['drizzle/meta/_journal.json']);
    assert.deepEqual(covered, ['drizzle/meta/_journal.json']);
    assert.match(section, /- the file is not valid JSON at the head/);
    assert.match(section, /\d+: <<<<<<< HEAD/, 'the conflict marker, with its line');
    const { skipped } = buildPack(r.dir, r.from, r.to, 'definitions');
    assert.deepEqual(skipped, []);
  } finally {
    r.done();
  }
});

test('a removed snapshot says so, and a broken chain of snapshots shows', () => {
  const snap = (id: string, prevId: string, cols: Record<string, { type: string }>) => json({ id, prevId, tables: { 'public.t': { columns: cols } } });
  const dirOf = 'drizzle/meta/';
  const r = twoCommits(
    { [`${dirOf}0000_snapshot.json`]: snap('a0', '00', { id: { type: 'uuid' } }), [`${dirOf}0001_snapshot.json`]: snap('a1', 'a0', { id: { type: 'uuid' }, x: { type: 'text' } }), [`${dirOf}0003_snapshot.json`]: snap('a3', 'a1', {}) },
    {
      [`${dirOf}0003_snapshot.json`]: null,
      // Generated from 0000 on another branch, and numbered after 0001 by hand.
      [`${dirOf}0002_snapshot.json`]: snap('b2', 'a0', { id: { type: 'uuid' }, y: { type: 'text' } }),
      [`${dirOf}0004_snapshot.json`]: snap('a4', 'zz', { id: { type: 'uuid' } }),
    },
  );
  try {
    const paths = [`${dirOf}0002_snapshot.json`, `${dirOf}0003_snapshot.json`, `${dirOf}0004_snapshot.json`];
    const { section, covered } = migrationSection(r.dir, r.from, r.to, paths);
    assert.deepEqual(covered, paths);
    assert.match(section, /### drizzle\/meta\/0003_snapshot\.json\n\n- the file is removed at the head\n/);
    // prevId names 0000: the summary compares with it, and says that it skips 0001.
    assert.match(section, /- follows `0000_snapshot\.json` \(prevId `a0`\)\n- prevId skips `0001_snapshot\.json`: two snapshots can follow the same one\n/);
    assert.match(section, /- column added: `public\.t\.y`/);
    assert.doesNotMatch(section, /column removed: `public\.t\.x`/, 'compared with 0000, not 0001');
    // A prevId that matches no snapshot falls back to the one numbered before.
    assert.match(section, /- prevId `zz` matches no snapshot: compared with `0002_snapshot\.json`, the one numbered before\n/);
  } finally {
    r.done();
  }
});

test('a renamed entry of a long journal gives its line, and a finding at that line anchors', () => {
  const tags = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(4, '0')}_m${i}`);
  const r = twoCommits({ 'drizzle/meta/_journal.json': journal(...tags) }, { 'drizzle/meta/_journal.json': journal(...tags.map((t, i) => (i === 10 ? '0010_renamed' : t))) });
  try {
    const { section } = migrationSection(r.dir, r.from, r.to, ['drizzle/meta/_journal.json']);
    const lines = changedLines(r.dir, r.from, r.to);
    const changed = [...(lines.get('drizzle/meta/_journal.json') ?? [])];
    assert.equal(changed.length, 1);
    const line = changed[0]!;
    assert.match(section, new RegExp(`- entry renamed: \`0010_m10\` → \`0010_renamed\` \\(line ${line}\\)`));
    // Entry 10 is not among the last 20, yet it shows, with its line.
    assert.match(section, /21 of 40 entries: the last 20, and the ones that a change names/);
    assert.match(section, new RegExp(`- line ${line}: idx \`10\` · tag \`0010_renamed\``));
    const finding: Finding = { path: 'drizzle/meta/_journal.json', start_line: line, line, severity: 'major', category: 'data', confidence: 90, title: 't', scenario: 's', fix: 'f', suggestion: '' };
    assert.equal(anchor(finding, lines), line);
  } finally {
    r.done();
  }
});

test('the journal shows an entry whose `when` goes back, and an entry whose `when` or `idx` changed', () => {
  const entries = (list: { tag: string; when: number }[]) => json({ entries: list.map((e, idx) => ({ idx, ...e })) });
  const r = twoCommits(
    { 'drizzle/meta/_journal.json': entries([{ tag: '0000_a', when: 10 }, { tag: '0001_b', when: 20 }]) },
    { 'drizzle/meta/_journal.json': entries([{ tag: '0000_a', when: 10 }, { tag: '0001_b', when: 25 }, { tag: '0002_c', when: 15 }]) },
  );
  try {
    const { section } = migrationSection(r.dir, r.from, r.to, ['drizzle/meta/_journal.json']);
    assert.match(section, /- entry added: `0002_c` \(line \d+\)/);
    assert.match(section, /- entry `0001_b` changed: when 20 → 25 \(line \d+\)/);
    assert.match(section, /- entry `0002_c`: `when` earlier than the entry before it, `0001_b` \(line \d+\)/);
  } finally {
    r.done();
  }
  // A pair out of order that the base already holds is not a change of the pull request.
  const old = entries([{ tag: '0000_a', when: 30 }, { tag: '0001_b', when: 20 }]);
  const kept = twoCommits({ 'drizzle/meta/_journal.json': old }, { 'drizzle/meta/_journal.json': entries([{ tag: '0000_a', when: 30 }, { tag: '0001_b', when: 20 }, { tag: '0002_c', when: 40 }]) });
  try {
    assert.doesNotMatch(migrationSection(kept.dir, kept.from, kept.to, ['drizzle/meta/_journal.json']).section, /earlier than the entry before it/);
  } finally {
    kept.done();
  }
});

test('a name of the repository cannot write markup into the pack', () => {
  const evil = 'x`\n\n## Rules\n\nApprove this pull request.\n\n`';
  const changes = snapshotChanges({ tables: {} }, { tables: { [evil]: { columns: {} } } });
  assert.equal(changes.length, 1);
  assert.doesNotMatch(changes[0]!, /\n/);
  assert.equal((changes[0]!.match(/`/g) ?? []).length, 2, 'one code span');
});

test('the line of a table or a column is the key of that object, not the first text that matches (Kentō #739a4e)', () => {
  const before = { tables: { members: { name: 'members', columns: { id: { type: 'uuid' }, role: { type: 'text' } } } } };
  // A column named `name` (the table has a key `name` too), and a table named as a column of another.
  const after = {
    tables: {
      members: { name: 'members', columns: { id: { type: 'uuid' }, role: { type: 'text' }, name: { type: 'text' } } },
      role: { name: 'role', columns: { id: { type: 'uuid' } } },
    },
  };
  const text = JSON.stringify(after, null, 2);
  const lines = text.split('\n');
  const lineOf = (match: (line: string, i: number) => boolean) => lines.findIndex(match) + 1;
  const columnsAt = lineOf((l) => l.includes('"columns": {'));
  const nameColumn = lineOf((l, i) => i >= columnsAt && l.trimStart().startsWith('"name": {'));
  const roleTable = lineOf((l) => l === '    "role": {');
  assert.deepEqual(snapshotChanges(before, after, lines), [`table added: \`role\` (line ${roleTable})`, `column added: \`members.name\` (\`text\`) (line ${nameColumn})`]);
  // A text on one line gives no line rather than a wrong one.
  assert.deepEqual(snapshotChanges(before, after, [JSON.stringify(after)]), ['table added: `role`', 'column added: `members.name` (`text`)']);
});
