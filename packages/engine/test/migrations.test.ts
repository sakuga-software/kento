import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
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
  assert.match(pack, /### drizzle\/migrations\/meta\/_journal\.json\n\n- entry added: `0001_role`/);
  assert.match(pack, /"tag": "0001_role"/, 'the journal whole');
  assert.match(pack, /### drizzle\/migrations\/meta\/0001_snapshot\.json\n\n- column added: `public\.members\.role` \(text, not null\)/);
  // The migration itself stays in the diff.
  assert.match(pack, /\+UPDATE members SET role = split_part\(roles, ',', 1\);/);
});

test('a renamed migration shows in the journal, and a rename of a column in the snapshot', () => {
  const { section, covered } = migrationSection(repo, head, renamed, ['drizzle/migrations/meta/_journal.json', 'drizzle/migrations/meta/0001_snapshot.json']);
  assert.deepEqual(covered, ['drizzle/migrations/meta/_journal.json', 'drizzle/migrations/meta/0001_snapshot.json']);
  assert.match(section, /- entry added: `0001_member_role`\n- entry removed: `0001_role`/);
  assert.match(section, /- column removed: `public\.members\.roles`/);
  assert.match(section, /- column renamed: `"public"\."members"\."roles"` → `"public"\."members"\."role_list"`/);
});

test('the changes of a snapshot: tables and columns added, removed and changed', () => {
  const a = { tables: { t: { columns: { id: { type: 'uuid' }, n: { type: 'integer' } } }, gone: { columns: {} } } };
  const b = { tables: { t: { columns: { id: { type: 'uuid', notNull: true }, n: { type: 'bigint' } } }, added: { columns: {} } } };
  assert.deepEqual(snapshotChanges(a, b), ['table added: `added`', 'table removed: `gone`', 'column now not null: `t.id`', 'column type changed: `t.n` integer → bigint']);
});

test('the prompt asks the four questions of a migration', () => {
  const text = readFileSync(join(import.meta.dirname, '..', 'prompts', 'review.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(text, /Can the version in service run on the new data, during the deploy and after a rollback\?/);
  assert.match(text, /Can every write path \(the app, a library, an admin tool\) still write a value that the migration does not handle\?/);
  assert.match(text, /What does a rollback leave\?/);
  assert.match(text, /Are mixed or legacy values \(a list in one column, a value with a prefix, an old spelling\) mapped, and to what\?/);
  assert.match(text, /A step of an expand and contract migration that the commits name \(the old column stays for one release\) is not a risk/);
});
