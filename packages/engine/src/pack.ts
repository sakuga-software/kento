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
/** KNT-156. The most bytes of the whole tests of one changed test file; over it, three lines of context. */
export const MAX_TEST_HUNK_BYTES = 40_000;
// KNT-151. The room that the context keeps on a large pull request, at most: 12 % of the pack.
const CONTEXT_RESERVE = 28_800;

const SKIP =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock)$|\.snap$|(^|\/)(dist|build|vendor|\.next|\.react-router)\/|drizzle\/migrations\/meta\/|\.gen\.[a-z]+$|\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|mp4|webm|woff2?|ttf|otf|zip|tgz)$/;
/** A file that the pack never reviews: a lock file, a snapshot, a build output, a binary. */
export const generatedFile = (path: string): boolean => SKIP.test(path);
const TEST_FILE = /\.test\.|\.spec\.|(^|\/)(tests?|__tests__)\//;
// A GitHub workflow or a composite action, which the diff shows whole.
const WORKFLOW_FILE = /^\.github\/(workflows\/[^/]+|actions\/.+\/action)\.ya?ml$/;
// KNT-156. A test file that can go back to three lines of context. A workflow always shows whole.
const narrowableTest = (path: string): boolean => TEST_FILE.test(path) && !WORKFLOW_FILE.test(path);
const WHOLE_FILE_CONTEXT = 100_000;

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
function usedImports(repo: string, head: string, paths: string[], cache: Map<string, string[]>, diffOf: (path: string) => string, packages: Map<string, string>): { name: string; from: string; path: string }[] {
  const found: { name: string; from: string; path: string }[] = [];
  for (const path of paths) {
    const added = diffOf(path)
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
function changedExports(paths: string[], diffOf: (path: string) => string): { name: string; path: string }[] {
  const found: { name: string; path: string }[] = [];
  for (const path of paths) {
    for (const row of diffOf(path).split('\n')) {
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
function addedSqlNames(paths: string[], diffOf: (path: string) => string): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  for (const path of paths) {
    for (const row of diffOf(path).split('\n')) {
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

/** The added lines of a diff of `-U0`, without their `+`, with their line at the head. */
function addedRows(diff: string): { line: number; text: string }[] {
  const rows: { line: number; text: string }[] = [];
  let line = 0;
  for (const row of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
    if (hunk) line = Number(hunk[1]);
    else if (row.startsWith('+') && !row.startsWith('+++')) rows.push({ line: line++, text: row.slice(1) });
  }
  return rows;
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

/** A line without its strings and its comment, for the count of its brackets. */
const codeOf = (line: string) => line.replace(/\/\/.*$/, '').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');

/**
 * The last line (from 1) of the declaration that starts on `line`, at most `maxLines` after it.
 * - At column 0, it ends before the next line that starts at column 0 and is not a closing bracket.
 * - Indented (a method, a property), it ends where its brackets close after its body opened, so a
 *   signature on several lines (`async charge(\n    id: string,\n  ): Promise<void> {`) keeps its
 *   body. A member on one line (`name: (a) => a + 1,`) ends on that line.
 */
export function declarationEnd(lines: readonly string[], line: number, maxLines: number): number {
  const first = lines[line - 1] ?? '';
  if (!/^\s/.test(first)) {
    let end = line;
    while (end < lines.length && end - line < maxLines && !(end > line && /^[^\s})\]]/.test(lines[end]!))) end++;
    while (end > line && !lines[end - 1]!.trim()) end--;
    return end;
  }
  let depth = 0;
  let body = false;
  for (let n = line; n <= Math.min(lines.length, line + maxLines); n++) {
    for (const c of codeOf(lines[n - 1]!)) {
      if (c === '(' || c === '[' || c === '{') {
        if (c === '{' && depth === 0) body = true;
        depth++;
      } else if (c === ')' || c === ']' || c === '}') depth--;
    }
    if (depth <= 0 && (body || !/[{([=]\s*$|=>\s*$/.test(codeOf(lines[n - 1]!)))) return n;
  }
  return Math.min(lines.length, line + maxLines);
}

type Site = { path: string; line: number; reason: string; maxLines?: number };

/** The class that encloses a line of a file: its first and last lines, or null. */
function enclosingClass(lines: readonly string[], line: number): [number, number] | null {
  for (let n = line; n >= 1; n--) {
    if (/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\b/.test(lines[n - 1]!)) {
      const end = declarationEnd(lines, n, lines.length);
      return end >= line ? [n, end] : null;
    }
  }
  return null;
}

/**
 * The declared type of a name in a file, when a line gives it: `name: Type`, `name: ns.Type`, or
 * `name = new Type(`. Gives the first identifier of the type, or null.
 */
function declaredType(lines: readonly string[], name: string): string | null {
  const n = escapeRegExp(name);
  for (const line of lines) {
    const m = new RegExp(`\\b${n}\\s*\\??:\\s*(${IDENT})|\\b${n}\\s*=\\s*(?:await\\s+)?new\\s+(${IDENT})`).exec(line);
    if (m) return m[1] ?? m[2] ?? null;
  }
  return null;
}

/** KNT-151. The most `git grep` calls that the callees of one review run. */
export const MAX_CALLEE_GREPS = 40;

/**
 * The definitions of the functions that the added lines of a file call:
 * - `name(`: in the same file; an imported name is the work of `usedImports`;
 * - `this.name(`: in the class that encloses the call;
 * - `service.name(`: in the module of the imported object, or of the type of a declared receiver;
 * - another object of an unknown type: the only file of the repository that declares a method of that
 *   name, labelled as such. A receiver whose type a package gives (`channel: amqp.Channel`) gets none:
 *   a method of the repository of the same name is not the one called.
 */
function callees(
  repo: string,
  head: string,
  path: string,
  added: readonly { line: number; text: string }[],
  cache: Map<string, string[]>,
  packages: Map<string, string>,
  files: Set<string>,
  greps: { left: number },
): Site[] {
  const lines = fileAt(repo, head, path, cache);
  const text = lines.join('\n');
  const imports = localImports(text, packages);
  // Every name that the file imports, from a package too: a type of a package is no code of the repository.
  const imported = new Set([...text.matchAll(IMPORT)].flatMap(([, , list]) => list.replace(/[{}]/g, ',').split(',').map((raw) => raw.replace(/^\s*(type\s+)?(\*\s+as\s+)?/, '').split(/\s+as\s+/).pop()!.trim()).filter(Boolean)));
  const sites: Site[] = [];
  const seen = new Set<string>();
  const inModule = (from: string, name: string, reason: string) => {
    for (const file of moduleFiles(from, path, packages, files)) {
      const line = declarationLine(fileAt(repo, head, file, cache), name, true);
      if (line) return sites.push({ path: file, line, reason }) > 0;
    }
    return false;
  };
  for (const row of added) {
    for (const m of row.text.matchAll(CALL)) {
      const [, object, name] = m;
      const before = row.text.slice(0, m.index).trimEnd();
      // `).name(` or `].name(`: a method of a value that the line computes, `?` as its object.
      const owner = object ?? (before.endsWith('.') ? '?' : undefined);
      if (KEYWORDS.has(name!) || /\bfunction\s*\*?\s*$/.test(before) || seen.has(`${owner}.${name}`)) continue;
      seen.add(`${owner}.${name}`);
      const reason = `definition of \`${owner && owner !== '?' ? `${owner}.` : ''}${name}\`, which the PR calls`;
      if (owner === undefined) {
        if (imports.has(name!)) continue;
        const line = declarationLine(lines, name!, false);
        if (line) sites.push({ path, line, reason });
      } else if (owner === 'this') {
        const span = enclosingClass(lines, row.line);
        if (!span) continue;
        const line = declarationLine(lines.slice(span[0] - 1, span[1]), name!, true);
        if (line) sites.push({ path, line: span[0] + line - 1, reason });
      } else if (imports.has(owner)) {
        inModule(imports.get(owner)!, name!, reason);
      } else {
        const given = owner === '?' ? null : declaredType(lines, owner);
        const type = given && !['any', 'unknown', 'object', 'Object'].includes(given) ? given : null;
        if (type && imports.has(type)) {
          inModule(imports.get(type)!, name!, reason);
          continue;
        }
        // A type of a package, or of the language (`Map`, `Promise`): its method is not in the repository.
        if (type && (imported.has(type) || !declarationLine(lines, type, false))) continue;
        if (COMMON_METHODS.has(name!) || name!.length <= 3 || greps.left <= 0) continue;
        greps.left--;
        const n = escapeRegExp(name!);
        const pattern = `^[[:space:]]+((public|private|protected|static|async|override)[[:space:]]+)*${n}[[:space:]]*(<[^>]*>)?[[:space:]]*\\(|^[[:space:]]+${n}[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?(function|\\()|^[[:space:]]*export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+${n}[^[:alnum:]_$]`;
        const declared = grep(repo, head, ['-E', '-e', pattern]).filter((d) => declarationLine([d.text], name!, true) === 1 && /[{(]\s*$/.test(d.text));
        // Only a declaration that opens a body: a member of a type (`href: (page: number) => string`)
        // has the same shape on one line. A name that several files declare: a grep cannot tell which
        // one the object is.
        if (new Set(declared.map((d) => d.path)).size === 1) {
          sites.push({ path: declared[0]!.path, line: declared[0]!.line, reason: `the one method \`${name}\` of the repository, which \`${owner === '?' ? '…' : owner}.${name}\` may call (its type is unknown)` });
        }
      }
      // The diff can show some of them: the caller keeps the first MAX_CALLEES that it does not.
      if (sites.length >= MAX_CALLEES * 3) return sites;
    }
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
/** The length of the common folder prefix of two paths: the nearer, the longer. */
function nearness(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  let n = 0;
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;
  return n;
}

/** The order of two migrations of one folder: by their number (`2_` before `10_`), then by name. */
function migrationOrder(a: { path: string; line: number }, b: { path: string; line: number }): number {
  const number = (p: string) => Number(/^(\d+)/.exec(p.split('/').pop()!)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return number(a.path) - number(b.path) || a.path.localeCompare(b.path) || a.line - b.line;
}
const folderOf = (path: string) => path.split('/').slice(0, -1).join('/');

// A line that names a module or holds only a comment: `from "pkg"`, `update state` in a comment.
const NOT_SQL_LINE = /^\s*(?:import\b|export\s.*\bfrom\s|\/\/|\/?\*|#|--)/;

/**
 * The definition of each table that the added lines read or write, the SQL files first: its
 * declaration in a schema file (Drizzle or Prisma), the migration that creates it, the migrations
 * between that alter a column that the added lines name, and the last migration that alters it. A name
 * that several apps declare resolves to the declaration nearest to the file that uses it.
 */
function tableDefinitions(repo: string, head: string, added: ReadonlyMap<string, readonly { line: number; text: string }[]>, cache: Map<string, string[]>): Site[] {
  const all = [...added.values()].flatMap((rows) => rows.map((r) => r.text)).join('\n');
  // No word of a table in the added lines: no grep.
  if (!/\b(?:from|join|into|update|table)\b|selectFrom|insertInto|updateTable|deleteFrom|\.(?:find|create|update|delete|upsert|count)\w*\s*\(/i.test(all)) return [];
  // The Drizzle tables of the repository, by the name of their variable and by their SQL name.
  const declared = grep(repo, head, ['-E', '-e', TABLE_DECLARATION]).map((d) => {
    const lines = fileAt(repo, head, d.path, cache);
    const text = `${lines[d.line - 1]}\n${lines[d.line] ?? ''}`;
    const variable = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(text)?.[1] ?? '';
    const sql = /Table\s*\(\s*['"`]([^'"`]+)['"`]/.exec(text)?.[1] ?? '';
    return { ...d, variable, sql };
  });
  // Each name, with the changed file that uses it first and the words of its added lines.
  const names = new Map<string, { from: string; words: Set<string> }>();
  const models = new Map<string, string>();
  for (const [path, rows] of added) {
    const text = rows.filter((r) => !NOT_SQL_LINE.test(r.text)).map((r) => r.text.replace(/\s\/\/.*$|\s--\s.*$/, '')).join('\n');
    const words = new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
    const keep = (name: string) => {
      const lower = name.toLowerCase();
      if (names.size < MAX_TABLE_CANDIDATES && /^[A-Za-z_]\w*$/.test(name) && !NOT_TABLES.has(lower) && !names.has(lower)) names.set(lower, { from: path, words });
    };
    for (const [, name] of text.matchAll(SQL_TABLE)) keep(name!);
    for (const [, name] of text.matchAll(BUILDER_TABLE)) keep(name!);
    for (const [, name] of text.matchAll(ORM_TABLE)) {
      const table = declared.filter((d) => d.variable === name).sort((x, y) => nearness(y.path, path) - nearness(x.path, path))[0];
      if (table?.sql) keep(table.sql);
    }
    for (const [, model] of text.matchAll(PRISMA_MODEL)) if (!models.has(model!)) models.set(model!, path);
  }
  if (!names.size && !models.size) return [];

  const sites: Site[] = [];
  const found = new Set<string>();
  const list = [...names.keys()].map(escapeRegExp).join('|');
  const quoted = '["`]?';
  const qualified = `(${quoted}[[:alnum:]_]+${quoted}\\.)?`;
  const after = '([^[:alnum:]_]|$)';
  const migrations = (verb: string, table: RegExp) =>
    list
      ? grep(repo, head, ['-i', '-E', '-e', `${verb}[[:space:]]+${qualified}${quoted}(${list})${quoted}${after}`], SQL_GLOBS).map((m) => ({
          ...m,
          table: table.exec(m.text)?.[1]?.toLowerCase() ?? '',
        }))
      : [];
  const creates = migrations('create[[:space:]]+table([[:space:]]+if[[:space:]]+not[[:space:]]+exists)?', /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:["`]?\w+["`]?\.)?["`]?(\w+)/i);
  const alters = migrations('alter[[:space:]]+table([[:space:]]+if[[:space:]]+exists)?([[:space:]]+only)?', /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:["`]?\w+["`]?\.)?["`]?(\w+)/i);
  // Only the names that resolve count: a word after `from` that no table has is no candidate.
  for (const [lower, { from, words }] of names) {
    const nearest = <T extends { path: string }>(rows: T[]) => [...rows].sort((x, y) => nearness(y.path, from) - nearness(x.path, from))[0];
    const schema = nearest(declared.filter((d) => d.sql.toLowerCase() === lower));
    const create = nearest(creates.filter((m) => m.table === lower));
    if (!schema && !create) continue;
    found.add(lower);
    if (schema) sites.push({ path: schema.path, line: schema.line, reason: `table \`${lower}\`, which the PR reads or writes` });
    if (create) {
      sites.push({ path: create.path, line: create.line, reason: `migration that creates the table \`${lower}\`` });
      // The migrations of the same folder, in the order of their numbers.
      const later = alters.filter((m) => m.table === lower && folderOf(m.path) === folderOf(create.path) && migrationOrder(m, create) > 0).sort(migrationOrder);
      const last = later.at(-1);
      const middle = later.filter((m) => m.path !== last?.path && (m.text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []).some((w) => words.has(w) && w !== lower && !/^(alter|table|add|column|drop|set|not|null|default|if|exists|only)$/.test(w)));
      for (const m of middle.slice(0, 4)) sites.push({ path: m.path, line: m.line, reason: `migration that alters a column of \`${lower}\` that the PR uses` });
      // The statements of the last migration on the table, a few lines apart, make one snippet.
      if (last && last.path !== create.path) {
        for (const m of later.filter((a) => a.path === last.path).slice(0, 8)) sites.push({ path: m.path, line: m.line, reason: `last migration that alters the table \`${lower}\`` });
      }
    }
    if (found.size >= MAX_TABLES) break;
  }
  if (models.size && found.size < MAX_TABLES) {
    for (const [model, from] of models) {
      const upper = model[0]!.toUpperCase() + model.slice(1);
      const rows = grep(repo, head, ['-E', '-e', `^model[[:space:]]+${escapeRegExp(upper)}[[:space:]]*\\{`], ['*.prisma']);
      const row = rows.sort((x, y) => nearness(y.path, from) - nearness(x.path, from))[0];
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
  // The diff of `-U0` of each changed file, read once.
  const diffs0 = new Map<string, string>();
  const diffOf = (path: string) => {
    if (!diffs0.has(path)) diffs0.set(path, git(repo, 'diff', '-U0', `${base}...${head}`, '--', path));
    return diffs0.get(path)!;
  };
  const added = new Map([...sqlFiles, ...sources].map((p) => [p, addedRows(diffOf(p))]));
  const greps = { left: MAX_CALLEE_GREPS };
  const snippets: Snippet[] = [];
  // KNT-151. The diff can show the first lines of a declaration (three lines of context) and not its
  // body: only a declaration that the diff shows whole is left out.
  const shownWhole = (path: string, line: number, maxLines: number) => {
    const end = declarationEnd(fileAt(repo, head, path, cache), line, maxLines);
    for (let n = line; n <= end; n++) if (!isShown(path, n)) return false;
    return true;
  };
  const add = (path: string, line: number, reason: string, wholeDeclaration: boolean, maxLines = MAX_SNIPPET_LINES) => {
    if (!wholeDeclaration && isShown(path, line)) return;
    if (snippets.some((s) => s.path === path && line >= s.start && line <= s.end)) return;
    const lines = fileAt(repo, head, path, cache);
    let start = Math.max(1, line - LINES_BEFORE_SITE);
    let end = Math.min(lines.length, line + LINES_AFTER_SITE);
    if (wholeDeclaration) {
      start = line;
      end = declarationEnd(lines, line, maxLines);
      if (shownWhole(path, line, maxLines)) return;
    }
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

  for (const [name, writers] of addedSqlNames(sources, diffOf)) {
    const sites = grep(repo, head, ['-F', '-w', '-e', name], SQL_GLOBS).filter((m) => !writers.has(m.path));
    // A migration says best what the name is: it comes before a mention in the code. A file of the
    // diff that holds the name (a migration of this pull request) is in the diff already.
    const outside = sites.filter((m) => !paths.includes(m.path));
    const best = outside.find((m) => m.path.endsWith('.sql')) ?? outside[0];
    if (best) add(best.path, best.line, `definition of \`${name}\`, which the PR writes`, false);
    else if (!sites.length) absent.push(name);
  }

  for (const site of tableDefinitions(repo, head, added, cache)) {
    add(site.path, site.line, site.reason, true, site.maxLines);
  }

  const calls = sources.flatMap((path) => callees(repo, head, path, added.get(path) ?? [], cache, packages, files, greps));
  for (const site of calls.filter((c) => !shownWhole(c.path, c.line, c.maxLines ?? MAX_SNIPPET_LINES)).slice(0, MAX_CALLEES)) add(site.path, site.line, site.reason, true, site.maxLines);

  const definitions = (importers: string[]) => {
    for (const { name, from, path } of usedImports(repo, head, importers, cache, diffOf, packages).slice(0, MAX_SYMBOLS)) {
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

  for (const { name } of kind === 'full' ? changedExports(sources, diffOf).slice(0, MAX_SYMBOLS) : []) {
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
): { pack: string; parts: MessagePart[]; skipped: string[]; rules: PackedRule[]; body: string; contextHash: string } {
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
    hunks.set(path, git(repo, 'diff', WORKFLOW_FILE.test(path) ? `-U${WHOLE_FILE_CONTEXT}` : '-W', `${base}...${head}`, '--', ...paths));
    // KNT-156. A changed test shows its whole test, so that the review can read the assertion. A test
    // file whose whole tests pass MAX_TEST_HUNK_BYTES shows three lines of context, as before.
    if (narrowableTest(path) && hunks.get(path)!.length > MAX_TEST_HUNK_BYTES) hunks.set(path, git(repo, 'diff', '-U3', `${base}...${head}`, '--', ...paths));
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
  // KNT-151. On a large pull request, the diff would fill the budget and leave the context no room:
  // the context reads first, up to CONTEXT_RESERVE, and the diff fits in what is left.
  const reserve =
    size() > budget - CONTEXT_RESERVE ? buildContext(repo, base, head, [...hunks.keys()], CONTEXT_RESERVE, contextKind, hunks).length : 0;
  const diffBudget = budget - reserve;
  // KNT-156. Over the budget, a test file that shows its whole tests goes back to three lines of
  // context before any file goes: the largest first.
  const wide = new Map<string, string>();
  for (const [path, hunk] of [...hunks].sort((a, b) => b[1].length - a[1].length)) {
    if (size() <= diffBudget) break;
    if (!narrowableTest(path)) continue;
    const paths = renamedFrom.has(path) ? [renamedFrom.get(path)!, path] : [path];
    const narrow = git(repo, 'diff', '-U3', `${base}...${head}`, '--', ...paths);
    if (narrow.length < hunk.length) {
      wide.set(path, hunk);
      hunks.set(path, narrow);
    }
  }
  // Drop the largest diffs first: the small ones are where most of the logic of a change sits.
  for (const [path] of [...hunks].sort((a, b) => b[1].length - a[1].length)) {
    if (size() <= diffBudget) break;
    skipped.push(`${path}: removed to fit in the maximum size of the review`);
    hunks.delete(path);
  }
  // KNT-156. A dropped file can leave room: the narrowed test files that fit show their whole tests
  // again, the smallest first (Kentō #0b630a).
  for (const [path, hunk] of [...wide].sort((a, b) => a[1].length - b[1].length)) {
    const narrow = hunks.get(path);
    if (narrow === undefined) continue;
    if (size() - narrow.length + hunk.length <= diffBudget) hunks.set(path, hunk);
  }

  const header = `# Pull request ${base.slice(0, 9)}...${head.slice(0, 9)}\n\n## Commits\n\n${commits}\n`;
  const notReviewed = skipped.length ? `## Not reviewed\n\n${skipped.map((s) => `- ${s}\n`).join('')}\n` : '';
  const diff =
    '## Diff\n\nEach hunk shows the whole function around the change, the whole test for a test file. ' +
    'A test file with very long tests shows three lines of context. A workflow file shows whole.\n\n```diff\n' +
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
  return { pack: parts.map((part) => part.text).join(''), parts, skipped: [...skipped, ...rulesSkipped], rules: packed, body, contextHash };
}
