// KNT-110. The sections of the pack that only a later review of a pull request holds. The system
// prompt names them. The note that says how to read one goes at the end of the user message, and
// only when the pack holds that section: a first review does not read them, and the system prompt
// stays the same for every review, for the prompt cache.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MessagePart } from './providers.ts';

const SECTIONS = [
  { heading: 'Answered threads', file: 'sections/answered-threads.md' },
  { heading: 'Rejected findings', file: 'sections/rejected-findings.md' },
  { heading: 'Earlier findings', file: 'sections/earlier-findings.md' },
  { heading: 'Changed since the last review', file: 'sections/changed-since.md' },
] as const;

export const SECTION_PROMPT_FILES = SECTIONS.map((s) => s.file);

/** The last line of the user message of a review. */
export const FINAL_INSTRUCTION = 'Review the diff above with the « Method » of the system prompt, and answer with the JSON object.';

/**
 * The notes of the sections that the pack holds, in the order of SECTIONS. `prompts` replaces a file
 * of prompts/ by its name, as in ModelClient.
 */
export function sectionNotes(parts: readonly MessagePart[], prompts?: Partial<Record<string, string>>): string[] {
  const text = parts.map((part) => part.text).join('');
  return SECTIONS.filter((s) => new RegExp(`^## ${s.heading}$`, 'm').test(text)).map(
    (s) => (prompts?.[s.file] ?? readFileSync(join(import.meta.dirname, '..', 'prompts', s.file), 'utf8')).trim(),
  );
}
