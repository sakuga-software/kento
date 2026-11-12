// REV-89. What a review reads, as two hashes: the diff of the files that it reviews (for the logs),
// and the whole input of the model (the reuse key). Two heads with the same key get the same review:
// the service then publishes the review of the first head again, and calls no model.
//
// A merge of the base branch, or a rebase with no conflict, changes the head and the merge base, but
// not the blobs of the files that the pull request changes, nor the pack after its list of commits.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.ts';
import { generatedFile } from './pack.ts';

export { DIFF_HASH, REUSE_KEY } from '../../protocol/src/index.ts';

/**
 * Change this number when the engine reads the same input in a different way (a new section of the
 * pack, a new check of the findings): the reviews of an earlier release are then not reused.
 */
export const REUSE_VERSION = 1;

const PROMPT = ['review.md', 'patch.md'].map((file) => readFileSync(join(import.meta.dirname, '..', 'prompts', file), 'utf8')).join('\n');

/**
 * The hash of the changed files that a review reads, from `git diff --raw base...head`: for each
 * file, its status, its old and new blob, its path and the old path of a rename. A generated or
 * binary file (pack.ts) is not in the hash: the review does not read it.
 */
export function diffHash(repoDir: string, base: string, head: string): string {
  const fields = git(repoDir, 'diff', '--raw', '-z', '--no-abbrev', `${base}...${head}`).split('\0');
  const rows: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const meta = fields[i];
    if (!meta?.startsWith(':')) continue;
    // `:100644 100644 <old blob> <new blob> <status>`, then one path, or two for a rename or a copy.
    const [, , oldBlob, newBlob, status] = meta.slice(1).split(' ');
    const two = status?.startsWith('R') || status?.startsWith('C');
    const from = two ? fields[++i] : undefined;
    const path = fields[++i];
    if (!path || generatedFile(path)) continue;
    rows.push([status?.[0], oldBlob, newBlob, path, from ?? ''].join('\t'));
  }
  rows.sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);
}

/**
 * The key of the input of a review: the pack without its first lines (the two heads and the commits,
 * which a merge of the base branch changes), the level, the provider and its models, and the prompt.
 * The rest of the pack holds the diff, the docs, the rules, the answered threads, the imports and the
 * context: two reviews with the same key read the same thing. A new reply in a thread, a changed
 * rule or another model gives a new key, and a new review.
 * `toolsAt`: the head, when the level has tools (REV-68). The model can then read any file of the
 * head, so a new head always gets a new key.
 */
export function reuseKey(input: { packBody: string; level: string; provider: string; models: readonly string[]; toolsAt?: string | null }): string {
  const parts = {
    version: REUSE_VERSION,
    prompt: createHash('sha256').update(PROMPT).digest('hex'),
    pack: createHash('sha256').update(input.packBody).digest('hex'),
    level: input.level,
    provider: input.provider,
    models: input.models,
    tools: input.toolsAt ?? null,
  };
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
