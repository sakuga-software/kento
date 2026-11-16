// The pack: the first message of the review, with the diff, the docs of the repository and the context.
import { git } from './git.ts';
import { importsSection } from './imports.ts';
import type { ContextKind } from './levels.ts';
import { rulesForPaths, rulesSection, type PackedRule, type Rule } from './rules.ts';

// The pack that the model reads, at most. A larger pull request loses its largest files first.
const MAX_PACK_BYTES = 240_000;
const MAX_FILE_CHANGED_LINES = 1000;
const MAX_DOC_LINES = 400;
const MAX_CONTEXT_BYTES = 60_000;

const SKIP =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock)$|\.snap$|(^|\/)(dist|build|vendor|\.next|\.react-router)\/|drizzle\/migrations\/meta\/|\.gen\.[a-z]+$|\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|mp4|webm|woff2?|ttf|otf|zip|tgz)$/;
/** A file that the pack never reviews: a lock file, a snapshot, a build output, a binary. */
export const generatedFile = (path: string): boolean => SKIP.test(path);
const TEST_FILE = /\.test\.|\.spec\.|(^|\/)(tests?|__tests__)\//;

// The context: unchanged code that the change uses or that uses the change

/** The text as a literal in a regular expression, with every special character escaped. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs)$/;
const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs'];
const IMPORT = /import\s+(type\s+)?([\w*\s{},$]+?)\s+from\s+['"]([^'"]+)['"]/g;
const DECLARATION = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const MAX_SYMBOLS = 12;
const MAX_SITES = 4;
// A call site shows more lines after the match than before: the arguments and the body of a request follow it.
const LINES_BEFORE_SITE = 6;
const LINES_AFTER_SITE = 16;
const MAX_SNIPPET_LINES = 60;

type Snippet = { path: string; start: number; end: number; reason: string };

function fileAt(repo: string, head: string, path: string, cache: Map<string, string[]>): string[] {
  if (!cache.has(path)) cache.set(path, git(repo, 'show', `${head}:${path}`).split('\n'));
  return cache.get(path)!;
}

/** The lines `git grep` finds at the head, as path and line number. It gives none on no match. */
function grep(repo: string, head: string, args: string[], globs = SOURCE_GLOBS): { path: string; line: number; text: string }[] {
  let out = '';
  try {
    out = git(repo, 'grep', '-n', '-I', ...args, head, '--', ...globs);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [, path, line, text] = /^[^:]+:([^:]+):(\d+):(.*)$/.exec(row) ?? [];
      return { path, line: Number(line), text };
    })
    .filter((m) => m.path && !TEST_FILE.test(m.path));
}

/** The exported declarations of a name at the head. `git grep -E` knows POSIX classes, not `\s` or `\b`. */
function definitionsOf(repo: string, head: string, name: string) {
  const keyword = '(default[[:space:]]+)?(declare[[:space:]]+)?(async[[:space:]]+)?(function\\*?|const|let|class|type|interface|enum)';
  const pattern = `^[[:space:]]*export[[:space:]]+${keyword}[[:space:]]+${escapeRegExp(name)}([^[:alnum:]_$]|$)`;
  return grep(repo, head, ['-E', '-e', pattern]);
}

/**
 * The URL of a React Router route file under `routes/api/`, and an ERE that matches the string of a
 * request to that route only. `routes/api/radio/channels/$id/route.ts` gives `/api/radio/channels/:id`
 * and matches `/api/radio/channels/${id}`, but not `/api/radio/channels/${id}/ads`.
 */
