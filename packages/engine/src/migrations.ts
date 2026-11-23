// KNT-155. The journal and the snapshots of the migrations of a pull request, as the review reads
// them. The pack skipped them as generated files, and « Not reviewed » listed them. Yet a renamed
// or removed migration is exactly what the journal shows, and the snapshot says which tables and
// columns the next generation of the schema will write.
import { git } from './git.ts';

/** The journal or a snapshot of Drizzle: `drizzle/meta/_journal.json`, `drizzle/migrations/meta/0031_snapshot.json`. */
const META = /(^|\/)meta\/(_journal\.json|\d+_snapshot\.json)$/;
const JOURNAL = /(^|\/)meta\/_journal\.json$/;
const SNAPSHOT = /(^|\/)meta\/(\d+)_snapshot\.json$/;

/** The section holds at most this many bytes; a longer journal shows its last entries. */
export const MAX_MIGRATION_BYTES = 20_000;
// The entries of a long journal that the section shows, with the ones that a change names.
const LAST_ENTRIES = 20;
// The lines of a file that is not valid JSON that the section shows.
const RAW_LINES = 40;

/** Whether a path is the journal or a snapshot of the migrations of Drizzle. */
export function isMigrationMeta(path: string): boolean {
  return META.test(path) && /(^|\/)(drizzle|migrations?)\//.test(path);
}

type Column = { type?: string; notNull?: boolean; default?: unknown };
type Snapshot = { id?: string; prevId?: string; tables?: Record<string, { columns?: Record<string, Column> }>; _meta?: { tables?: Record<string, string>; columns?: Record<string, string> } };
type Entry = { idx?: number; tag?: string; when?: number };
type Journal = { entries?: Entry[] };

/** A file at a commit: missing, not valid JSON, or read. */
type Read<T> = { state: 'missing' } | { state: 'invalid'; raw: string } | { state: 'ok'; raw: string; json: T };

function read<T>(repo: string, rev: string, path: string): Read<T> {
  // `ls-tree` first: `git show` of a missing path writes an error on stderr, in the logs of the runner.
  if (!git(repo, 'ls-tree', '--name-only', rev, '--', path).trim()) return { state: 'missing' };
  const raw = git(repo, 'show', `${rev}:${path}`);
  try {
    const json = JSON.parse(raw) as T;
    return json && typeof json === 'object' ? { state: 'ok', raw, json } : { state: 'invalid', raw };
  } catch {
    return { state: 'invalid', raw };
  }
}

const parsed = <T>(r: Read<T>): T | null => (r.state === 'ok' ? r.json : null);

/** A name of the repository in one code span: no line break, no backquote, at most 200 characters. */
function code(value: unknown): string {
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/`/g, "'");
  return `\`${text.length > 200 ? `${text.slice(0, 200)}…` : text}\``;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const indent = (line: string) => line.length - line.trimStart().length;

/**
 * The index of the line of the key `key` of the object that opens at line `start` of a JSON text, or
 * null: only a key of that object, at the depth of its own keys (Kentō #739a4e: the first match of a
 * name could be a key of another table, or a key of a column object such as `name`). A text on one
 * line gives null.
 */
function childKey(lines: readonly string[], start: number | null, key: string): number | null {
  if (start === null || !lines[start]?.trimEnd().endsWith('{')) return null;
  const outer = indent(lines[start]!);
  const inner = lines[start + 1] === undefined ? -1 : indent(lines[start + 1]!);
  if (inner <= outer) return null;
  const quoted = `${JSON.stringify(key)}:`;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() && indent(line) <= outer) return null;
    if (indent(line) === inner && line.trimStart().startsWith(quoted)) return i;
  }
  return null;
}

/** The line (from 1) of a table of a snapshot, or of a column of that table, in the text at the head. */
function snapshotLines(lines: readonly string[]): { table: (name: string) => number | null; column: (table: string, col: string) => number | null } {
  const tables = childKey(lines, 0, 'tables');
  const table = (name: string) => childKey(lines, tables, name);
  const plus = (i: number | null) => (i === null ? null : i + 1);
  return { table: (name) => plus(table(name)), column: (t, col) => plus(childKey(lines, childKey(lines, table(t), 'columns'), col)) };
}

const at = (line: number | null) => (line ? ` (line ${line})` : '');

