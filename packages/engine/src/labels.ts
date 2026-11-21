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
// A label that the pack did not hold reads as one only in « earlier finding E7 »: « error code E42 is a
// finding » names no label.
const NAMED_LABEL = (ref: string) => new RegExp(`\\b(?:earlier|previous|prior|open)\\s+findings?\\s+${ref}\\b`, 'i');

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
export function withPublicLabels(text: string, held: readonly HeldEarlier[], keepSentences = false): string {
  if (!text || !/\bE\d/.test(text)) return text;
  const byRef = new Map(held.map((e) => [e.ref, e]));
  const kept: string[] = [];
  for (const sentence of sentences(text)) {
    const refs = [...sentence.matchAll(LABEL)].map((m) => m[0]);
    const cited = new Set(refs.filter((ref) => byRef.has(ref) || NAMED_LABEL(ref).test(sentence)));
    if (!cited.size) {
      kept.push(sentence);
      continue;
    }
    const open = (ref: string) => byRef.get(ref)?.status === 'open';
    // A sentence on stale labels only goes. One that cites an open finding too keeps its note, and a
    // title its sentence: a label of a finding that is not open becomes « an earlier finding ».
    if (!keepSentences && ![...cited].some(open)) continue;
    kept.push(
      sentence.replace(LABEL, (ref) => {
        if (!cited.has(ref)) return ref;
        const e = byRef.get(ref);
        return e && e.status === 'open' ? `#${e.key.slice(0, SHORT_ID_LENGTH)} ("${e.title.replace(/"/g, "'")}")` : 'an earlier finding';
      }),
    );
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
    // A loop, not a pattern: the line is text of the model (CodeQL on #48).
    const colon = line.indexOf(': ');
    if (colon <= 0 || /\s/.test(line.slice(0, colon))) return fix(line);
    const reason = fix(line.slice(colon + 2));
    return reason ? `${line.slice(0, colon + 2)}${reason}` : '';
  }).filter(Boolean);
  // A title keeps its sentence: a finding needs a title. Its stale label goes.
  const title = (text: string) => {
    const out = withPublicLabels(text, held, true);
    if (out !== text) changed++;
    return out;
  };
  answer.findings = answer.findings.map((f) => ({ ...f, title: title(f.title), scenario: fix(f.scenario), fix: fix(f.fix) }));
  return changed;
}