export function apiRoute(path: string): { url: string; pattern: string } | null {
  const match = /(?:^|\/)routes\/(api\/.+)\.[jt]sx?$/.exec(path);
  if (!match) return null;
  const segments = match[1].split('/');
  if (segments.at(-1) === 'route') segments.pop();
  if (segments.length < 2 || segments.some((s) => s.startsWith('('))) return null;
  const end = '[\'"`?]';
  const pattern = segments.map((s) => (s.startsWith('$') ? '[^/\'"`]+' : s.replace(/[.^$*+?()[{|\\]/g, '\\$&'))).join('/');
  return { url: `/${segments.map((s) => (s.startsWith('$') ? `:${s.slice(1)}` : s)).join('/')}`, pattern: `/${pattern}${end}` };
}

/** The packages of the repository (`@acme/db` → `packages/db/`): their code is in it. */
function workspacePackages(repo: string, head: string): Map<string, string> {
  const packages = new Map<string, string>();
  for (const m of grep(repo, head, ['-E', '-e', '"name":[[:space:]]*"@[^/"]+/[^"]+"'], ['package.json', '*/package.json'])) {
    const name = /"name":\s*"(@[^/"]+\/[^"]+)"/.exec(m.text)?.[1];
    if (name && !packages.has(name)) packages.set(name, m.path.replace(/package\.json$/, ''));
  }
  return packages;
}

/** The names that the changed files import from the code of the repository, and that the added lines use. */
function usedImports(repo: string, base: string, head: string, paths: string[], cache: Map<string, string[]>): { name: string; from: string; path: string }[] {
  const found: { name: string; from: string; path: string }[] = [];
  const packages = workspacePackages(repo, head);
  for (const path of paths) {
    const added = git(repo, 'diff', '-U0', `${base}...${head}`, '--', path)
      .split('\n')
      .filter((row) => row.startsWith('+') && !row.startsWith('+++'))
      .join('\n');
    for (const [, , names, from] of fileAt(repo, head, path, cache).join('\n').matchAll(IMPORT)) {
      // A package of the repository resolves to its folder: `@acme/db/schema` → `packages/db/`.
      const workspace = [...packages].find(([name]) => from === name || from.startsWith(`${name}/`))?.[1];
      const local = from.startsWith('.') || from.startsWith('~') || from.startsWith('@/') || workspace !== undefined;
      if (!local) continue;
      for (const raw of names.replace(/[{}]/g, ',').split(',')) {
        const name = raw.replace(/^\s*(type\s+)?(\*\s+as\s+)?/, '').split(/\s+as\s+/).pop()!.trim();
        // Several files of a pull request import the same names: each one counts once.
        if (found.some((f) => f.name === name && f.from === from)) continue;
        if (name && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(added)) found.push({ name, from, path: workspace ?? path });
      }
    }
  }
  return found;
}

/** The exported names that the changed lines declare, or whose declaration encloses a changed line. */
function changedExports(repo: string, base: string, head: string, paths: string[]): { name: string; path: string }[] {
  const found: { name: string; path: string }[] = [];
  for (const path of paths) {
    for (const row of git(repo, 'diff', '-U0', `${base}...${head}`, '--', path).split('\n')) {
      const text = row.startsWith('@@') ? row.replace(/^@@[^@]*@@\s?/, '') : row.startsWith('+') && !row.startsWith('+++') ? row.slice(1) : '';
      const name = DECLARATION.exec(text)?.[1];
      if (name && !found.some((f) => f.name === name)) found.push({ name, path });
    }
  }
  return found;
}

// A name of a constraint or an index that the code writes in a string: `product_sku_unique`.
const SQL_NAME = /['"`]([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*_(?:unique|uniq|key|pkey|fkey|idx|index|check|excl))['"`]/g;
const SQL_GLOBS = ['*.sql', '*.prisma', ...SOURCE_GLOBS];
const MAX_SQL_NAMES = 12;

/** The SQL names that the added lines of the changed source files write, with the files that write each one. */
function addedSqlNames(repo: string, base: string, head: string, paths: string[]): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  for (const path of paths) {
    for (const row of git(repo, 'diff', '-U0', `${base}...${head}`, '--', path).split('\n')) {
      if (!row.startsWith('+') || row.startsWith('+++')) continue;
      for (const [, name] of row.matchAll(SQL_NAME)) {
        if (!names.has(name) && names.size >= MAX_SQL_NAMES) continue;
        names.set(name, (names.get(name) ?? new Set()).add(path));
      }
    }
  }
  return names;
}

/**
 * Unchanged code around the change, found with `git grep` at the head: the definitions of the
 * imported names that the change uses, the callers of the exported names that it changes, and the
 * callers of the API routes that it changes (`full` only), and where the SQL names that the change
 * writes are defined. A SQL name that no file outside the diff holds is listed as absent. The model
 * has no tool, so this is all it sees outside the diff.
 */
export function buildContext(repo: string, base: string, head: string, paths: string[], budget: number, kind: ContextKind): string {
  const atHead = new Set(git(repo, 'ls-tree', '-r', '-z', '--name-only', head, '--', ...paths).split('\0'));
  const sources = paths.filter((p) => atHead.has(p) && SOURCE_FILE.test(p) && !TEST_FILE.test(p));
  const cache = new Map<string, string[]>();
  const snippets: Snippet[] = [];
  const add = (path: string, line: number, reason: string, wholeDeclaration: boolean) => {
    if (snippets.some((s) => s.path === path && line >= s.start && line <= s.end)) return;
    const lines = fileAt(repo, head, path, cache);
    let start = Math.max(1, line - LINES_BEFORE_SITE);
    let end = Math.min(lines.length, line + LINES_AFTER_SITE);
    if (wholeDeclaration) {
      start = line;
      end = line;
      // A declaration ends at the next line that starts at column 0 and is not a closing bracket.
      while (end < lines.length && end - start < MAX_SNIPPET_LINES && !(end > start && /^[^\s})\]]/.test(lines[end]))) end++;
    }
    // Two sites a few lines apart in one file make one snippet, not two that repeat lines.
    const near = snippets.find((s) => s.path === path && start <= s.end + 1 && end >= s.start - 1);
    if (near && Math.max(end, near.end) - Math.min(start, near.start) < MAX_SNIPPET_LINES) {
      near.start = Math.min(start, near.start);
      near.end = Math.max(end, near.end);
      return;
    }
    snippets.push({ path, start, end, reason });
  };
  const absent: string[] = [];

  for (const [name, writers] of addedSqlNames(repo, base, head, sources)) {
    const sites = grep(repo, head, ['-F', '-w', '-e', name], SQL_GLOBS).filter((m) => !writers.has(m.path));
    // A migration says best what the name is: it comes before a mention in the code. A file of the
    // diff that holds the name (a migration of this pull request) is in the diff already.
    const outside = sites.filter((m) => !paths.includes(m.path));
    const best = outside.find((m) => m.path.endsWith('.sql')) ?? outside[0];
    if (best) add(best.path, best.line, `definition of \`${name}\`, which the PR writes`, false);
    else if (!sites.length) absent.push(name);
  }

  for (const path of kind === 'full' ? sources : []) {
    const route = apiRoute(path);
    if (!route) continue;
    // A path to a route file (`routes/api/x/route.ts'`) looks like a request to it.
    const sites = grep(repo, head, ['-E', '-e', route.pattern]).filter((m) => !paths.includes(m.path) && !m.text.includes('routes/api/'));
    for (const site of sites.slice(0, MAX_SITES)) {
      add(site.path, site.line, `call of the route \`${route.url}\`, which the PR changes`, false);
    }
  }

  for (const { name } of kind === 'full' ? changedExports(repo, base, head, sources).slice(0, MAX_SYMBOLS) : []) {
    // A name that several files export (`loader`, `action`, `default`) has callers that a grep cannot tell apart.
    if (new Set(definitionsOf(repo, head, name).map((d) => d.path)).size > 1) continue;
    // A caller in a file of the diff is in the diff already.
    const sites = grep(repo, head, ['-w', '-e', name]).filter((m) => !paths.includes(m.path) && !/^\s*(import|export\s+\{|export\s+\*)/.test(m.text));
    for (const site of sites.slice(0, MAX_SITES)) add(site.path, site.line, `call of \`${name}\`, which the PR changes`, false);
  }

  for (const { name, from, path } of usedImports(repo, base, head, sources, cache).slice(0, MAX_SYMBOLS)) {
    const moduleName = from.split('/').pop()!;
    // `path` is the importing file, or the folder of a package of the repository (it ends with `/`).
    const root = path.endsWith('/') ? path : `${path.split('/').slice(0, 2).join('/')}/`;
    // Without the resolution of the bundler: an import stays in its app or its package, and the file
    // named as the module comes first.
    const named = new RegExp(`/${escapeRegExp(moduleName)}(/index)?\\.[a-z]+$`);
    const best = definitionsOf(repo, head, name)
      .filter((d) => d.path.startsWith(root))
      .sort((a, b) => Number(named.test(b.path)) - Number(named.test(a.path)))[0];
    if (best && !sources.includes(best.path)) add(best.path, best.line, `definition of \`${name}\`, which the PR uses`, true);
  }

  const parts: string[] = [];
  let size = 0;
  if (absent.length) {
    const note =
      `### SQL names that no other file holds\n\n${absent.map((n) => `- \`${n}\``).join('\n')}\n\n` +
      'No migration, schema or code of the repository, in the diff or outside it, defines or mentions these names at the head.\n\n';
    parts.push(note);
    size += note.length;
  }
  for (const s of snippets) {
    const lines = fileAt(repo, head, s.path, cache).slice(s.start - 1, s.end);
    const text = `### ${s.path}:${s.start}-${s.end} · ${s.reason}\n\n\`\`\`\n${lines.map((l, i) => `${s.start + i}| ${l}`).join('\n')}\n\`\`\`\n\n`;
    if (size + text.length > budget) break;
    parts.push(text);
    size += text.length;
  }
  return parts.join('');
}