/** `"public"."members"."role"` of `_meta` → ['public.members', 'role']. */
function splitName(name: string): string[] {
  return [...name.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
}

/**
 * The tables and columns that a snapshot adds, removes or changes against the one before, each with
 * its line in the snapshot at the head when `lines` holds its text. A rename that Drizzle records in
 * `_meta` is one line, not a column removed and another added.
 */
export function snapshotChanges(before: Snapshot | null, after: Snapshot, lines: readonly string[] = []): string[] {
  const out: string[] = [];
  const old = before?.tables ?? {};
  const now = after.tables ?? {};
  const tableRenames = Object.entries(after._meta?.tables ?? {}).map(([from, to]) => [splitName(from).join('.'), splitName(to).join('.')] as const);
  const columnRenames = Object.entries(after._meta?.columns ?? {}).map(([from, to]) => {
    const a = splitName(from);
    const b = splitName(to);
    return { table: b.slice(0, -1).join('.'), from: a.at(-1) ?? '', to: b.at(-1) ?? '', fromTable: a.slice(0, -1).join('.') };
  });
  const renamedTableFrom = new Set(tableRenames.map(([from]) => from));
  const renamedTableTo = new Set(tableRenames.map(([, to]) => to));
  const renamedColumnFrom = new Set(columnRenames.map((r) => `${r.fromTable}.${r.from}`));
  const renamedColumnTo = new Set(columnRenames.map((r) => `${r.table}.${r.to}`));
  const where = snapshotLines(lines);
  const tableLine = where.table;
  for (const name of Object.keys(now)) if (!old[name] && !renamedTableTo.has(name)) out.push(`table added: ${code(name)}${at(tableLine(name))}`);
  for (const name of Object.keys(old)) if (!now[name] && !renamedTableFrom.has(name)) out.push(`table removed: ${code(name)}`);
  for (const [name, table] of Object.entries(now)) {
    const was = old[name]?.columns;
    if (!was) continue;
    const from = tableLine(name);
    const colLine = (col: string) => at(where.column(name, col));
    const cols = table.columns ?? {};
    for (const col of Object.keys(cols)) {
      const b = cols[col]!;
      if (!was[col]) {
        if (!renamedColumnTo.has(`${name}.${col}`)) out.push(`column added: ${code(`${name}.${col}`)} (${code(b.type ?? '?')}${b.notNull ? ', not null' : ''})${colLine(col)}`);
        continue;
      }
      const a = was[col]!;
      if (a.type !== b.type) out.push(`column type changed: ${code(`${name}.${col}`)} ${code(a.type ?? '?')} → ${code(b.type ?? '?')}${colLine(col)}`);
      if (Boolean(a.notNull) !== Boolean(b.notNull)) out.push(`column ${b.notNull ? 'now not null' : 'now nullable'}: ${code(`${name}.${col}`)}${colLine(col)}`);
      if (JSON.stringify(a.default) !== JSON.stringify(b.default))
        out.push(`column default changed: ${code(`${name}.${col}`)} ${code(JSON.stringify(a.default) ?? 'none')} → ${code(JSON.stringify(b.default) ?? 'none')}${colLine(col)}`);
    }
    for (const col of Object.keys(was)) if (!cols[col] && !renamedColumnFrom.has(`${name}.${col}`)) out.push(`column removed: ${code(`${name}.${col}`)}${at(from)}`);
  }
  // Drizzle records the renames that the person chose when the schema was generated.
  for (const [from, to] of tableRenames) out.push(`table renamed: ${code(from)} → ${code(to)}${at(tableLine(to))}`);
  for (const r of columnRenames) out.push(`column renamed: ${code(`${r.fromTable}.${r.from}`)} → ${code(`${r.table}.${r.to}`)}${at(where.column(r.table, r.to))}`);
  return out;
}

/**
 * The entries that the journal of the head adds, removes, renames (another tag at the same `idx`) or
 * changes (`idx`, `when`) against the base, and an entry whose `when` is earlier than the entry before
 * it: the migrator of Drizzle skips such an entry on a database that applied the later one. Gives the
 * lines and the tags that the changes name.
 */
function journalChanges(before: Journal | null, after: Journal, lineOf: (tag: string) => number | null): { changes: string[]; named: Set<string> } {
  const was = (before?.entries ?? []).filter((e) => typeof e?.tag === 'string');
  const now = (after.entries ?? []).filter((e) => typeof e?.tag === 'string');
  const wasByTag = new Map(was.map((e) => [e.tag!, e]));
  const nowByTag = new Map(now.map((e) => [e.tag!, e]));
  const added = now.filter((e) => !wasByTag.has(e.tag!));
  const removed = was.filter((e) => !nowByTag.has(e.tag!));
  const changes: string[] = [];
  const named = new Set<string>();
  const taken = new Set<Entry>();
  for (const r of removed) {
    const a = added.find((e) => !taken.has(e) && e.idx !== undefined && e.idx === r.idx);
    if (a) {
      taken.add(a);
      changes.push(`entry renamed: ${code(r.tag)} → ${code(a.tag)}${at(lineOf(a.tag!))}`);
      named.add(a.tag!);
    } else {
      const place = now.find((e) => e.idx !== undefined && e.idx === r.idx);
      changes.push(`entry removed: ${code(r.tag)}${place ? ` (the entry at its place: line ${lineOf(place.tag!) ?? '?'})` : ''}`);
      if (place) named.add(place.tag!);
    }
  }
  for (const a of added) {
    if (taken.has(a)) continue;
    changes.push(`entry added: ${code(a.tag)}${at(lineOf(a.tag!))}`);
    named.add(a.tag!);
  }
  for (const e of now) {
    const b = wasByTag.get(e.tag!);
    if (!b) continue;
    const diff = [b.idx !== e.idx ? `idx ${b.idx} → ${e.idx}` : '', b.when !== e.when ? `when ${b.when} → ${e.when}` : ''].filter(Boolean);
    if (diff.length) {
      changes.push(`entry ${code(e.tag)} changed: ${diff.join(', ')}${at(lineOf(e.tag!))}`);
      named.add(e.tag!);
    }
  }
  // Only an entry that the pull request adds or whose `when` it changes: an older pair of the base
  // is not a change of this pull request (Kentō #b7ee4d).
  now.forEach((e, i) => {
    const prev = now[i - 1];
    const touched = wasByTag.get(e.tag!)?.when !== e.when;
    if (touched && prev && typeof e.when === 'number' && typeof prev.when === 'number' && e.when < prev.when) {
      changes.push(`entry ${code(e.tag)}: \`when\` earlier than the entry before it, ${code(prev.tag)}${at(lineOf(e.tag!))}`);
      named.add(e.tag!);
    }
  });
  return { changes, named };
}

/** The first lines of a file that is not valid JSON, numbered, in a fence that its text cannot close. */
function rawPart(raw: string): string {
  const lines = raw.split('\n').slice(0, RAW_LINES);
  const longest = Math.max(2, ...[...raw.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const body = lines.map((line, i) => `${i + 1}: ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`).join('\n');
  return `${fence}text\n${body}\n${fence}\n`;
}

/** What a file that is not read says: removed at the head, or not valid JSON (its first lines). */
function unread(state: 'missing' | 'invalid', raw = ''): string {
  if (state === 'missing') return '- the file is removed at the head\n';
  return `- the file is not valid JSON at the head (a conflict marker or a cut can break the migrations): its first lines\n\n${rawPart(raw)}`;
}

/**
 * The snapshot that a snapshot of the head follows: the one whose `id` is its `prevId`, else the one
 * numbered before. Gives it with the lines that say which one it is, and when `prevId` matches no
 * snapshot or skips the one numbered before (two branches generated from the same snapshot).
 */
function previousSnapshot(repo: string, head: string, path: string, snapshot: Snapshot): { before: Snapshot | null; chain: string[] } {
  const folder = path.replace(/[^/]+$/, '');
  const number = Number(SNAPSHOT.exec(path)?.[2]);
  const name = (p: string) => p.slice(folder.length);
  const files = git(repo, 'ls-tree', '--name-only', head, '--', folder)
    .split('\n')
    .filter((p) => SNAPSHOT.test(p) && Number(SNAPSHOT.exec(p)?.[2]) < number)
    .sort((a, b) => Number(SNAPSHOT.exec(b)?.[2]) - Number(SNAPSHOT.exec(a)?.[2]));
  const just = files[0];
  if (!just) return { before: null, chain: [] };
  if (typeof snapshot.prevId === 'string') {
    for (const p of files) {
      const s = parsed(read<Snapshot>(repo, head, p));
      if (s?.id !== snapshot.prevId) continue;
      const chain = [`follows ${code(name(p))} (prevId ${code(snapshot.prevId)})`];
      if (p !== just) chain.push(`prevId skips ${code(name(just))}: two snapshots can follow the same one`);
      return { before: s, chain };
    }
    return { before: parsed(read<Snapshot>(repo, head, just)), chain: [`prevId ${code(snapshot.prevId)} matches no snapshot: compared with ${code(name(just))}, the one numbered before`] };
  }
  return { before: parsed(read<Snapshot>(repo, head, just)), chain: [`no prevId: compared with ${code(name(just))}, the one numbered before`] };
}

/** One part of the section: the journal of the head, with its changes and its entries. */
function journalPart(repo: string, base: string, head: string, path: string): string {
  const after = read<Journal>(repo, head, path);
  if (after.state !== 'ok') return `### ${path}\n\n${unread(after.state, after.state === 'invalid' ? after.raw : '')}\n`;
  const lines = after.raw.split('\n');
  const lineOf = (tag: string) => {
    const re = new RegExp(`"tag"\\s*:\\s*${escapeRe(JSON.stringify(tag))}`);
    const i = lines.findIndex((l) => re.test(l));
    return i < 0 ? null : i + 1;
  };
  const { changes, named } = journalChanges(parsed(read<Journal>(repo, base, path)), after.json, lineOf);
  const entries = (after.json.entries ?? []).filter((e) => typeof e?.tag === 'string');
  const shown = entries.filter((e, i) => i >= entries.length - LAST_ENTRIES || named.has(e.tag!));
  const note = shown.length < entries.length ? ` (${shown.length} of ${entries.length} entries: the last ${LAST_ENTRIES}, and the ones that a change names)` : '';
  const rows = shown.map((e) => `- line ${lineOf(e.tag!) ?? '?'}: idx ${code(e.idx ?? '?')} · tag ${code(e.tag)} · when ${code(e.when ?? '?')}\n`).join('');
  return `### ${path}\n\n${changes.map((c) => `- ${c}\n`).join('')}\nEntries${note}:\n\n${rows}\n`;
}

/** One part of the section: a snapshot of the head, against its base version or the snapshot that it follows. */
function snapshotPart(repo: string, base: string, head: string, path: string): string {
  const after = read<Snapshot>(repo, head, path);
  if (after.state !== 'ok') return `### ${path}\n\n${unread(after.state, after.state === 'invalid' ? after.raw : '')}\n`;
  const lines = after.raw.split('\n');
  const was = read<Snapshot>(repo, base, path);
  // A changed snapshot compares with its base version; a new one with the snapshot that it follows.
  const { before, chain } =
    was.state === 'missing'
      ? previousSnapshot(repo, head, path, after.json)
      : { before: parsed(was), chain: ['the base branch already holds this snapshot: the pull request edits the snapshot of a migration that may be applied'] };
  // With no snapshot before it, every table would read as added: say so instead (Kentō #efc0d6).
  const changes = before
    ? snapshotChanges(before, after.json, lines)
    : [`no earlier snapshot to compare with: the snapshot holds ${Object.keys(after.json.tables ?? {}).length} tables`];
  const all = [...chain, ...(changes.length ? changes : ['no table or column changes'])];
  return `### ${path}\n\n${all.map((c) => `- ${c}\n`).join('')}\n`;
}

/**
 * The section of the pack for the journal and the snapshots that the pull request changes: each
 * journal with the entries that it adds, removes, renames or changes, and for each snapshot the
 * tables and columns that it changes against the snapshot before it. Each change names its line in
 * the file at the head. A file that is removed or not valid JSON says so. `covered`: the paths that
 * the section shows, which « Not reviewed » no longer lists; `skipped`: the others, with the reason.
 */
export function migrationSection(repo: string, base: string, head: string, paths: readonly string[]): { section: string; covered: string[]; skipped: string[] } {
  const meta = paths.filter(isMigrationMeta);
  if (!meta.length) return { section: '', covered: [], skipped: [] };
  const parts = meta.map((path) => (JOURNAL.test(path) ? journalPart(repo, base, head, path) : snapshotPart(repo, base, head, path)));
  // Whole parts only: a cut inside a part could leave a code fence open (Kentō #d7b9c2). A part
  // that does not fit goes, and its file goes back to « Not reviewed » with that reason.
  const kept: string[] = [];
  const covered: string[] = [];
  const skipped: string[] = [];
  let size = 0;
  parts.forEach((part, i) => {
    if (size + part.length > MAX_MIGRATION_BYTES) {
      skipped.push(`${meta[i]}: more than ${MAX_MIGRATION_BYTES / 1000} kB for the section of the migrations`);
      return;
    }
    kept.push(part);
    covered.push(meta[i]!);
    size += part.length;
  });
  if (!kept.length) return { section: '', covered: [], skipped };
  const intro =
    '\n## Migrations: journal and snapshots\n\nThe journal of the migrations and a summary of each changed snapshot, which the diff ' +
    'does not show. A renamed or removed entry of the journal, or a snapshot that does not match the migrations of the ' +
    'diff, breaks the next generation or the replay of the migrations. Each line gives the line of the file at the head: ' +
    'a finding on the journal or a snapshot takes that line.\n\n';
  return { section: intro + kept.join(''), covered, skipped };
}
