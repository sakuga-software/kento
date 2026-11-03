/**
 * Each review comment that a `<!-- claude-reply -->` answers, with what the answer says of it:
 *
 *     ANTHROPIC_API_KEY=... node eval/internal/label.ts <comments dir> <labels.jsonl>
 *
 * The comments dir holds the output of collect.sh. Claude Haiku 5.5 reads the comment and the answer,
 * and gives the outcome, the category of Martian, the severity, and the defect in one sentence. A
 * comment that labels.jsonl holds already is not read again.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { costFromTable } from '../../packages/engine/src/prices.ts';

type Comment = {
  id: number;
  in_reply_to_id?: number;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  original_commit_id: string;
  pull_request_url: string;
  user: { login: string };
  created_at: string;
};

export type Label = {
  repo: string;
  pr: number;
  comment_id: number;
  reviewer: string;
  commit: string;
  path: string;
  line: number | null;
  outcome: 'applied' | 'partly' | 'wrong' | 'out_of_scope' | 'accepted' | 'duplicate' | 'unclear';
  category: string;
  severity: 'High' | 'Medium' | 'Low';
  defect: string;
};

const MODEL = 'claude-haiku-5-5';
const AT_ONCE = 8;
const BODY_CHARS = 4000;

const PROMPT = `A reviewer left a comment on a line of a pull request. The author answered it. Read both, and
answer with one JSON object, with no text around it:

{"outcome": "...", "category": "...", "severity": "...", "defect": "..."}

- outcome: what the answer says of the comment.
  - "applied": the author fixed the code as the comment asks, or in another way.
  - "partly": the author fixed a part of what the comment asks.
  - "wrong": the author shows that the premise of the comment is false: the defect does not exist.
  - "out_of_scope": the defect exists, but the author leaves it for another pull request or ticket.
  - "accepted": the defect exists, but the author keeps the code on purpose (an accepted risk, a convention).
  - "duplicate": the answer points to another comment that holds the same defect.
  - "unclear": the answer does not say.
- category: one of bug, security, concurrency, data, api, perf, test_gap, doc_defect, style, speculative.
  "api" is a broken contract between two parts of the code. "speculative" is a risk with no concrete trigger.
- severity: "High" for a wrong result, a crash, a security hole or lost data on a real path;
  "Medium" for a defect with an unusual trigger or a limited impact; "Low" for style, wording, a test or a doc.
- defect: the defect that the comment names, in one English sentence of 30 words or less, that starts
  with the file name and the line, for example "route.ts:29 the body is read before validation, so a
  null body gives 500 instead of 400". Write it even if the outcome is "wrong".`;

function flatten(dir: string): { repo: string; comments: Comment[] }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ repo: basename(name, '.json'), comments: JSON.parse(readFileSync(join(dir, name), 'utf8')) as Comment[] }));
}

async function ask(comment: Comment, answer: Comment): Promise<{ json: Omit<Label, 'repo' | 'pr' | 'comment_id' | 'reviewer' | 'commit' | 'path' | 'line'>; cost: number }> {
  const user = `File: ${comment.path}, line ${comment.original_line ?? comment.line}\n\nComment of ${comment.user.login}:\n${comment.body.slice(0, BODY_CHARS)}\n\nAnswer of the author:\n${answer.body.slice(0, BODY_CHARS)}`;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, thinking: { type: 'disabled' }, system: PROMPT, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(120_000),
    });
    const out = await response.json();
    if (!response.ok) {
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
        continue;
      }
      throw new Error(`Anthropic answered ${response.status}: ${JSON.stringify(out).slice(0, 300)}`);
    }
    const text: string = out.content.filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text).join('');
    const usage = out.usage ?? {};
    const cost = costFromTable('anthropic', MODEL, { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: 0, cacheWrite: 0 }) ?? 0;
    return { json: JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)), cost };
  }
}

async function main() {
  const [dir, out] = process.argv.slice(2);
  const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((line) => (JSON.parse(line) as Label).comment_id) : []);
  const work: { repo: string; comment: Comment; answer: Comment }[] = [];
  for (const { repo, comments } of flatten(dir)) {
    const answers = new Map<number, Comment>();
    for (const c of comments) if (c.in_reply_to_id && c.body.includes('<!-- claude-reply -->') && !answers.has(c.in_reply_to_id)) answers.set(c.in_reply_to_id, c);
    for (const c of comments) {
      const answer = answers.get(c.id);
      if (!c.in_reply_to_id && answer && !done.has(c.id)) work.push({ repo, comment: c, answer });
    }
  }
  console.log(`${work.length} comments to label`);
  let cost = 0, next = 0, failed = 0;
  await Promise.all(
    Array.from({ length: AT_ONCE }, async () => {
      while (next < work.length) {
        const { repo, comment, answer } = work[next++];
        try {
          const { json, cost: spent } = await ask(comment, answer);
          cost += spent;
          const label: Label = {
            repo,
            pr: Number(comment.pull_request_url.split('/').pop()),
            comment_id: comment.id,
            reviewer: comment.user.login,
            commit: comment.original_commit_id,
            path: comment.path,
            line: comment.original_line ?? comment.line,
            ...json,
          };
          appendFileSync(out, `${JSON.stringify(label)}\n`);
        } catch (error) {
          failed++;
          console.error(`${repo} comment ${comment.id}: ${String(error).slice(0, 200)}`);
        }
      }
    }),
  );
  console.log(`done: ${work.length - failed} labelled, ${failed} failed, $${cost.toFixed(3)}`);
}

await main();