// The pack

/**
 * The changed files with their counts of added and removed lines (`-` for a binary file). Without
 * `-z`, git writes a rename as `dir/{a => b}/file.ts`, which no git command takes as a path.
 */
function numstat(repo: string, base: string, head: string): { added: string; removed: string; path: string; from?: string }[] {
  const fields = git(repo, 'diff', '--numstat', '-z', `${base}...${head}`).split('\0');
  const rows: { added: string; removed: string; path: string; from?: string }[] = [];
  for (let i = 0; i < fields.length && fields[i]; i++) {
    const [added, removed, ...rest] = fields[i].split('\t');
    // A path can hold a tab: with -z, git writes it as is.
    const path = rest.join('\t');
    if (path) rows.push({ added, removed, path });
    else rows.push({ added, removed, from: fields[++i], path: fields[++i] });
  }
  return rows;
}

/**
 * The first message of the review, the files left out with their reason, and the rules that it holds
 * (REV-19): the rules of the caller whose paths a changed file matches. `body` is the pack after its
 * first part (the heads and the commits).
 */
export function buildPack(
  repo: string,
  base: string,
  head: string,
  contextKind: ContextKind,
  rules: readonly Rule[] = [],
  /** REV-71. The section of the answered threads (answered.ts), after the rules. */
  answered = '',
  /** REV-88. The only files that the pack reads, of those that changed: an incremental review. */
  only?: readonly string[],
  /**
   * REV-99. A section after `answered` that the model reads but `body` leaves out: the earlier
   * findings, which every review changes. In `body`, they would give each head a new reuse key. It
   * stays out of the budget of the diff too, so that it never changes which hunks the body holds:
   * the pack can then pass MAX_PACK_BYTES by its size, which the caps of its parts bound
   * (MAX_EARLIER_BYTES, and MAX_CHANGED_ZONES_BYTES of REV-100).
   */
  unkeyed = '',
): { pack: string; skipped: string[]; rules: PackedRule[]; body: string } {
  const reviewed: string[] = [];
  const skipped: string[] = [];
  // The old path of each renamed file: the diff of a rename needs both paths.
  const renamedFrom = new Map<string, string>();
  const keep = only ? new Set(only) : null;
  const changes = numstat(repo, base, head).filter(({ path, from }) => !keep || keep.has(path) || (from !== undefined && keep.has(from)));
  // A rule covers a file of the change, even one that the pack leaves out, and the old path of a rename.
  const touched = changes.flatMap(({ path, from }) => (from ? [from, path] : [path]));
  const { section: rulesText, packed, skipped: rulesSkipped } = rulesSection(rulesForPaths(rules, touched));
  for (const { added, removed, path, from } of changes) {
    if (SKIP.test(path)) skipped.push(`${path}: generated or binary file`);
    else if (added !== '-' && Number(added) + Number(removed) > MAX_FILE_CHANGED_LINES)
      skipped.push(`${path}: more than ${MAX_FILE_CHANGED_LINES} changed lines`);
    else reviewed.push(path);
    if (from) renamedFrom.set(path, from);
  }

  const hunks = new Map<string, string>();
  for (const path of reviewed) {
    const paths = renamedFrom.has(path) ? [renamedFrom.get(path)!, path] : [path];
    hunks.set(path, git(repo, 'diff', TEST_FILE.test(path) ? '-U3' : '-W', `${base}...${head}`, '--', ...paths));
  }

  let docs = '';
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    if (!git(repo, 'ls-tree', '--name-only', head, '--', doc).trim()) continue;
    const text = git(repo, 'show', `${head}:${doc}`);
    if (text.split('\n').length <= MAX_DOC_LINES) docs += `## ${doc}\n\n${text}\n\n`;
  }

  // REV-70. The imports of each changed file at the head: a hunk rarely shows the top of its file.
  // Without a path, `git ls-tree` lists the whole repository. Without `-z`, it quotes a path that is not ASCII.
  const atHead = new Set(reviewed.length ? git(repo, 'ls-tree', '-r', '-z', '--name-only', head, '--', ...reviewed).split('\0') : []);
  const headLines = (path: string) => (atHead.has(path) ? git(repo, 'show', `${head}:${path}`).split('\n') : null);
  const importsOf = new Map(reviewed.map((path) => [path, importsSection([path], headLines)]));
  const importsSize = [...importsOf.values()].reduce((sum, text) => sum + text.length, 0);

  const commits = git(repo, 'log', '--format=- %h %s', `${base}..${head}`);
  const budget = MAX_PACK_BYTES - docs.length - rulesText.length - answered.length - commits.length - importsSize - 2000;
  const size = () => [...hunks.values()].reduce((sum, hunk) => sum + hunk.length, 0);
  // Drop the largest diffs first: the small ones are where most of the logic of a change sits.
  for (const [path] of [...hunks].sort((a, b) => b[1].length - a[1].length)) {
    if (size() <= budget) break;
    skipped.push(`${path}: removed to fit in the maximum size of the review`);
    hunks.delete(path);
  }

  const parts = [`# Pull request ${base.slice(0, 9)}...${head.slice(0, 9)}\n\n## Commits\n\n${commits}\n`];
  if (skipped.length) parts.push(`## Not reviewed\n\n${skipped.map((s) => `- ${s}\n`).join('')}\n`);
  parts.push(docs);
  parts.push(rulesText);
  parts.push(answered);
  const unkeyedAt = parts.push(unkeyed) - 1;
  parts.push(
    '## Diff\n\nEach hunk of a source file shows the whole function around the change. ' +
      'A test file shows three lines of context.\n\n```diff\n',
  );
  for (const path of reviewed) if (hunks.has(path)) parts.push(hunks.get(path)!);
  parts.push('```\n');
  const imports = [...hunks.keys()].map((path) => importsOf.get(path) ?? '').join('');
  if (imports) {
    parts.push(
      '\n## Imports\n\nThe import statements of each changed file at the head of the pull request, whole, ' +
        'with their line numbers. The diff can show only part of them.\n\n',
      imports,
    );
  }
  const room = Math.min(MAX_CONTEXT_BYTES, budget - size());
  const context = room > 0 ? buildContext(repo, base, head, [...hunks.keys()], room, contextKind) : '';
  if (context) {
    parts.push(
      '\n## Context\n\nUnchanged code at the head of the pull request, from other files: definitions that the ' +
        (contextKind === 'full' ? 'change uses, and callers of the code that it changes. ' : 'change uses. ') +
        'Each line starts with its line number. The repository holds more code than this.\n\n',
      context,
    );
  }
  // REV-89. `body`: the pack without its heads and its commits, which a merge of the base branch
  // changes. The reuse key reads it (reuse.ts).
  return { pack: parts.join(''), skipped: [...skipped, ...rulesSkipped], rules: packed, body: parts.filter((_, i) => i > 0 && i !== unkeyedAt).join('') };
}
