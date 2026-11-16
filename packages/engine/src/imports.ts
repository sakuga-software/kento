// REV-70. The imports of each changed file, and the check of a finding that says a name is not imported.
//
// The diff shows the whole function around a change, but often not the imports at the top of the file.
// The model then saw a call to `data` with no import in view, and reported a missing import that line 3
// of the file held (gallery-app#13). The pack now gives the imports of each changed file at the head, and
// the engine checks each finding of that kind against the file before it counts.
import type { Answer, Finding } from './findings.ts';

/** A JS or TS import statement, on one line or several: it ends at its module string. */
const JS_IMPORT = /^[ \t]*import\b[^;'"`]*?['"][^'"\n]+['"][^\n]*/gm;
/** A Python import, on one line, or on several between parentheses. */
const PY_IMPORT = /^[ \t]*(?:from[ \t]+\S+[ \t]+import[ \t]*\([^)]*\)|from[ \t]+\S+[ \t]+import\b[^\n]*|import[ \t]+[\w.][^\n]*)/gm;
const IMPORTING_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/;

/** The most lines of imports that the pack shows for one file. */
const MAX_IMPORT_LINES = 120;

/** The import statements of a file, each with its first line number. */
export function importStatements(text: string): { line: number; text: string }[] {
  const found: { line: number; text: string; index: number }[] = [];
  for (const pattern of [JS_IMPORT, PY_IMPORT]) {
    for (const m of text.matchAll(pattern)) {
      if (found.some((f) => f.index === m.index)) continue;
      found.push({ index: m.index, line: text.slice(0, m.index).split('\n').length, text: m[0] });
    }
  }
  return found.sort((a, b) => a.index - b.index).map(({ line, text }) => ({ line, text }));
}

/**
 * The section of the pack that gives the imports of each changed file at the head, with their line
 * numbers. `fileAt` gives the lines of a file at the head, or null.
 */
export function importsSection(paths: string[], fileAt: (path: string) => string[] | null): string {
  let out = '';
  for (const path of paths) {
    if (!IMPORTING_FILE.test(path)) continue;
    const lines = fileAt(path);
    if (!lines) continue;
    const rows: string[] = [];
    for (const statement of importStatements(lines.join('\n'))) {
      statement.text.split('\n').forEach((text, i) => rows.push(`${statement.line + i}| ${text}`));
      if (rows.length >= MAX_IMPORT_LINES) break;
    }
    if (rows.length) out += `### ${path}\n\n\`\`\`\n${rows.slice(0, MAX_IMPORT_LINES).join('\n')}\n\`\`\`\n\n`;
  }
  return out;
}

// The title of a finding that says a name is missing: not imported, or not defined.
const MISSING_IMPORT = /not imported|missing import|without (an )?import/i;
const MISSING_DEFINITION = /not defined|undeclared/i;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The names in backquotes of a text, `data(...)` read as `data`. */
function namesIn(text: string): string[] {
  const names = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.replace(/\(.*$/, '').trim()).filter((n) => IDENTIFIER.test(n));
  return [...new Set(names)];
}

/**
 * The names that an import statement binds, as text: the module string and the `from x import` of
 * Python go away, so `from "react"` binds no `react`. `import { data as d }` binds `d`, not `data`.
 */
function bindings(statement: string): string {
  // `import type { A }` binds no value, nor does `type A` inside braces.
  if (/^\s*import\s+type\b/.test(statement)) return '';
  return statement
    .replace(/\btype\s+[\w$]+(\s+as\s+[\w$]+)?/g, '')
    .replace(/['"][^'"\n]*['"][^\n]*$/, '')
    .replace(/^\s*from\s+\S+\s+import\b/, '')
    .replace(/[()]/g, ' ')
    .replace(/^\s*import\b/, '')
    .replace(/\bfrom\s*$/, '')
    .replace(/[\w$]+\s+as\s+(?=[\w$])/g, '');
}

/** Whether the file imports the name as a value under that name. */
function imports(text: string, name: string): boolean {
  const word = new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}($|[^\\w$])`);
  return importStatements(text).some((s) => word.test(bindings(s.text)));
}

export type MissingNameCheck = {
  /** The findings that the file contradicts: it imports, as a value, every name that they say is missing. */
  refuted: Finding[];
  /** The findings that the engine could not check: no name in backquotes in the title, or no file at the head. */
  unchecked: Finding[];
};

/**
 * REV-70. Checks each finding that says a name is not imported or not defined against its file at the
 * head. A finding whose names the file imports as values goes away. A finding that the engine cannot check goes to
 * `not_reviewed` ("Not reviewed"), not to the findings. A finding whose names the file does not hold stays:
 * the engine confirmed it. The score of the model does not change: the `Imports` section of the pack
 * is what keeps the model from such a finding, and so from a lower score.
 */
export function checkMissingNames<F extends Finding>(
  answer: Answer & { findings: F[] },
  fileAt: (path: string) => string[] | null,
): MissingNameCheck {
  const refuted: F[] = [];
  const unchecked: F[] = [];
  const kept: F[] = [];
  for (const f of answer.findings) {
    // The title says what the finding claims. A scenario can quote a message ("Account not found")
    // or mention an import in passing, and a real defect must not go away for it.
    const claim = f.title;
    if (!MISSING_IMPORT.test(claim) && !MISSING_DEFINITION.test(claim)) {
      kept.push(f);
      continue;
    }
    const lines = fileAt(f.path);
    // The names of the title only. A scenario often cites other names (`data`, `json`), and the name
    // that the finding means may be none of them.
    const names = namesIn(f.title);
    if (!lines || !names.length) {
      unchecked.push(f);
      continue;
    }
    const text = lines.join('\n');
    // Only an import refutes. A declaration does not: it can sit in another scope, come after the use,
    // or belong to another language than the file.
    if (names.every((name) => imports(text, name))) refuted.push(f);
    else kept.push(f);
  }
  if (refuted.length + unchecked.length === 0) return { refuted, unchecked };

  answer.findings = kept;
  answer.not_reviewed = [
    ...(answer.not_reviewed ?? []),
    ...unchecked.map((f) => `${f.path}: ${f.title.replace(/\.$/, '')}. Kentō could not check it in the file at the head.`),
  ];
  return { refuted, unchecked };
}
