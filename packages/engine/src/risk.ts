// KNT-158 and KNT-154. The risk text of the model says the state that the score of the review gives.
//
// The model writes its risk for its own score. When the engine caps that score, the words stay: a
// capped critical change read "Critical change (CI). Low risk." over a gauge of 3/5. One module holds
// the rule for every cap of the engine.

// A sentence that says that the pull request can be merged.
export const MERGE_ADVICE =
  /\b(?:safe|ready|fine|ok|okay|good) to (?:merge|ship|land)\b|\bcan (?:be )?merged?\b|\bmergeable\b|\bmerge (?:it )?(?:after|once|as is|now)\b|\bnothing blocking\b|\bno blocking\b|\blow risk\b/i;

// A sentence that warns: "Not safe to merge without a check." keeps its warning.
const NEGATION = /\b(not|never|no longer|cannot|can't|isn't|don't|unless|until|without|before)\b/i;

/** The text without its sentences that say that the pull request can be merged. A warning stays. */
export function withoutMergeAdvice(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !MERGE_ADVICE.test(sentence) || NEGATION.test(sentence))
    .join(' ')
    .trim();
}
