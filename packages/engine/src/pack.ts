// The pack: the first message of the review, with the diff, the docs of the repository and the context.
import { createHash } from 'node:crypto';
import { git } from './git.ts';
import { importsSection } from './imports.ts';
import type { ContextKind } from './levels.ts';
import type { MessagePart } from './providers.ts';
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
// A GitHub workflow or a composite action, which the diff shows whole.
const WORKFLOW_FILE = /^\.github\/(workflows\/[^/]+|actions\/.+\/action)\.ya?ml$/;
const WHOLE_FILE_CONTEXT = 100_000;

/**
 * KNT-166. The value of a changed file for the review, when the pack must cut: the lowest goes first.
 * The schema, the migrations and the storage come last: on a large pull request, the defects and the
 * code that refutes a wrong finding were there.
 */
export const TRIM_RANK = { generated: 0, docs: 1, tests: 2, ui: 3, source: 4, core: 5 } as const;
const GENERATED_LIKE = /\.min\.(js|css)$|\.map$|(^|\/)public\/(assets|build)\/|(^|\/)(fixtures?|__fixtures__|testdata)\//;
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc|txt)$|(^|\/)docs?\//i;
const E2E_FILE = /(^|\/)e2e\//;
const UI_FILE = /\.(css|scss|sass|less|html|vue|svelte)$|(^|\/)(ui|components?|views?|pages?|styles?)\/.*\.(tsx|jsx)$/;
const CORE_FILE = /\.(sql|prisma)$|(^|\/)(migrations?|drizzle|prisma)\/|(^|\/)schema\.[a-z]+$|(^|\/)(db|database)\/|(^|[/-])(store|stores|repository|repositories|dao)(\.[a-z]+$|\/)/;
export function trimRank(path: string): number {
  if (GENERATED_LIKE.test(path)) return TRIM_RANK.generated;
  if (DOC_FILE.test(path)) return TRIM_RANK.docs;
  if (TEST_FILE.test(path) || E2E_FILE.test(path)) return TRIM_RANK.tests;
  if (CORE_FILE.test(path)) return TRIM_RANK.core;
  if (UI_FILE.test(path)) return TRIM_RANK.ui;
  return TRIM_RANK.source;
}

/** KNT-166. The changed files, and those that the review did not read or read with less context. */
export type Coverage = { files: number; cut: string[]; narrowed: string[] };

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

// KNT-151. What a premise of a finding most often needs: the functions that the change calls, the
// tables that it reads or writes, and the code that a changed test runs.

const MAX_CALLEES = 12;
const MAX_TABLES = 6;
const MAX_TEST_ROUTES = 4;
// A route that a test requests is the code under test: its loader or action can pass 60 lines.
const MAX_ROUTE_LINES = 150;
// The most names of tables that the added lines can give. The names of SQL keywords and of English
// words (`from the`) give no table, but each costs a place in one grep.
const MAX_TABLE_CANDIDATES = 40;

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'super', 'import', 'require',
  'yield', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'case', 'throw', 'with', 'constructor', 'async',
]);
// Methods of the built-ins and of common libraries. Through an object that the file does not import,
// a definition of one of these names in the repository is rarely the one that the code calls.
const COMMON_METHODS = new Set([
  'get', 'set', 'has', 'add', 'delete', 'map', 'filter', 'find', 'findIndex', 'some', 'every', 'reduce', 'forEach', 'push',
  'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'split', 'includes', 'indexOf', 'keys', 'values',
  'entries', 'then', 'catch', 'finally', 'json', 'text', 'send', 'log', 'warn', 'error', 'info', 'debug', 'toString',
  'trim', 'replace', 'replaceAll', 'match', 'matchAll', 'test', 'exec', 'parse', 'stringify', 'assign', 'from', 'of',
  'call', 'apply', 'bind', 'resolve', 'reject', 'all', 'allSettled', 'race', 'emit', 'on', 'once', 'off', 'sort', 'at',
  'flat', 'flatMap', 'fill', 'startsWith', 'endsWith', 'padStart', 'padEnd', 'toFixed', 'toISOString', 'getTime', 'now',
  'max', 'min', 'floor', 'ceil', 'round', 'abs', 'next', 'write', 'end', 'close', 'open', 'read', 'listen', 'use', 'clear',
  'isArray', 'toLowerCase', 'toUpperCase', 'charAt', 'search', 'reverse', 'freeze', 'create', 'select', 'where', 'insert',
  'update', 'returning', 'execute', 'run', 'query', 'append', 'fetch', 'render', 'expect', 'describe', 'it',
]);

