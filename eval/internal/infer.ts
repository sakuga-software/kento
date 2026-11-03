/**
 * Labels for the review comments that no `<!-- claude-reply -->` answers, from what the code became.
 *
 *     ANTHROPIC_API_KEY=... node eval/internal/infer.ts <comments.json> <repo dir> <labels.jsonl>
 *
 * 1. For each comment, git gives the change of its lines (3 lines around) between the commit that the
 *    reviewer read and the last head of the pull request (`refs/remotes/pull/<n>`, see README.md).
 *    Claude Haiku 5.5 reads the comment and that change: the code addresses the comment, or not.
 * 2. Two comments of one pull request on one file, at 5 lines or less, can ask for opposite things:
 *    "add a guard", then "remove this guard". Haiku reads each such pair. When they contradict each
 *    other, the comment that the last head does not follow gets the outcome "wrong", and the other
 *    one keeps its outcome: the author chose. Each label of a contradiction holds the id of the other comment.
 *
 * The labels have the shape of label.ts, so that build.ts reads both.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { costFromTable } from '../../packages/engine/src/prices.ts';
import type { Label } from './label.ts';

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
export type Inferred = Label & { contradicts?: number };

const MODEL = 'claude-haiku-5-5';
/** A pair needs more judgment than one comment: two reviewers often name one defect in other words. */
const PAIR_MODEL = 'claude-sonnet-5-5';
const AT_ONCE = 8;
const BODY_CHARS = 3000;
const AROUND = 3;
const PAIR_LINES = 5;

const OUTCOME_PROMPT = `A reviewer left a comment on a line of a pull request. Later commits of the pull request changed
the code. You get the comment, then the change of the lines around it between the commit that the
reviewer read and the last commit (empty when these lines did not change). Answer with one JSON
object, with no text around it:

{"outcome": "...", "category": "...", "severity": "...", "defect": "..."}

- outcome: "applied" when the change does what the comment asks, or removes the defect in another
  way; "partly" when it does a part of it; "ignored" when the lines did not change or the change does
  not address the comment; "unclear" when you cannot tell.
- category: one of bug, security, concurrency, data, api, perf, test_gap, doc_defect, style, speculative.
- severity: "High" for a wrong result, a crash, a security hole or lost data on a real path;
  "Medium" for an unusual trigger or a limited impact; "Low" for style, wording, a test or a doc.
- defect: the defect that the comment names, in one English sentence of 30 words or less, that starts
  with the file name and the line.`;

const PAIR_PROMPT = `Two review comments of one pull request sit near the same lines of one file. The first one is older.
Answer with one JSON object, with no text around it:

{"relation": "same"|"different"|"opposite", "last_head_follows": "first"|"second"|"both"|"neither"}

- relation:
  - "same": the two comments name the same defect, even in other words or with another fix.
  - "different": they name two different defects, or one names a defect and the other a detail.
  - "opposite": they cannot both be right. The second asks to undo what the first one asked, or
    one calls a defect what the other one asks for, or one says that a defect exists and the other
    one says that the same code is correct.
- last_head_follows: which comment the code of the last head agrees with. You get that code.`;

function git(repo: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** The hunks of the change of a file between two commits that touch the lines around `line`. */
function changeAround(repo: string, from: string, to: string, path: string, line: number): string {
  const diff = git(repo, 'diff', '-U2', from, to, '--', path);
  const hunks = diff.split(/^(?=@@ )/m).slice(1);
  return hunks
    .filter((hunk) => {
      const m = /^@@ -(\d+)(?:,(\d+))? /.exec(hunk);
      if (!m) return false;
      const start = Number(m[1]);
      const end = start + Math.max(Number(m[2] ?? 1), 1) - 1;
      return start - AROUND <= line && line <= end + AROUND;
    })
    .join('')
    .slice(0, 6000);
}

async function ask<T>(system: string, user: string, model = MODEL): Promise<{ json: T; cost: number }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        // Sonnet 5.5 refuses `disabled`; it thinks on a pair, which needs judgment.
        body: JSON.stringify({ model, max_tokens: 8000, ...(model === MODEL ? { thinking: { type: 'disabled' } } : {}), system, messages: [{ role: 'user', content: user }] }),
        signal: AbortSignal.timeout(120_000),
      });
      const out = await response.json();
      if (!response.ok) throw new Error(`Anthropic answered ${response.status}`);
      const text: string = out.content.filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text).join('');
      const usage = out.usage ?? {};
      const cost = costFromTable('anthropic', model, { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: 0, cacheWrite: 0 }) ?? 0;
      return { json: JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)), cost };
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
    }
  }
}

