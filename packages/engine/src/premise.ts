// KNT-151. A finding whose premise rests on code that the review did not read is no finding.
//
// The model writes it in its own words: « the service code is not in the message », « not confirmed ».
// On the feedback of 28 pull requests, one read or one grep refuted each such finding. The pack now
// holds more of that code (buildContext); a finding that still says so goes to « Not reviewed », with
// what to check, and no longer counts as a finding.
import type { Answer, Finding } from './findings.ts';

/** A finding this sure says that the code shows the defect: a hedge in its text is not its premise. */
export const SURE = 80;

// The phrases of a reviewer about what it read. `context` and `message` are words of the code too (the
// context of a request, the message of an error): « orgId is not available in the context » is a
// defect, so neither counts alone. Neither does « not in the diff » (a migration missing from the
// diff is a defect), nor « not verified » or « not provided » alone (« an email not verified can sign
// in », « the token is not provided » are defects).
const SHOWN = '(?:pack|files shown|code shown|diff shown|review pack)';
const CODE = '(?:definitions?|implementations?|code of|source of|callees?|callers?|schema|migrations?|service code|route file|body of)';
const UNREAD = [
  new RegExp(`\\bnot (?:in|part of) (?:the|this) ${SHOWN}\\b`, 'i'),
  new RegExp(`\\b(?:is|are)n?(?:'t| not) (?:shown|visible|included) in (?:the|this) (?:diff|pack)\\b`, 'i'),
  new RegExp(`\\b(?:the|this) (?:pack|diff) (?:does not|doesn't|did not|didn't) (?:show|include|hold|contain)\\b[^.;]{0,40}?\\b${CODE}`, 'i'),
  // « I could not see a lock here » states a defect: the hedge must name the code that it could not read.
  new RegExp(`\\b(?:I|we|the review|this review) (?:could|can)(?:not|n't| not) (?:confirm|verify|see|check|read)\\b[^.;]{0,80}?\\b${CODE}`, 'i'),
  new RegExp(`\\b${CODE}[^.;]{0,60}?\\b(?:is|are)n?(?:'t| not) provided\\b`, 'i'),
  /\b(?:cannot|can't|could not|couldn't) (?:be )?(?:verif(?:y|ied)|confirm(?:ed)?|check(?:ed)?)\b[^.;]{0,60}?\b(?:from|in|with) (?:the|this) (?:diff|pack)\b/i,
  /\bunseen (?:callers?|callees?|definitions?)\b/i,
  /\bwithout (?:seeing|reading) (?:the|its) (?:callers?|callees?|definition|schema|migration|route file|implementation)\b/i,
];
// A sentence that concedes the hedge (« the callers are not shown, but the route passes params.id ») does
// not hold the premise of the finding.
const CONCESSION = /\b(?:but|however|still|yet|although|though|even so|regardless)\b/i;

/** The sentence of a text that holds the hedge as the premise, or null. */
function hedge(text: string): string | null {
  for (const sentence of text.split(/(?<=[.;!?])\s+/)) {
    if (!CONCESSION.test(sentence) && UNREAD.some((pattern) => pattern.test(sentence))) return sentence.trim().replace(/[.;]$/, '');
  }
  return null;
}

/**
 * Moves each finding below SURE whose title or scenario says that its premise is code that the review
 * did not read to `not_reviewed`, with that sentence as what to check. Gives the findings moved. The
 * score of the model does not change; the cap of a blocking finding (score) no longer counts it.
 */
export function moveUnreadPremises<F extends Finding>(answer: Answer & { findings: F[] }): F[] {
  const moved: F[] = [];
  const kept: F[] = [];
  for (const f of answer.findings) {
    const sentence = Number(f.confidence) < SURE ? hedge(`${f.title}. ${f.scenario}`) : null;
    if (sentence) moved.push(f);
    else kept.push(f);
  }
  if (!moved.length) return moved;
  answer.findings = kept;
  answer.not_reviewed = [
    ...(answer.not_reviewed ?? []),
    ...moved.map((f) => `${f.path}: ${f.title.replace(/\.$/, '')}. To check: ${hedge(`${f.title}. ${f.scenario}`)}.`),
  ];
  return moved;
}
