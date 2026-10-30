// The fingerprint of a finding: what stays the same when the lines of a file move.
//
// It hashes the path, the rule (or the normalized title when the finding has no rule), and the code
// around the line at the head. The line number is not in the hash: a finding at line 88 that a push
// moves to line 91 keeps its fingerprint. A change of the code of these lines gives a new one.
//
// This module reads no checkout: the runner gives it the lines of the file, and the web service
// calls it without code for the result of a runner that sends no fingerprint.
import { createHash } from 'node:crypto';

/** The lines before and after the line of the finding that the hash reads. */
export const CONTEXT_LINES = 1;

/** A fingerprint: 16 hexadecimal characters. */
export const FINGERPRINT = /^[0-9a-f]{16}$/;

export type FingerprintInput = { path: string; line: number; title: string; rule_id?: string };

/** The title without case, accents, punctuation or extra spaces: two wordings of one title can match. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The code around a line: the line and CONTEXT_LINES lines on each side, with the spaces collapsed
 * and the blank lines removed. `lines` holds the file at the head, line 1 first. An empty string
 * when the file or the line is not known.
 */
export function codeAround(lines: readonly string[] | null, line: number): string {
  if (!lines || line < 1 || line > lines.length) return '';
  let out: string[] = [];
  for (let n = Math.max(1, line - CONTEXT_LINES); n <= Math.min(lines.length, line + CONTEXT_LINES); n++) {
    let text = lines[n - 1]!.trim().replace(/\s+/g, ' ');
    if (text) out.push(text);
  }
  return out.join('\n');
}

/**
 * The fingerprint of a finding. `lines`: the file at the head, or null when it is not known (the
 * hash then reads the path and the rule or title only).
 */
export function fingerprint(finding: FingerprintInput, lines: readonly string[] | null): string {
  let what = finding.rule_id ? `rule:${finding.rule_id}` : `title:${normalizeTitle(finding.title)}`;
  let path = finding.path.replace(/^\/+/, '');
  return createHash('sha256').update(`${path}\n${what}\n${codeAround(lines, finding.line)}`).digest('hex').slice(0, 16);
}