async function pool<T>(items: T[], work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: AT_ONCE }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

async function main() {
  const [commentsFile, repo, out] = process.argv.slice(2);
  const repoName = basename(commentsFile, '.json');
  const comments: Comment[] = JSON.parse(readFileSync(commentsFile, 'utf8'));
  const answered = new Set(comments.filter((c) => c.in_reply_to_id && c.body.includes('<!-- claude-reply -->')).map((c) => c.in_reply_to_id));
  const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((line) => (JSON.parse(line) as Label).comment_id) : []);
  const top = comments.filter((c) => !c.in_reply_to_id && !answered.has(c.id) && (c.original_line ?? c.line));
  const pr = (c: Comment) => Number(c.pull_request_url.split('/').pop());
  const lineOf = (c: Comment) => (c.original_line ?? c.line)!;
  const last = new Map<number, string>();
  for (const c of top) if (!last.has(pr(c))) last.set(pr(c), git(repo, 'rev-parse', `refs/remotes/pull/${pr(c)}`).trim());
  let cost = 0, failed = 0;
  const labels = new Map<number, Inferred>();

  await pool(top.filter((c) => last.get(pr(c)) && !done.has(c.id)), async (c) => {
    const change = changeAround(repo, c.original_commit_id, last.get(pr(c))!, c.path, lineOf(c));
    const user = `File: ${c.path}, line ${lineOf(c)}\n\nComment of ${c.user.login}:\n${c.body.slice(0, BODY_CHARS)}\n\nChange of these lines up to the last commit:\n${change || '(no change)'}`;
    try {
      const { json, cost: spent } = await ask<Pick<Label, 'category' | 'severity' | 'defect'> & { outcome: string }>(OUTCOME_PROMPT, user);
      cost += spent;
      const outcome = json.outcome === 'ignored' ? 'unclear' : (json.outcome as Label['outcome']);
      labels.set(c.id, { repo: repoName, pr: pr(c), comment_id: c.id, reviewer: c.user.login, commit: c.original_commit_id, path: c.path, line: lineOf(c), ...json, outcome });
    } catch (error) {
      failed++;
      console.error(`comment ${c.id}: ${String(error).slice(0, 200)}`);
    }
  });

  const pairs: [Comment, Comment][] = [];
  const byFile = new Map<string, Comment[]>();
  for (const c of top) byFile.set(`${pr(c)} ${c.path}`, [...(byFile.get(`${pr(c)} ${c.path}`) ?? []), c]);
  for (const group of byFile.values()) {
    group.sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++)
        if (group[i].user.login !== group[j].user.login || group[i].original_commit_id !== group[j].original_commit_id)
          if (Math.abs(lineOf(group[i]) - lineOf(group[j])) <= PAIR_LINES) pairs.push([group[i], group[j]]);
  }
  let contradictions = 0;
  await pool(pairs, async ([first, second]) => {
    const head = last.get(pr(first));
    if (!head) return;
    const code = git(repo, 'show', `${head}:${first.path}`).split('\n');
    const from = Math.max(0, lineOf(first) - 15);
    const user = `File: ${first.path}\n\nFirst comment (${first.user.login}, line ${lineOf(first)}):\n${first.body.slice(0, BODY_CHARS)}\n\nSecond comment (${second.user.login}, line ${lineOf(second)}):\n${second.body.slice(0, BODY_CHARS)}\n\nCode of the last head, lines ${from + 1} to ${from + 40}:\n${code.slice(from, from + 40).join('\n')}`;
    try {
      const { json, cost: spent } = await ask<{ relation: string; last_head_follows: string }>(PAIR_PROMPT, user, PAIR_MODEL);
      cost += spent;
      if (json.relation !== 'opposite') return;
      contradictions++;
      const loser = json.last_head_follows === 'first' ? second : json.last_head_follows === 'second' ? first : null;
      for (const [c, other] of [[first, second], [second, first]] as const) {
        const label = labels.get(c.id);
        if (!label) continue;
        label.contradicts = other.id;
        if (c === loser) label.outcome = 'wrong';
        else if (!loser) label.outcome = 'unclear';
      }
    } catch (error) {
      failed++;
      console.error(`pair ${first.id} ${second.id}: ${String(error).slice(0, 200)}`);
    }
  });

  for (const label of labels.values()) appendFileSync(out, `${JSON.stringify(label)}\n`);
  console.log(`${repoName}: ${labels.size} labelled, ${pairs.length} pairs, ${contradictions} contradictions, ${failed} failed, $${cost.toFixed(3)}`);
}

await main();
