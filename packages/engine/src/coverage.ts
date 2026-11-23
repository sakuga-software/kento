// KNT-166. A review that read only part of the diff says so, and its score follows it.
//
// On a large pull request, the pack cut 18 files to fit, the schema and the stores among them. The
// review gave 4/5 and « Nothing blocking », but the two false findings and every defect found later
// were in those files. The review now names what it did not read, and cannot rate the code it did
// not read as safe.
import type { Answer } from './findings.ts';
import type { Coverage } from './pack.ts';
import { withoutMergeAdvice, withPartialPrefix } from './risk.ts';

/** The highest score when the review did not read a file of logic: « one part you could not check ». */
export const PARTIAL_SCORE = 4;
/** The highest score when it did not read a schema, a migration or a store: « a path that matters ». */
export const PARTIAL_CORE_SCORE = 3;

const list = (paths: string[]) => paths.map((p) => `\`${p}\``).join(', ');

/**
 * Writes the coverage of the pack in the answer: the summary names the files that the review did not
 * read, with why, and those it read with less context. When a file of logic is among the unread ones
 * (pack.ts: neither generated nor a doc), the risk says that the review is partial, loses its advice
 * to merge, and the score of the model is capped. Gives the cap, or null.
 */
export function applyCoverage(answer: Answer, coverage: Coverage | undefined): number | null {
  if (!coverage) return null;
  const unread = coverage.cut.length + coverage.large.length;
  if (!unread && !coverage.narrowed.length) return null;
  const notes: string[] = [];
  if (unread) {
    const why = [
      coverage.cut.length ? `${coverage.cut.length} to fit in its size (${list(coverage.cut)})` : '',
      coverage.large.length ? `${coverage.large.length} with more than 1000 changed lines (${list(coverage.large)})` : '',
    ].filter(Boolean);
    notes.push(`This review did not read ${unread} of the ${coverage.files} changed files: ${why.join('; ')}.`);
  }
  if (coverage.narrowed.length) {
    notes.push(`It read ${coverage.narrowed.length === 1 ? 'this file' : `these ${coverage.narrowed.length} files`} with three lines of context only: ${list(coverage.narrowed)}.`);
  }
  answer.summary = [answer.summary.trim(), ...notes].filter(Boolean).join('\n\n');
  if (!coverage.logic.length) return null;
  const core = coverage.core.length > 0;
  const cap = core ? PARTIAL_CORE_SCORE : PARTIAL_SCORE;
  const n = coverage.logic.length;
  answer.risk = withPartialPrefix(
    withoutMergeAdvice(answer.risk),
    `${n} file${n === 1 ? '' : 's'} of logic not read${core ? ', a schema, a migration or a store among them' : ''} (see Not reviewed)`,
  );
  const said = Number(answer.confidence_score) || 0;
  if (said > cap) answer.confidence_score = cap;
  return cap;
}
