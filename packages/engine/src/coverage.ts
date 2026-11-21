// KNT-166. A review that read only part of the diff says so, and its score follows it.
//
// On a large pull request, the pack cut 18 files to fit, the schema and the stores among them. The
// review gave 4/5 and « Nothing blocking », but the two false findings and every defect found later
// were in those files. The review now names what it did not read, and cannot rate the code it did
// not read as safe.
import type { Answer } from './findings.ts';
import { TRIM_RANK, trimRank, type Coverage } from './pack.ts';
import { withoutMergeAdvice } from './risk.ts';

/** The highest score when the review did not read a file of logic: « one part you could not check ». */
export const PARTIAL_SCORE = 4;
/** The highest score when it did not read a schema, a migration or a store: « a path that matters ». */
export const PARTIAL_CORE_SCORE = 3;

const list = (paths: string[]) => paths.map((p) => `\`${p}\``).join(', ');

/**
 * Writes the coverage of the pack in the answer: the summary names the files that the review did not
 * read, and those it read with less context. When a file of logic is among the unread ones, the risk
 * says that the review is partial, and the score of the model is capped. Gives the cap, or null.
 */
export function applyCoverage(answer: Answer, coverage: Coverage | undefined): number | null {
  if (!coverage || (!coverage.cut.length && !coverage.narrowed.length)) return null;
  const notes: string[] = [];
  if (coverage.cut.length) {
    notes.push(`This review did not read ${coverage.cut.length} of the ${coverage.files} changed files, to fit in its size: ${list(coverage.cut)}.`);
  }
  if (coverage.narrowed.length) {
    notes.push(`It read ${coverage.narrowed.length === 1 ? 'this file' : `these ${coverage.narrowed.length} files`} with three lines of context only: ${list(coverage.narrowed)}.`);
  }
  answer.summary = [answer.summary.trim(), ...notes].filter(Boolean).join('\n\n');
  const logic = coverage.cut.filter((p) => trimRank(p) >= TRIM_RANK.ui);
  if (!logic.length) return null;
  const core = logic.some((p) => trimRank(p) === TRIM_RANK.core);
  const cap = core ? PARTIAL_CORE_SCORE : PARTIAL_SCORE;
  // KNT-158. The words of the model that advise a merge go: the review did not read all the code.
  answer.risk = `Partial review: ${logic.length} file${logic.length === 1 ? '' : 's'} of logic not read${core ? ', a schema, a migration or a store among them' : ''} (see Not reviewed). ${withoutMergeAdvice(answer.risk)}`.trim();
  const said = Number(answer.confidence_score) || 0;
  if (said > cap) answer.confidence_score = cap;
  return cap;
}
