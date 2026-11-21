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
// The entries of a long journal that the section shows.
const LAST_ENTRIES = 20;

/** Whether a path is the journal or a snapshot of the migrations of Drizzle. */
export function isMigrationMeta(path: string): boolean {
  return META.test(path) && /(^|\/)(drizzle|migrations?)\//.test(path);
}

type Column = { type?: string; notNull?: boolean; default?: unknown };
type Snapshot = { id?: string; prevId?: string; tables?: Record<string, { columns?: Record<string, Column> }>; _meta?: { tables?: Record<string, string>; columns?: Record<string, string> } };
type Journal = { entries?: { idx?: number; tag?: string }[] };

function read<T>(repo: string, rev: string, path: string): T | null {
  try {
    return JSON.parse(git(repo, 'show', `${rev}:${path}`)) as T;
  } catch {
    return null;
  }
}

/** The tables and columns that a snapshot adds, removes or changes against the one before. */
export function snapshotChanges(before: Snapshot | null, after: Snapshot): string[] {
  const out: string[] = [];
  const old = before?.tables ?? {};
  const now = after.tables ?? {};
  for (const name of Object.keys(now)) if (!old[name]) out.push(`table added: \`${name}\``);
  for (const name of Object.keys(old)) if (!now[name]) out.push(`table removed: \`${name}\``);
  for (const [name, table] of Object.entries(now)) {
    const was = old[name]?.columns;
    if (!was) continue;
    const cols = table.columns ?? {};
    for (const col of Object.keys(cols)) {
      if (!was[col]) out.push(`column added: \`${name}.${col}\` (${cols[col]?.type ?? '?'}${cols[col]?.notNull ? ', not null' : ''})`);
      else {
        const a = was[col]!;
        const b = cols[col]!;
        if (a.type !== b.type) out.push(`column type changed: \`${name}.${col}\` ${a.type ?? '?'} → ${b.type ?? '?'}`);
        if (Boolean(a.notNull) !== Boolean(b.notNull)) out.push(`column ${b.notNull ? 'now not null' : 'now nullable'}: \`${name}.${col}\``);
        if (JSON.stringify(a.default) !== JSON.stringify(b.default)) out.push(`column default changed: \`${name}.${col}\` ${JSON.stringify(a.default) ?? 'none'} → ${JSON.stringify(b.default) ?? 'none'}`);
      }
    }
    for (const col of Object.keys(was)) if (!cols[col]) out.push(`column removed: \`${name}.${col}\``);
  }
  // Drizzle records the renames that the person chose when the schema was generated.
  for (const [from, to] of Object.entries(after._meta?.tables ?? {})) out.push(`table renamed: \`${from}\` → \`${to}\``);
  for (const [from, to] of Object.entries(after._meta?.columns ?? {})) out.push(`column renamed: \`${from}\` → \`${to}\``);
  return out;
}

/** The tags that the journal of the head adds and removes against the base. */
function journalChanges(before: Journal | null, after: Journal): string[] {
  const was = new Set((before?.entries ?? []).map((e) => e.tag));
  const now = new Set((after.entries ?? []).map((e) => e.tag));
  return [
    ...[...now].filter((t) => t && !was.has(t)).map((t) => `entry added: \`${t}\``),
    ...[...was].filter((t) => t && !now.has(t)).map((t) => `entry removed: \`${t}\``),
  ];
}

/** The snapshot that a snapshot of the head follows: the one whose `id` is its `prevId`, else the one numbered before. */
function previousSnapshot(repo: string, head: string, path: string, snapshot: Snapshot): Snapshot | null {
  const folder = path.replace(/[^/]+$/, '');
  const number = Number(SNAPSHOT.exec(path)?.[2]);
  const files = git(repo, 'ls-tree', '--name-only', head, '--', folder)
    .split('\n')
    .filter((p) => SNAPSHOT.test(p))
    .sort();
  const before = files.filter((p) => Number(SNAPSHOT.exec(p)?.[2]) < number);
  for (const p of before.reverse()) {
    const s = read<Snapshot>(repo, head, p);
    if (s && (!snapshot.prevId || s.id === snapshot.prevId)) return s;
  }
  return null;
}

/**
 * The section of the pack for the journal and the snapshots that the pull request changes: each
 * journal whole (or its last entries), with the entries that it adds and removes, and for each
 * snapshot the tables and columns that it changes against the snapshot before it. `covered`: the
 * paths that the section shows, which « Not reviewed » no longer lists.
 */
export function migrationSection(repo: string, base: string, head: string, paths: readonly string[]): { section: string; covered: string[] } {
  const meta = paths.filter(isMigrationMeta);
  if (!meta.length) return { section: '', covered: [] };
  const parts: string[] = [];
  const covered: string[] = [];
  for (const path of meta) {
    if (JOURNAL.test(path)) {
      const after = read<Journal>(repo, head, path);
      if (!after) continue;
      const changes = journalChanges(read<Journal>(repo, base, path), after);
      const entries = after.entries ?? [];
      const shown = entries.length > LAST_ENTRIES ? { ...after, entries: entries.slice(-LAST_ENTRIES) } : after;
      const note = entries.length > LAST_ENTRIES ? ` (the last ${LAST_ENTRIES} of ${entries.length} entries)` : '';
      parts.push(`### ${path}${note}\n\n${changes.map((c) => `- ${c}\n`).join('')}\n\`\`\`json\n${JSON.stringify(shown, null, 1)}\n\`\`\`\n\n`);
      covered.push(path);
    } else {
      const after = read<Snapshot>(repo, head, path);
      if (!after) continue;
      // A changed snapshot compares with its base version; a new one with the snapshot before it.
      const before = read<Snapshot>(repo, base, path) ?? previousSnapshot(repo, head, path, after);
      const changes = snapshotChanges(before, after);
      parts.push(`### ${path}\n\n${changes.length ? changes.map((c) => `- ${c}\n`).join('') : '- no table or column changes\n'}\n`);
      covered.push(path);
    }
  }
  if (!parts.length) return { section: '', covered: [] };
  let body = parts.join('');
  if (body.length > MAX_MIGRATION_BYTES) body = `${body.slice(0, MAX_MIGRATION_BYTES)}\n… (cut)\n\n`;
  const intro =
    '\n## Migrations: journal and snapshots\n\nThe journal of the migrations and a summary of each changed snapshot, which the diff ' +
    'does not show. A renamed or removed entry of the journal, or a snapshot that does not match the migrations of the ' +
    'diff, breaks the next generation or the replay of the migrations.\n\n';
  return { section: intro + body, covered };
}
