// KNT-196. The labels of the pack (`E1`, `E2`: earlier.ts) never reach a reader.
//
// On an incremental review, the summary said « The open earlier finding E1 still stands », and « Not
// reviewed » said « … so E1 was not rechecked ». No published review names E1, and that finding was
// no longer open: the reader thought a defect stood when none did. The engine now writes an open
// earlier finding as its public id and title, and removes a sentence that cites a finding that is not
// open, or a label that the pack did not hold.
import type { Answer } from './findings.ts';
import type { HeldEarlier } from './earlier.ts';
import { SHORT_ID_LENGTH } from './render.ts';

// A label of the pack: `E1`, never part of a longer word (`E2E`, `E11000` stays: see `cited`).
const LABEL = /\bE(\d{1,3})\b/g;
// A label that the pack did not hold still reads as one next to these words.
const ABOUT_A_FINDING = /\b(?:earlier|finding|findings|follows|still stands|rechecked|re-checked)\b/i;

/** The sentences of a text, « e.g. » and « i.e. » inside them. */
function sentences(text: string): string[] {
  return text
    .replace(/\b(e\.g|i\.e|etc|vs)\./gi, (m) => m.replace(/\./g, '\u0000'))
    .split(/(?<=[.!?;])\s+/)
    .map((s) => s.replace(/\u0000/g, '.'));
}

/**
 * The text with each label of an open earlier finding written as its public id and title, and without
 * the sentences that cite a finding that is not open or a label that the pack did not hold.
 */
export function withPublicLabels(text: string, held: readonly HeldEarlier[]): string {
  if (!text || !/\bE\d/.test(text)) return text;
  const byRef = new Map(held.map((e) => [e.ref, e]));
  const kept: string[] = [];
  for (const sentence of sentences(text)) {
    const refs = [...sentence.matchAll(LABEL)].map((m) => m[0]);
    const cited = refs.filter((ref) => byRef.has(ref) || ABOUT_A_FINDING.test(sentence));
    if (!cited.length) {
      kept.push(sentence);
      continue;
    }
    if (cited.some((ref) => byRef.get(ref)?.status !== 'open')) continue;
    kept.push(sentence.replace(LABEL, (ref) => {
      const e = byRef.get(ref);
      return e ? `#${e.key.slice(0, SHORT_ID_LENGTH)} ("${e.title.replace(/"/g, "'")}")` : ref;
    }));
  }
  return kept.join(' ').trim();
}

/**
 * Writes the labels of the answer as a reader can find them: in the summary, the risk, the reason of
 * a deeper review, the « Not reviewed » lines and the text of each finding. A « Not reviewed » line
 * that only cited such a finding goes. Gives the number of texts that changed.
 */
export function publicLabels(answer: Answer, held: readonly HeldEarlier[]): number {
  let changed = 0;
  const fix = (text: string) => {
    const out = withPublicLabels(text, held);
    if (out !== text) changed++;
    return out;
  };
  answer.summary = fix(answer.summary);
  answer.risk = fix(answer.risk);
  if (answer.deeper_review?.reason) answer.deeper_review = { ...answer.deeper_review, reason: fix(answer.deeper_review.reason) };
  answer.not_reviewed = (answer.not_reviewed ?? []).map((line) => {
    // The path of the line stays out of the sentences: `path: reason`.
    const match = /^(\S+?:\s)(.*)$/.exec(line);
    if (!match) return fix(line);
    const reason = fix(match[2]!);
    return reason ? `${match[1]}${reason}` : '';
  }).filter(Boolean);
  // A title keeps its words when its one sentence would go: a finding needs a title.
  answer.findings = answer.findings.map((f) => ({ ...f, title: fix(f.title) || f.title, scenario: fix(f.scenario), fix: fix(f.fix) }));
  return changed;
}
