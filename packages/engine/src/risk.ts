// The risk text of a review: the prefixes that the engine adds to the words of the model, in one
// order, and the advice to merge that a capped review must not keep.

// A positive advice to merge. A sentence that holds a negation or a condition (« not safe to merge
// until… », « do not merge it now ») is a warning, and stays.
const MERGE_ADVICE = /\b(?:safe|ready|fine|ok|okay|good) to (?:merge|ship|land)\b|\bcan (?:be )?merged?\b|\bmergeable\b|\blow[- ]risk\b|\bnothing blocking\b/i;
const NEGATION = /\b(?:not|never|no|nor|until|unless|before|without|cannot|only|if)\b|n't\b/i;
// Abbreviations that end with a dot inside a sentence.
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|cf)\./gi;

/** The sentences of a text, « e.g. » and « i.e. » inside them. */
function sentences(text: string): string[] {
  return text
    .replace(ABBREVIATIONS, (m) => m.replace(/\./g, '\u0000'))
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\u0000/g, '.'));
}

/** The text without its sentences of positive advice to merge. */
export function withoutMergeAdvice(text: string): string {
  return sentences(text)
    .filter((sentence) => !(MERGE_ADVICE.test(sentence) && !NEGATION.test(sentence)))
    .join(' ')
    .trim();
}

/**
 * The risk with the prefixes of the engine, in this order: « Critical change (…). » (KNT-154), then
 * « Partial review: … » (KNT-166). A prefix is one sentence, without its final dot.
 */
export function riskWithPrefixes(risk: string, prefixes: { critical?: string; partial?: string }): string {
  return [prefixes.critical ? `Critical change (${prefixes.critical}).` : '', prefixes.partial ? `Partial review: ${prefixes.partial}.` : '', risk.trim()].filter(Boolean).join(' ');
}

/**
 * KNT-158. The risk as the review shows it. With a blocking finding, the sentences of the model that
 * advise a merge go: the head line already says how many issues block.
 */
export function shownRisk(risk: string, blocking: number): string {
  if (!blocking) return risk;
  return withoutMergeAdvice(risk) || 'Fix the blocking issues before a merge.';
}
