// KNT-158. The risk text of the model says the state that the score of the review gives.
//
// The model writes its risk for its own score. When the engine caps that score (a blocking finding,
// or a partial pack: coverage.ts), the words stay: one review said « 1 blocking issue », 2/5, and in
// the same line « safe to merge after a look at one minor point ».

// A sentence that says that the pull request can be merged.
const MERGE_ADVICE =
  /\b(?:safe|ready|fine|ok|okay|good) to (?:merge|ship|land)\b|\bcan (?:be )?merged?\b|\bmergeable\b|\bmerge (?:it )?(?:after|once|as is|now)\b|\bnothing blocking\b|\bno blocking\b|\blow risk\b/i;

/** The text without its sentences that say that the pull request can be merged. */
export function withoutMergeAdvice(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !MERGE_ADVICE.test(sentence))
    .join(' ')
    .trim();
}

/**
 * The risk as the review shows it. With a blocking finding, the sentences of the model that advise a
 * merge go: the head line already says how many issues block.
 */
export function shownRisk(risk: string, blocking: number): string {
  if (!blocking) return risk;
  return withoutMergeAdvice(risk) || 'Fix the blocking issues before a merge.';
}
