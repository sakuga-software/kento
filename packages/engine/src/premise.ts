// KNT-151. A finding whose premise rests on code that the review did not read is no finding.
//
// The model writes it in its own words: « the service code is not in the message », « not confirmed ».
// On the feedback of 28 pull requests, one read or one grep refuted each such finding. The pack now
// holds more of that code (buildContext); a finding that still says so goes to « Not reviewed », with
// what to check, and no longer counts as a finding.
import type { Answer, Finding } from './findings.ts';

/** A finding this sure says that the code shows the defect: a hedge in its text is not its premise. */
const SURE = 80;

// The words of a premise on code that the review did not see. Each one names the review or its
// message as what lacks the code. « Not in the diff » is not one: a migration missing from the diff is
// a defect. Neither is « not verified » alone: « an email not verified can sign in » is a defect too.
const READER = '(?:message|pack|context|review|code shown)';
const UNREAD = [
  new RegExp(`\\b(?:is|are)n?(?:'t| not) (?:shown |visible |included |present |provided |available )?in (?:the|this) ${READER}\\b`, 'i'),
  new RegExp(`\\b(?:the|this) ${READER} (?:does not|doesn't|did not|didn't) (?:show|include|hold|contain|give)\\b`, 'i'),
  /\b(?:I|we|the review|this review) (?:could|can)(?:not|n't| not) (?:confirm|verify|see|check|read)\b/i,
  new RegExp(`\\b(?:cannot|can't|could not|couldn't) be (?:confirmed|verified|checked) (?:from|in|with) (?:the|this) ${READER}\\b`, 'i'),
  new RegExp(`\\bnot confirmed (?:in|by|from) (?:the|this) ${READER}\\b`, 'i'),
  /\bunseen (?:callers?|code|callees?|definitions?)\b/i,
  /\bwithout (?:seeing|reading) (?:the|its) (?:code|callers?|callees?|definition|schema|migration|route|implementation)\b/i,
];

/** The sentence of a text that holds the hedge, or null. */
function hedge(text: string): string | null {
  for (const sentence of text.split(/(?<=[.;!?])\s+/)) {
    if (UNREAD.some((pattern) => pattern.test(sentence))) return sentence.trim().replace(/[.;]$/, '');
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
