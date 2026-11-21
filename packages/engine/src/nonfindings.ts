// KNT-153. A finding that names no defect: its fix says that nothing needs to change, or it asks the
// author to confirm something. The first is dropped; the second becomes a question of the review,
// which opens no thread, never blocks and never counts in the score.
import type { Answer, Finding, Question } from './findings.ts';

/** The most questions that a review shows. */
export const MAX_QUESTIONS = 5;

/**
 * A fix that says that no change is needed. Each pattern must name the absence of a change: a fix
 * such as "accept a null id" or "leave the cache as is and add a check" is a change.
 */
export const NO_CHANGE: readonly RegExp[] = [
  /^\W*(none|n\/a|nothing|no fix|no changes?)\W*$/i,
  /^\W*(none|nothing|no fix|no change)( is)? (needed|required|necessary)\b/i,
  /\bno (code )?changes? (is |are )?(needed|required|necessary)\b/i,
  /\bnothing (needs|has) to change\b/i,
  /\bno (fix|action) (is )?(needed|required|necessary)\b/i,
  /^\W*(leave|keep) (it|this|the code|the current (code|behaviou?r))? ?as (it )?is\W*$/i,
  /\b(cosmetic|harmless|intended)[^.]*\b(leave|keep) (it|this)? ?as (it )?is\b/i,
  /^\W*accept (the|this) (current )?(behaviou?r|risk|trade-?off|limitation)\W*$/i,
];

/** A finding that asks the author to check or to confirm, and names no wrong result. */
export const ASKS: readonly RegExp[] = [
  /\bplease (confirm|verify|check|double-check|make sure)\b/i,
  /^\W*(confirm|verify|double-check|make sure|check) (that|whether|if|with)\b/i,
  /\b(is|was) (this|that)\b[^.?]*\b(intended|intentional|deliberate|on purpose)\?/i,
  /\bconfirm (with|that) (the )?(product|ticket|author|team)\b/i,
];

/**
 * Whether the fix of a finding says that no change is needed. The fix must be one sentence: "No
 * change is needed here. Add a test of the caller." asks for a change.
 */
export function saysNoChange(finding: Pick<Finding, 'fix'>): boolean {
  const fix = (finding.fix ?? '').trim();
  const oneSentence = !/[.;!?]\s+\S/.test(fix);
  return oneSentence && NO_CHANGE.some((pattern) => pattern.test(fix));
}

/** Whether a finding asks the author to confirm or to check, in its title or its fix. */
export function asksToConfirm(finding: Pick<Finding, 'title' | 'fix'>): boolean {
  return [finding.title ?? '', (finding.fix ?? '').trim()].some((text) => ASKS.some((pattern) => pattern.test(text)));
}

/** The text of a question that a finding asks: its fix when the fix asks, else its title. */
function questionOf(finding: Finding): Question {
  const fix = (finding.fix ?? '').trim();
  return { path: finding.path, question: ASKS.some((p) => p.test(fix)) ? fix : finding.title.trim() };
}

/**
 * The answer without its non-findings: a finding whose fix says no change goes, and a finding that
 * asks to confirm goes to `questions`, after the questions of the model. A finding of severity
 * `critical` stays: a hole that the model calls "accept the risk" is still a hole.
 */
export function splitNonFindings<A extends Answer>(answer: A): { answer: A; dropped: Finding[]; asked: Finding[] } {
  const dropped: Finding[] = [];
  const asked: Finding[] = [];
  const findings = answer.findings.filter((f) => {
    if (f.severity === 'critical') return true;
    if (saysNoChange(f)) return dropped.push(f), false;
    if (asksToConfirm(f)) return asked.push(f), false;
    return true;
  });
  const given = (Array.isArray(answer.questions) ? answer.questions : []).filter((q) => q && typeof q.question === 'string' && q.question.trim());
  const questions = [...given, ...asked.map(questionOf)].slice(0, MAX_QUESTIONS);
  return { answer: { ...answer, findings, questions }, dropped, asked };
}