const IDENT = '[A-Za-z_$][\\w$]*';
// A call: `name(`, `obj.name(`, `obj?.name(`, `name<T>(`.
const CALL = new RegExp(`(?:(${IDENT})\\s*\\??\\.\\s*)?(${IDENT})\\s*(?:<[^()<>;]*>)?\\s*\\(`, 'g');

/** The lines of the head that a diff shows, from the heads of its hunks. */
function shownRanges(diff: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const [, start, count] of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const first = Number(start);
    const n = count === undefined ? 1 : Number(count);
    if (n > 0) ranges.push([first, first + n - 1]);
  }
  return ranges;
}

/** The added lines of the diff of a file, without their `+`. */
function addedLines(repo: string, base: string, head: string, path: string): string {
  return git(repo, 'diff', '-U0', `${base}...${head}`, '--', path)
    .split('\n')
    .filter((row) => row.startsWith('+') && !row.startsWith('+++'))
    .map((row) => row.slice(1))
    .join('\n');
}

/**
 * The line (from 1) of a declaration of `name` in a file, or 0: a function, a variable, or with
 * `member`, a method or a property of a class or an object literal.
 */
function declarationLine(lines: string[], name: string, member: boolean): number {
  const n = escapeRegExp(name);
  const forms = [
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\*?\\s+${n}\\s*[<(]`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=`),
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`),
  ];
  if (member) {
    // `async name(a) {`, `static name(`, `name: async (a) =>`, `name = (a) =>`: never a call statement
    // (`name(a);`) nor a call with an object (`name({`).
    forms.push(new RegExp(`^\\s+(?:(?:public|private|protected|static|async|override|get|set)\\s+)*\\*?${n}\\s*(?:<[^>]*>)?\\s*\\((?:[^;]*\\)\\s*(?::[^;{]+)?\\{|[^;)]*,?)\\s*$`));
    forms.push(new RegExp(`^\\s+${n}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\([^;]*=>|${IDENT}\\s*=>)`));
  }
  const index = lines.findIndex((line) => !/\(\{\s*$/.test(line) && forms.some((form) => form.test(line)));
  return index + 1;
}

/** The files that an import resolves to at the head, best first: relative, `~/`, `@/`, or a package. */
function moduleFiles(from: string, importer: string, packages: Map<string, string>, files: Set<string>): string[] {
  const bases: string[] = [];
  const dir = importer.split('/').slice(0, -1);
  if (from.startsWith('.')) {
    const parts = [...dir];
    for (const segment of from.split('/')) {
      if (segment === '..') parts.pop();
      else if (segment !== '.') parts.push(segment);
    }
    bases.push(parts.join('/'));
  } else if (from.startsWith('~/') || from.startsWith('@/')) {
    // Without the configuration of the bundler: the alias is a folder above the importing file, or
    // its `app/` or `src/`.
    for (let i = dir.length; i >= 0; i--) {
      const root = dir.slice(0, i).join('/');
      for (const sub of ['', 'app/', 'src/']) bases.push(`${root ? `${root}/` : ''}${sub}${from.slice(2)}`);
    }
  } else {
    const [name, folder] = [...packages].find(([pkg]) => from === pkg || from.startsWith(`${pkg}/`)) ?? [];
    if (name === undefined || folder === undefined) return [];
    const rest = from.slice(name.length).replace(/^\//, '');
    bases.push(...(rest ? [`${folder}src/${rest}`, `${folder}${rest}`] : [`${folder}src/index`, `${folder}index`]));
  }
  const found: string[] = [];
  for (const b of bases) {
    const stem = b.replace(/\.(js|jsx|mjs|ts|tsx)$/, '');
    for (const candidate of [b, ...['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'].map((ext) => stem + ext)]) {
      if (files.has(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** The local names that a file imports from the code of the repository, with their module. */
function localImports(text: string, packages: Map<string, string>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [, , list, from] of text.matchAll(IMPORT)) {
    const workspace = [...packages.keys()].some((name) => from === name || from.startsWith(`${name}/`));
    if (!(from.startsWith('.') || from.startsWith('~/') || from.startsWith('@/') || workspace)) continue;
    for (const raw of list.replace(/[{}]/g, ',').split(',')) {
      const name = raw.replace(/^\s*(type\s+)?(\*\s+as\s+)?/, '').split(/\s+as\s+/).pop()!.trim();
      if (name) names.set(name, from);
    }
  }
  return names;
}

type Site = { path: string; line: number; reason: string; maxLines?: number };

/**
 * The definitions of the functions that the added lines of a file call: in the same file (`name(`,
 * `this.name(`), in the module of an imported object (`service.name(`), or for another object, the
 * only file of the repository that declares a method of that name. An imported name called bare is
 * the work of `usedImports`.
 */
function callees(
  repo: string,
  head: string,
  path: string,
  added: string,
  cache: Map<string, string[]>,
  packages: Map<string, string>,
  files: Set<string>,
): Site[] {
  const lines = fileAt(repo, head, path, cache);
  const imports = localImports(lines.join('\n'), packages);
  const sites: Site[] = [];
  const seen = new Set<string>();
  for (const m of added.matchAll(CALL)) {
    const [, object, name] = m;
    const before = added.slice(0, m.index).trimEnd();
    // `).name(` or `].name(`: a method of a value that the line computes, `?` as its object.
    const owner = object ?? (before.endsWith('.') ? '?' : undefined);
    if (KEYWORDS.has(name) || /\bfunction\s*\*?\s*$/.test(before) || seen.has(`${owner}.${name}`)) continue;
    seen.add(`${owner}.${name}`);
    const reason = `definition of \`${owner && owner !== '?' ? `${owner}.` : ''}${name}\`, which the PR calls`;
    if (owner === undefined || owner === 'this') {
      if (owner === undefined && imports.has(name)) continue;
      const line = declarationLine(lines, name, owner === 'this');
      if (line) sites.push({ path, line, reason });
    } else if (imports.has(owner)) {
      for (const file of moduleFiles(imports.get(owner)!, path, packages, files)) {
        const line = declarationLine(fileAt(repo, head, file, cache), name, true);
        if (line) {
          sites.push({ path: file, line, reason });
          break;
        }
      }
    } else if (!COMMON_METHODS.has(name) && name.length > 3) {
      const n = escapeRegExp(name);
      const pattern = `^[[:space:]]+((public|private|protected|static|async|override)[[:space:]]+)*${n}[[:space:]]*(<[^>]*>)?[[:space:]]*\\(|^[[:space:]]+${n}[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?(function|\\()|^[[:space:]]*export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+${n}[^[:alnum:]_$]`;
      const declared = grep(repo, head, ['-E', '-e', pattern]).filter((d) => declarationLine([d.text], name, true) === 1 && /[{(]\s*$/.test(d.text));
      // Only a declaration that opens a body: a member of a type (`href: (page: number) => string`)
      // has the same shape on one line. A name that several files declare: a grep cannot tell which
      // one the object is.
      if (new Set(declared.map((d) => d.path)).size === 1) sites.push({ path: declared[0].path, line: declared[0].line, reason });
    }
    // The diff can show some of them: the caller keeps the first MAX_CALLEES that it does not.
    if (sites.length >= MAX_CALLEES * 3) break;
  }
  return sites;
}

// The names of tables in the added lines: SQL (`from users`, `insert into "users"`), a query builder
// (`selectFrom('users')`), Drizzle (`.from(users)`, `db.insert(users)`), Prisma (`prisma.user.find…`).
const SQL_TABLE = /\b(?:from|join|into|update|table)\s+(?:only\s+|if\s+(?:not\s+)?exists\s+)?["`]?(?:[A-Za-z_]\w*["`]?\.["`]?)?([A-Za-z_]\w*)/gi;
const BUILDER_TABLE = /\.(?:selectFrom|insertInto|updateTable|deleteFrom|table)\s*\(\s*['"`]([A-Za-z_]\w*)/g;
const ORM_TABLE = /\b(?:from|insert|update|delete|join|innerJoin|leftJoin|rightJoin|fullJoin|crossJoin)\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
const PRISMA_MODEL = /\b(?:prisma|db|tx)\.([a-z]\w*)\.(?:find\w*|create\w*|update\w*|delete\w*|upsert|count|aggregate|groupBy)\s*\(/g;
// Words after `from`, `into` or `update` in code and comments that are rarely a table.
const NOT_TABLES = new Set(['the', 'a', 'an', 'this', 'that', 'it', 'its', 'which', 'where', 'each', 'one', 'all', 'any', 'them', 'there', 'here', 'now', 'then', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'and', 'or', 'not', 'is', 'be', 'select', 'values', 'set', 'json', 'string', 'number', 'object', 'array', 'null', 'undefined', 'true', 'false']);
// A table of Drizzle: `export const users = pgTable('users', {`, the name on this line or the next.
const TABLE_DECLARATION = `(const|let|var)[[:space:]]+[A-Za-z_$][[:alnum:]_$]*[[:space:]]*=[[:space:]]*[A-Za-z]*Table[[:space:]]*\\(`;

/**
 * The definition of each table that the added lines read or write: its declaration in a schema file
 * (Drizzle or Prisma), the migration that creates it, and the last migration that alters it.
 */
function tableDefinitions(repo: string, head: string, added: string, cache: Map<string, string[]>): Site[] {
  // The Drizzle tables of the repository, by the name of their variable and by their SQL name.
  const declared = grep(repo, head, ['-E', '-e', TABLE_DECLARATION]).map((d) => {
    const lines = fileAt(repo, head, d.path, cache);
    const text = `${lines[d.line - 1]}\n${lines[d.line] ?? ''}`;
    const variable = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(text)?.[1] ?? '';
    const sql = /Table\s*\(\s*['"`]([^'"`]+)['"`]/.exec(text)?.[1] ?? '';
    return { ...d, variable, sql };
  });
  const names = new Set<string>();
  const keep = (name: string) => {
    if (names.size < MAX_TABLE_CANDIDATES && /^[A-Za-z_]\w*$/.test(name) && !NOT_TABLES.has(name.toLowerCase())) names.add(name);
  };
  for (const [, name] of added.matchAll(SQL_TABLE)) keep(name);
  for (const [, name] of added.matchAll(BUILDER_TABLE)) keep(name);
  for (const [, name] of added.matchAll(ORM_TABLE)) {
    const table = declared.find((d) => d.variable === name);
    if (table?.sql) keep(table.sql);
  }
  const models = new Set([...added.matchAll(PRISMA_MODEL)].map(([, model]) => model));
  if (!names.size && !models.size) return [];

  const sites: Site[] = [];
  const found = new Set<string>();
  const list = [...names].map(escapeRegExp).join('|');
  const quoted = '["`]?';
  const qualified = `(${quoted}[[:alnum:]_]+${quoted}\\.)?`;
  const after = '([^[:alnum:]_]|$)';
  const migrations = (verb: string, table: RegExp) =>
    list
      ? grep(repo, head, ['-i', '-E', '-e', `${verb}[[:space:]]+${qualified}${quoted}(${list})${quoted}${after}`], SQL_GLOBS)
          .map((m) => ({ ...m, table: table.exec(m.text)?.[1]?.toLowerCase() ?? '' }))
          .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
      : [];
  const creates = migrations('create[[:space:]]+table([[:space:]]+if[[:space:]]+not[[:space:]]+exists)?', /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:["`]?\w+["`]?\.)?["`]?(\w+)/i);
  const alters = migrations('alter[[:space:]]+table([[:space:]]+if[[:space:]]+exists)?([[:space:]]+only)?', /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:["`]?\w+["`]?\.)?["`]?(\w+)/i);
  for (const name of names) {
    const lower = name.toLowerCase();
    const schema = declared.find((d) => d.sql.toLowerCase() === lower);
    const create = creates.find((m) => m.table === lower);
    const lastAlter = alters.filter((m) => m.table === lower).at(-1);
    if (!schema && !create) continue;
    found.add(lower);
    if (schema) sites.push({ path: schema.path, line: schema.line, reason: `table \`${name}\`, which the PR reads or writes` });
    if (create) sites.push({ path: create.path, line: create.line, reason: `migration that creates the table \`${name}\`` });
    if (lastAlter && lastAlter.path !== create?.path) {
      // The statements of that migration on the table, a few lines apart, make one snippet.
      for (const m of alters.filter((a) => a.path === lastAlter.path && a.table === lower).slice(0, 8)) {
        sites.push({ path: m.path, line: m.line, reason: `last migration that alters the table \`${name}\`` });
      }
    }
    if (found.size >= MAX_TABLES) break;
  }
  if (models.size && found.size < MAX_TABLES) {
    for (const model of models) {
      const upper = model[0].toUpperCase() + model.slice(1);
      const row = grep(repo, head, ['-E', '-e', `^model[[:space:]]+${escapeRegExp(upper)}[[:space:]]*\\{`], ['*.prisma'])[0];
      if (row) sites.push({ path: row.path, line: row.line, reason: `model \`${upper}\`, which the PR reads or writes`, maxLines: MAX_ROUTE_LINES });
    }
  }
  return sites;
}

/**
 * The routes that a changed test requests: the reverse of `apiRoute`. Each route file gives its
 * exported declarations, whole, up to MAX_ROUTE_LINES each.
 */
function testedRoutes(repo: string, head: string, tests: string[], files: Set<string>, cache: Map<string, string[]>): Site[] {
  const routes = [...files].flatMap((path) => {
    const route = apiRoute(path);
    return route && SOURCE_FILE.test(path) && !TEST_FILE.test(path) ? [{ path, ...route, regexp: new RegExp(route.pattern) }] : [];
  });
  const sites: Site[] = [];
  const taken = new Set<string>();
  for (const test of tests) {
    const text = fileAt(repo, head, test, cache).join('\n');
    for (const route of routes) {
      if (taken.has(route.path) || !route.regexp.test(text)) continue;
      taken.add(route.path);
      const lines = fileAt(repo, head, route.path, cache);
      lines.forEach((line, i) => {
        if (DECLARATION.test(line)) sites.push({ path: route.path, line: i + 1, reason: `route \`${route.url}\`, which a changed test requests`, maxLines: MAX_ROUTE_LINES });
      });
      if (taken.size >= MAX_TEST_ROUTES) return sites;
    }
  }
  return sites;
}

/**
 * Unchanged code around the change, found with `git grep` at the head. In the order of the budget:
 * - where the SQL names that the change writes are defined; a SQL name that no file outside the diff
 *   holds is listed as absent;
 * - the definition of each table that the change reads or writes (KNT-151);
 * - the definitions of the functions that the change calls in its own file or through an object
 *   (KNT-151), and of the imported names that it uses;
 * - for a changed test, the definitions that it imports and the routes that it requests (KNT-151);
 * - at `full` only: the callers of the API routes and of the exported names that the change modifies.
 * A snippet that the diff shows already is left out. The model has no tool, so this is all it sees
 * outside the diff.
 */
export function buildContext(
  repo: string,
  base: string,
  head: string,
  paths: string[],
  budget: number,
  kind: ContextKind,
  /** The diff that the pack shows for each path: a snippet inside it is left out. */
  diffs: ReadonlyMap<string, string> = new Map(),
): string {
  const files = new Set(git(repo, 'ls-tree', '-r', '-z', '--name-only', head).split('\0').filter(Boolean));
  const atHead = paths.filter((p) => files.has(p));
  const sources = atHead.filter((p) => SOURCE_FILE.test(p) && !TEST_FILE.test(p));
  const tests = atHead.filter((p) => SOURCE_FILE.test(p) && TEST_FILE.test(p));
  const sqlFiles = atHead.filter((p) => /\.sql$/.test(p));
  const shown = new Map([...diffs].map(([path, diff]) => [path, shownRanges(diff)]));
  const isShown = (path: string, line: number) => (shown.get(path) ?? []).some(([start, end]) => line >= start && line <= end);
  const cache = new Map<string, string[]>();
  const packages = workspacePackages(repo, head);
  const added = new Map([...sources, ...sqlFiles].map((p) => [p, addedLines(repo, base, head, p)]));
  const snippets: Snippet[] = [];
  const add = (path: string, line: number, reason: string, wholeDeclaration: boolean, maxLines = MAX_SNIPPET_LINES) => {
    if (isShown(path, line)) return;
    if (snippets.some((s) => s.path === path && line >= s.start && line <= s.end)) return;
    const lines = fileAt(repo, head, path, cache);
    let start = Math.max(1, line - LINES_BEFORE_SITE);
    let end = Math.min(lines.length, line + LINES_AFTER_SITE);
    if (wholeDeclaration) {
      start = line;
      end = line;
      // A declaration ends at the line that closes it at its own indent, or at the next line that
      // starts at column 0 and is not a closing bracket.
      const first = lines[line - 1] ?? '';
      const indent = /^\s*/.exec(first)![0].length;
      // A member on one line (`name: (a) => a + 1,`) ends on that line.
      const opens = indent === 0 || /[{([=>,]\s*$/.test(first);
      while (opens && end < lines.length && end - start < maxLines) {
        const next = lines[end];
        if (indent === 0 && end > start && /^[^\s})\]]/.test(next)) break;
        end++;
        if (indent > 0 && /^\s*[})\]]/.test(next) && /^\s*/.exec(next)![0].length === indent) break;
        if (indent > 0 && next.trim() && /^\s*/.exec(next)![0].length < indent) {
          end--;
          break;
        }
      }
    }
    while (wholeDeclaration && end > start && !lines[end - 1]!.trim()) end--;
    // Two sites a few lines apart in one file make one snippet, not two that repeat lines.
    const near = snippets.find((s) => s.path === path && start <= s.end + 3 && end >= s.start - 3);
    if (near && Math.max(end, near.end) - Math.min(start, near.start) < Math.max(maxLines, MAX_SNIPPET_LINES)) {
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

  for (const site of tableDefinitions(repo, head, [...added.values()].join('\n'), cache)) {
    add(site.path, site.line, site.reason, true, site.maxLines);
  }

  const calls = sources.flatMap((path) => callees(repo, head, path, added.get(path) ?? '', cache, packages, files));
  for (const site of calls.filter((c) => !isShown(c.path, c.line)).slice(0, MAX_CALLEES)) add(site.path, site.line, site.reason, true, site.maxLines);

  const definitions = (importers: string[]) => {
    for (const { name, from, path } of usedImports(repo, base, head, importers, cache).slice(0, MAX_SYMBOLS)) {
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
  };
  definitions(sources);
  // A changed test: the code that it imports, then the routes that it requests.
  definitions(tests);
  for (const site of testedRoutes(repo, head, tests, files, cache)) add(site.path, site.line, site.reason, true, site.maxLines);

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
    // A snippet too large for what is left gives its place to the smaller ones after it.
    if (size + text.length > budget) continue;
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
 * (REV-19): the rules of the caller whose paths a changed file matches. `parts` is the pack in the
 * parts that a prompt cache can mark (REV-113). `body` is the pack without the heads and the commits.
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
): {
  pack: string;
  parts: MessagePart[];
  skipped: string[];
  rules: PackedRule[];
  body: string;
  contextHash: string;
  /** KNT-166. What the pack read of the changed files: the review says it, and its score follows it. */
  coverage: Coverage;
} {
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
    // KNT-151. A workflow is one file of steps that read each other: its diff shows it whole.
    const context = WORKFLOW_FILE.test(path) ? `-U${WHOLE_FILE_CONTEXT}` : TEST_FILE.test(path) ? '-U3' : '-W';
    hunks.set(path, git(repo, 'diff', context, `${base}...${head}`, '--', ...paths));
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
  // KNT-166. Over the budget, the files of least value go first, the largest first in each rank:
  // generated-like files and docs are dropped; then the source files lose the whole function around
  // each hunk and keep three lines of context, the core last; then the tests, the UI, the source and
  // the core are dropped, in this order.
  const byRank = (ranks: number[]) =>
    [...hunks]
      .filter(([path]) => ranks.includes(trimRank(path)))
      .sort((a, b) => trimRank(a[0]) - trimRank(b[0]) || b[1].length - a[1].length)
      .map(([path]) => path);
  const cut: string[] = [];
  const narrowed: string[] = [];
  const whole = new Map<string, string>();
  const drop = (path: string) => {
    skipped.push(`${path}: removed to fit in the maximum size of the review`);
    cut.push(path);
    hunks.delete(path);
  };
  for (const path of byRank([TRIM_RANK.generated, TRIM_RANK.docs])) {
    if (size() <= budget) break;
    drop(path);
  }
  for (const path of byRank([TRIM_RANK.ui, TRIM_RANK.source, TRIM_RANK.core])) {
    if (size() <= budget) break;
    if (WORKFLOW_FILE.test(path) || TEST_FILE.test(path)) continue;
    const paths = renamedFrom.has(path) ? [renamedFrom.get(path)!, path] : [path];
    const smaller = git(repo, 'diff', '-U3', `${base}...${head}`, '--', ...paths);
    if (smaller.length < hunks.get(path)!.length) {
      whole.set(path, hunks.get(path)!);
      hunks.set(path, smaller);
      narrowed.push(path);
    }
  }
  for (const path of byRank([TRIM_RANK.tests, TRIM_RANK.ui, TRIM_RANK.source, TRIM_RANK.core])) {
    if (size() <= budget) break;
    drop(path);
  }
  // The drops can leave room: the core files get their whole functions back first, the smallest first.
  for (const path of narrowed.filter((p) => hunks.has(p)).sort((a, b) => trimRank(b) - trimRank(a) || whole.get(a)!.length - whole.get(b)!.length)) {
    const wider = size() - hunks.get(path)!.length + whole.get(path)!.length;
    if (wider <= budget) hunks.set(path, whole.get(path)!);
  }
  const narrowedNote = narrowed.filter((path) => hunks.has(path) && hunks.get(path) !== whole.get(path));

  const header = `# Pull request ${base.slice(0, 9)}...${head.slice(0, 9)}\n\n## Commits\n\n${commits}\n`;
  const notReviewed = skipped.length ? `## Not reviewed\n\n${skipped.map((s) => `- ${s}\n`).join('')}\n` : '';
  const diff =
    '## Diff\n\nEach hunk of a source file shows the whole function around the change. ' +
    'A test file shows three lines of context. A workflow file shows whole.' +
    (narrowedNote.length ? ` To fit in the size of the review, these files show three lines of context only: ${narrowedNote.map((p) => `\`${p}\``).join(', ')}.` : '') +
    '\n\n```diff\n' +
    reviewed.map((path) => hunks.get(path) ?? '').join('') +
    '```\n';
  const imports = [...hunks.keys()].map((path) => importsOf.get(path) ?? '').join('');
  const importsPart = imports
    ? '\n## Imports\n\nThe import statements of each changed file at the head of the pull request, whole, ' +
      'with their line numbers. The diff can show only part of them.\n\n' +
      imports
    : '';
  const room = Math.min(MAX_CONTEXT_BYTES, budget - size());
  const context = room > 0 ? buildContext(repo, base, head, [...hunks.keys()], room, contextKind, hunks) : '';
  const contextPart = context
    ? '\n## Context\n\nUnchanged code at the head of the pull request, outside the hunks of the diff: the definitions of ' +
      'the functions that the change calls and of the names that it uses, the tables that it reads or writes with their ' +
      'migrations, and the routes that a changed test requests' +
      (contextKind === 'full' ? ', then callers of the code that it changes. ' : '. ') +
      'Each line starts with its line number. The repository holds more code than this.\n\n' +
      context
    : '';
  // REV-113. The docs come first: they are the same for every pull request of the repository, so
  // their end is a cache mark of 1 hour. The rest keeps its order. An incremental review (REV-88)
  // builds the rules, the imports and the context from the files that changed since the last
  // review: on the pushes of 13 pull requests of this repository, they were the same as in the last
  // review 3 times in 49. A cache mark after them would cost more than it saves.
  const parts: MessagePart[] = [
    { text: docs, cache: '1h' },
    { text: header + notReviewed + rulesText + answered + unkeyed + diff + importsPart + contextPart },
  ];
  // REV-89. `body`: the pack without its heads and its commits, which a merge of the base branch
  // changes, and without `unkeyed`. The reuse key reads it (reuse.ts), in the order of REV-89.
  const body = notReviewed + docs + rulesText + answered + diff + importsPart + contextPart;
  // REV-113. A short hash of the rules, the imports and the context: the logs of the runner tell how
  // often a review of a pull request holds the same ones as the last review.
  const contextHash = createHash('sha256').update(rulesText + importsPart + contextPart).digest('hex').slice(0, 12);
  // A file of more than MAX_FILE_CHANGED_LINES is logic that the review did not read, as a cut one.
  const unread = [...cut, ...changes.map((c) => c.path).filter((path) => !SKIP.test(path) && !reviewed.includes(path))];
  const coverage: Coverage = { files: changes.length, cut: unread, narrowed: narrowedNote };
  return { pack: parts.map((part) => part.text).join(''), parts, skipped: [...skipped, ...rulesSkipped], rules: packed, body, contextHash, coverage };
}
