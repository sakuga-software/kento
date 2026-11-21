// KNT-153. A finding that names no defect: its fix says that nothing needs to change, or it asks the
// author to confirm something. The first is dropped; the second becomes a question of the review,
// which opens no thread, never blocks and never counts in the score.
import type { Answer, Finding, Question } from './findings.ts';

/** The most questions that a review shows. */
export const MAX_QUESTIONS = 5;

/**
 * A fix that says that no change is needed, as the whole text of the fix. "No change is needed in
 * `parse`, but `save` must reject an empty name" asks for a change: no pattern matches a part.
 */
export const NO_CHANGE: readonly RegExp[] = [
  /^\W*(none|n\/a|nothing|no fix|no changes?)\W*$/i,
  /^\W*(none|nothing|no fix|no action|no (code )?changes?)( is| are)? (needed|required|necessary)( here)?\W*$/i,
  /^\W*nothing (needs|has) to change( here)?\W*$/i,
  /^\W*(leave|keep) (it|this|the code|the current (code|behaviou?r))? ?as (it )?is\W*$/i,
  /^\W*accept (the|this) (current )?(behaviou?r|risk|trade-?off|limitation)\W*$/i,
];

/**
 * A fix that asks the author to confirm, as the whole text of the fix. "Please make sure the
 * handler returns 404" and "Confirm with a cap of 3 retries, then fail" name a change: no match.
 */
export const ASKS: readonly RegExp[] = [
  /^\W*please confirm\b/i,
  /^\W*confirm (that|whether)\b/i,
  /^\W*confirm (with|that) (the )?(product|ticket|author|team)\b/i,
  /^[^.?]*\b(is|was) (this|that)\b[^.?]*\b(intended|intentional|deliberate|on purpose)\?\W*$/i,
];

/**
 * Whether the fix of a `minor` finding says that no change is needed, as its whole text: each
 * pattern is anchored at both ends, so no second clause gets past it. A `major` or `critical` finding is never dropped: its fix can name a change in words that
 * no pattern knows, and the cost of a lost defect is higher.
 */
export function saysNoChange(finding: Pick<Finding, 'fix' | 'severity'>): boolean {
  if (finding.severity !== 'minor') return false;
  const fix = (finding.fix ?? '').trim();
  return NO_CHANGE.some((pattern) => pattern.test(fix));
}

/**
 * Whether a `minor` finding only asks the author to confirm: its fix (its title when the fix is
 * empty) is a request to confirm in one clause, and it gives no suggestion and no patch. A finding
 * whose fix names a change keeps its thread, whatever its title asks.
 */
export function asksToConfirm(finding: Pick<Finding, 'title' | 'fix' | 'severity' | 'suggestion' | 'patch'>): boolean {
  if (finding.severity !== 'minor' || (finding.suggestion ?? '').trim() || (finding.patch ?? '').trim()) return false;
  const fix = (finding.fix ?? '').trim();
  const text = fix || (finding.title ?? '').trim();
  // One clause: "Confirm that `pages` rounds up: use Math.ceil" and "Confirm whether the id can be
  // null and add a guard" ask for a change after the colon or the "and".
  const oneClause = !/[,:;]|\b(but|instead|then|otherwise|and|or)\b/i.test(text.replace(/\W+$/, ''));
  return oneClause && ASKS.some((pattern) => pattern.test(text));
}

/** The text of a question that a finding asks: its fix, or its title and its scenario when it has no fix. */
function questionOf(finding: Finding): Question {
  const fix = (finding.fix ?? '').trim();
  const question = fix || `${finding.title.trim()} ${(finding.scenario ?? '').trim()}`.trim();
  return { path: finding.path, question };
}

/**
 * The answer with `moved` findings turned into questions by `toQuestion`. The questions of moved
 * findings come first: each stands for a candidate defect. The questions of the model fill the rest,
 * up to MAX_QUESTIONS. A moved finding with no room left stays a finding, so that no defect is lost.
 * `moved` holds the findings that became questions.
 */
export function moveToQuestions<A extends Answer>(answer: A, candidates: readonly Finding[], toQuestion: (finding: Finding) => Question): { answer: A; moved: Finding[] } {
  if (!candidates.length) return { answer, moved: [] };
  const moved = candidates.slice(0, MAX_QUESTIONS);
  const given = (Array.isArray(answer.questions) ? answer.questions : []).filter((q) => q && typeof q.question === 'string' && q.question.trim());
  const questions = [...moved.map(toQuestion), ...given].slice(0, MAX_QUESTIONS);
  const findings = answer.findings.filter((f) => !moved.includes(f));
  return { answer: { ...answer, findings, questions }, moved };
}

/**
 * The answer without its non-findings: a finding whose fix says no change goes, and a finding that
 * asks to confirm becomes a question (moveToQuestions). A finding of severity `critical` stays: a
 * hole that the model calls "accept the risk" is still a hole. `asked`: the findings that became
 * questions.
 */
export function splitNonFindings<A extends Answer>(answer: A): { answer: A; dropped: Finding[]; asked: Finding[] } {
  const dropped = answer.findings.filter((f) => saysNoChange(f));
  const kept = { ...answer, findings: answer.findings.filter((f) => !dropped.includes(f)) };
  const candidates = kept.findings.filter((f) => f.severity !== 'critical' && asksToConfirm(f));
  const given = (Array.isArray(answer.questions) ? answer.questions : []).filter((q) => q && typeof q.question === 'string' && q.question.trim());
  if (!candidates.length) return { answer: { ...kept, questions: given.slice(0, MAX_QUESTIONS) }, dropped, asked: [] };
  const { answer: out, moved } = moveToQuestions(kept, candidates, questionOf);
  return { answer: out, dropped, asked: moved };
}
