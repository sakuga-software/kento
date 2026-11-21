// KNT-152. A finding about a race, an order of events or a timeout must trace the steps that the
// runtime allows. Guessed from the diff, such findings were wrong six times in one sample: a timer
// that the grant clears in the same tick, two lines whose order changes nothing. A finding with no
// traced interleaving, or a timing claim with no number, becomes a question of the review.
import type { Answer, Finding, Question } from './findings.ts';
import { MAX_QUESTIONS } from './nonfindings.ts';

/** One step of an interleaving: the file, the line and what runs there. */
export type Step = { path: string; line: number; step: string };

/** The fewest steps of an interleaving: a race needs two actors or two turns at least. */
export const MIN_STEPS = 2;

// A finding about the order of concurrent work: a race, an interleaving, the order of promises,
// timers, events or callbacks. The words name the claim, in the title or the scenario.
const RACE =
  /\brac(e|es|y|ing)\b|\binterleav|\bconcurren(t|tly|cy)\b|\btoctou\b|\btime[- ]of[- ]check\b|\bout of order\b|\bmicrotask|\bevent loop\b|\b(timer|timeout|callback|listener|handler|promise|event)s? (fires?|fired|runs?|ran|resolves?|resolved|rejects?|rejected) (before|after|first|twice)\b|\b(before|after|once|when|while) (its|the|a) (timer|timeout|promise|abort|event|callback|listener)s? (fires?|fired|runs?|ran|resolves?|resolved|rejects?|rejected|ends?|ended)\b|\border of (the )?(promises|timers|events|callbacks|calls|writes|awaits|reject|resolve|abort)\b|\b(counted|fired|called|sent|granted) twice\b/i;

// A finding that says that some work is too slow or exceeds a time limit.
const SLOW = /\b(exceeds?|exceeded|over|past|hits?|reach(es)?) (its|the|a) (time ?out|time limit|deadline)\b|\btimes? out\b|\btoo slow\b/i;

// A number with a unit of time or of size, or a count: what makes a timing claim checkable.
const MEASURE = /\b\d+(\.\d+)?\s*(ms|milliseconds?|s|sec|seconds?|min|minutes?|h|hours?|kb|mb|gb|rows?|items?|requests?|calls?|files?|users?|x|times)\b|\bO\([^)]*\)/i;

/** Whether a finding is about a race or the order of concurrent work. */
export function isRaceFinding(finding: Pick<Finding, 'title' | 'scenario'>): boolean {
  return RACE.test(finding.title ?? '') || RACE.test(finding.scenario ?? '');
}

/** Whether a finding claims that some work is too slow, and gives no number or input that shows it. */
export function isUnmeasuredSlowClaim(finding: Pick<Finding, 'title' | 'scenario'>): boolean {
  const text = `${finding.title ?? ''} ${finding.scenario ?? ''}`;
  return SLOW.test(text) && !MEASURE.test(finding.scenario ?? '');
}

/**
 * Whether the interleaving of a finding is traced: at least MIN_STEPS steps, each with a line above
 * 0, a text, and a file that `exists` at the head.
 */
export function isTraced(steps: readonly Step[] | undefined | null, exists: (path: string) => boolean): boolean {
  const valid = (steps ?? []).filter(
    (s) => s && typeof s.path === 'string' && Number.isInteger(s.line) && s.line > 0 && typeof s.step === 'string' && s.step.trim() && exists(s.path.replace(/^\/+/, '')),
  );
  return valid.length >= MIN_STEPS;
}

/** The question that a finding with no traced steps becomes. */
function questionOf(finding: Finding, slow: boolean): Question {
  const title = finding.title.trim().replace(/[.?]+$/, '');
  return {
    path: finding.path,
    question: slow
      ? `${title}? The review gave no number and no input that makes it slow.`
      : `${title}? The review traced no order of steps that the runtime allows.`,
  };
}

/**
 * The answer without the race findings that trace no interleaving and the timing claims that give no
 * number: each one becomes a question, after the questions already there. A `critical` finding stays.
 */
export function splitUntracedTiming<A extends Answer>(answer: A, exists: (path: string) => boolean): { answer: A; asked: Finding[] } {
  const asked: { finding: Finding; slow: boolean }[] = [];
  const findings = answer.findings.filter((f) => {
    if (f.severity === 'critical') return true;
    if (isRaceFinding(f) && !isTraced(f.interleaving, exists)) return asked.push({ finding: f, slow: false }), false;
    if (isUnmeasuredSlowClaim(f)) return asked.push({ finding: f, slow: true }), false;
    return true;
  });
  if (!asked.length) return { answer, asked: [] };
  const questions = [...(answer.questions ?? []), ...asked.map(({ finding, slow }) => questionOf(finding, slow))].slice(0, MAX_QUESTIONS);
  return { answer: { ...answer, findings, questions }, asked: asked.map((a) => a.finding) };
}
