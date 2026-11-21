// KNT-158, KNT-154 and KNT-166. The risk text of a review: the prefixes that the engine adds to the
// words of the model, in one order, and the advice to merge that a capped review must not keep.
//
// The model writes its risk for its own score. When the engine caps that score, the words stay: a
// capped critical change read "Critical change (CI). Low risk." over a gauge of 3/5. One module holds
// the rule for every cap of the engine.

// A positive advice to merge.
export const MERGE_ADVICE =
  /\b(?:safe|ready|fine|ok|okay|good) to (?:merge|ship|land)\b|\bcan (?:be )?merged?\b|\bmergeable\b|\bmerge (?:it )?(?:after|once|as is|now)\b|\bnothing blocking\b|\bno blocking\b|\blow[- ]risk\b/i;
// A sentence that holds a negation or a condition is a warning, and stays: « Not safe to merge without
// a check. », « It can be merged only after the guard. »
const NEGATION = /\b(?:not|never|no longer|nor|cannot|unless|until|without|before|only|if)\b|n't\b/i;
// Abbreviations that end with a dot inside a sentence.
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|cf)\./gi;

/** The sentences of a text, « e.g. » and « i.e. » inside them. */
function sentences(text: string): string[] {
  return text
    .replace(ABBREVIATIONS, (m) => m.replace(/\./g, '\u0000'))
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\u0000/g, '.'));
}

/** The text without its sentences of positive advice to merge. A warning stays. */
export function withoutMergeAdvice(text: string): string {
  return sentences(text)
    .filter((sentence) => !MERGE_ADVICE.test(sentence) || NEGATION.test(sentence))
    .join(' ')
    .trim();
}

// The prefix of a critical change (KNT-154, review.ts withCriticalText): one sentence at the start.
const CRITICAL_PREFIX = 'Critical change (';

/**
 * The risk with « Partial review: … » (KNT-166) after the prefix of a critical change, when the risk has
 * one, else at its start. The order is always « Critical change (…). Partial review: …. <the model> ».
 */
export function withPartialPrefix(risk: string, partial: string): string {
  const text = risk.trim();
  const prefix = `Partial review: ${partial}.`;
  if (!text.startsWith(CRITICAL_PREFIX)) return [prefix, text].filter(Boolean).join(' ');
  const end = text.indexOf('). ');
  if (end < 0) return `${text} ${prefix}`;
  return `${text.slice(0, end + 2)} ${prefix} ${text.slice(end + 3)}`.trim();
}

/**
 * KNT-158. The risk as the review shows it. With a blocking finding, the sentences of the model that
 * advise a merge go: the head line already says how many issues block.
 */
export function shownRisk(risk: string, blocking: number): string {
  if (!blocking) return risk;
  return withoutMergeAdvice(risk) || 'Fix the blocking issues before a merge.';
}
