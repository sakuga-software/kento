/**
 * Sakuga Review: one model call reviews a pull request, then the script posts the review.
 *
 *     node review/sakuga-review.ts --repo-dir <checkout> --base <sha> --head <sha> --dry-run
 *     node review/sakuga-review.ts --repo-dir <checkout> --repository <owner/name> --pr <n> --base <sha> --head <sha>
 *
 * Environment: OPENROUTER_API_KEY, and GITHUB_TOKEN to post. See README.md.
 * Node 24 or later runs this file as is: no package, no build. Keep to erasable TypeScript syntax.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const HERE = import.meta.dirname;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GITHUB_API = 'https://api.github.com';

// The model that answers, then the one that takes over when it fails. See askModel.
const MODELS = (process.env.REVIEW_MODELS ?? 'z-ai/glm-5.3,xiaomi/mimo-v2.6-pro').split(',');
const BOT_LOGIN = process.env.REVIEW_BOT_LOGIN ?? 'sakuga-review[bot]';

// The pack that the model reads, at most. A larger pull request loses its largest files first.
const MAX_PACK_BYTES = 240_000;
const MAX_FILE_CHANGED_LINES = 1000;
const MAX_DOC_LINES = 400;

// A finding blocks the merge at this severity and confidence.
const BLOCKING_SEVERITIES = new Set(['critical', 'major']);
const BLOCKING_CONFIDENCE = 70;
// Each inline comment is a thread that a person must resolve, so only the sure findings get one.
const INLINE_CONFIDENCE = 70;
const MAX_INLINE = 5;
// GLM-5.3 answers in 30 to 90 seconds. MiMo V2.6 Pro writes about 10,000 tokens of reasoning at
// 35 to 50 tokens a second, whatever the reasoning budget asks (measured on 2026-10-03): 4 to 6
// minutes. It only takes over when GLM-5.3 fails, with the time it needs. Both fit the 15 minutes.
const ATTEMPT_TIMEOUT_MS = process.env.REVIEW_TIMEOUT_MS
  ? [Number(process.env.REVIEW_TIMEOUT_MS), Number(process.env.REVIEW_TIMEOUT_MS)]
  : [180_000, 480_000];
// The most a provider can charge, in dollars a million tokens. Without it, the routing of OpenRouter
// sent GLM-5.3 to providers at $1.4 / $4.4, one of which reasons less and found less on the bench.
// The bench sets REVIEW_MAX_PRICE ("prompt,completion") to try a model above this cap.
const [MAX_PROMPT_PRICE, MAX_COMPLETION_PRICE] = (process.env.REVIEW_MAX_PRICE ?? '0.5,3.5').split(',').map(Number);
const MAX_PRICE = { prompt: MAX_PROMPT_PRICE, completion: MAX_COMPLETION_PRICE };
// A finding can anchor on a changed line this far from the line the model named.
const ANCHOR_DISTANCE = 10;

const SKIP =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock)$|\.snap$|(^|\/)(dist|build|vendor|\.next|\.react-router)\/|drizzle\/migrations\/meta\/|\.gen\.[a-z]+$|\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|mp4|webm|woff2?|ttf|otf|zip|tgz)$/;
const TEST_FILE = /\.test\.|\.spec\.|(^|\/)(tests?|__tests__)\//;

const MARKER_SUMMARY = '<!-- sakuga-review:summary -->';
const FINDING_KEY = /<!-- sakuga-review:finding ([0-9a-f]{12}) -->/;
const MARKER_GONE = '<!-- sakuga-review:gone -->';
const BLOCK_START = '<!-- sakuga-review:start -->';
const BLOCK_END = '<!-- sakuga-review:end -->';
const REVIEW_COUNT = /<!-- sakuga-review:count (\d+) -->/;

const SEVERITY_ORDER = ['critical', 'major', 'minor'] as const;
const CATEGORIES = ['bug', 'security', 'data', 'contract', 'test'] as const;
// The priority that a reader sees: P0 blocks hardest. The colours follow the score labels.
const PRIORITY = { critical: ['P0', 'b60205'], major: ['P1', 'e67e22'], minor: ['P2', '6c757d'] } as const;
const SCORE_COLOUR = ['', 'b60205', 'd93f0b', 'fbca04', 'a2d9a5', '0e8a16'];
const LABEL_PREFIX = 'review: ';

type Severity = (typeof SEVERITY_ORDER)[number];
type Finding = {
  path: string;
  start_line: number;
  line: number;
  severity: Severity;
  category: (typeof CATEGORIES)[number];
  confidence: number;
  title: string;
  scenario: string;
  fix: string;
  suggestion: string;
};
type Answer = {
  confidence_score: number;
  risk: string;
  summary: string;
  diagram: string;
  findings: Finding[];
  not_reviewed: string[];
};
type Usage = { model?: string; provider?: string; prompt_tokens?: number; completion_tokens?: number; cost?: number };
type ChangedLines = Map<string, Set<number>>;
type Thread = {
  id: string;
  resolved: boolean;
  path: string;
  key: string;
  commit?: string;
  commentId: number;
  answered: boolean;
};

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    start_line: { type: 'integer' },
    line: { type: 'integer' },
    severity: { type: 'string', enum: SEVERITY_ORDER },
    category: { type: 'string', enum: CATEGORIES },
    confidence: { type: 'integer' },
    title: { type: 'string' },
    scenario: { type: 'string' },
    fix: { type: 'string' },
    suggestion: { type: 'string' },
  },
  required: ['path', 'start_line', 'line', 'severity', 'category', 'confidence', 'title', 'scenario', 'fix', 'suggestion'],
  additionalProperties: false,
};
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    confidence_score: { type: 'integer' },
    risk: { type: 'string' },
    summary: { type: 'string' },
    diagram: { type: 'string' },
    findings: { type: 'array', items: FINDING_SCHEMA },
    not_reviewed: { type: 'array', items: { type: 'string' } },
  },
  required: ['confidence_score', 'risk', 'summary', 'diagram', 'findings', 'not_reviewed'],
  additionalProperties: false,
};

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

const log = (message: string) => process.stderr.write(`${message}\n`);

// The pack

/**
 * The changed files with their counts of added and removed lines (`-` for a binary file). Without
 * `-z`, git writes a rename as `dir/{a => b}/file.ts`, which no git command takes as a path.
 */
function numstat(repo: string, base: string, head: string): { added: string; removed: string; path: string; from?: string }[] {
  const fields = git(repo, 'diff', '--numstat', '-z', `${base}...${head}`).split('\0');
  const rows: { added: string; removed: string; path: string; from?: string }[] = [];
  for (let i = 0; i < fields.length && fields[i]; i++) {
    const [added, removed, ...rest] = fields[i].split('\t');
    // A path can hold a tab: with -z, git writes it as is.
    const path = rest.join('\t');
    if (path) rows.push({ added, removed, path });
    else rows.push({ added, removed, from: fields[++i], path: fields[++i] });
  }
  return rows;
}

/** The first message of the review, and the files left out with their reason. */
function buildPack(repo: string, base: string, head: string): { pack: string; skipped: string[] } {
  const reviewed: string[] = [];
  const skipped: string[] = [];
  // The old path of each renamed file: the diff of a rename needs both paths.
  const renamedFrom = new Map<string, string>();
  for (const { added, removed, path, from } of numstat(repo, base, head)) {
    if (SKIP.test(path)) skipped.push(`${path} : fichier généré ou binaire`);
    else if (added !== '-' && Number(added) + Number(removed) > MAX_FILE_CHANGED_LINES)
      skipped.push(`${path} : plus de ${MAX_FILE_CHANGED_LINES} lignes modifiées`);
    else reviewed.push(path);
    if (from) renamedFrom.set(path, from);
  }

  const hunks = new Map<string, string>();
  for (const path of reviewed) {
    const paths = renamedFrom.has(path) ? [renamedFrom.get(path)!, path] : [path];
    hunks.set(path, git(repo, 'diff', TEST_FILE.test(path) ? '-U3' : '-W', `${base}...${head}`, '--', ...paths));
  }

  let docs = '';
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    if (!git(repo, 'ls-tree', '--name-only', head, '--', doc).trim()) continue;
    const text = git(repo, 'show', `${head}:${doc}`);
    if (text.split('\n').length <= MAX_DOC_LINES) docs += `## ${doc}\n\n${text}\n\n`;
  }

  const commits = git(repo, 'log', '--format=- %h %s', `${base}..${head}`);
  const budget = MAX_PACK_BYTES - docs.length - commits.length - 2000;
  const size = () => [...hunks.values()].reduce((sum, hunk) => sum + hunk.length, 0);
  // Drop the largest diffs first: the small ones are where most of the logic of a change sits.
  for (const [path] of [...hunks].sort((a, b) => b[1].length - a[1].length)) {
    if (size() <= budget) break;
    skipped.push(`${path} : retiré pour tenir dans la taille maximale de la revue`);
    hunks.delete(path);
  }

  const parts = [`# Pull request ${base.slice(0, 9)}...${head.slice(0, 9)}\n\n## Commits\n\n${commits}\n`];
  if (skipped.length) parts.push(`## Not reviewed\n\n${skipped.map((s) => `- ${s}\n`).join('')}\n`);
  parts.push(docs);
  parts.push(
    '## Diff\n\nEach hunk of a source file shows the whole function around the change. ' +
      'A test file shows three lines of context.\n\n```diff\n',
  );
  for (const path of reviewed) if (hunks.has(path)) parts.push(hunks.get(path)!);
  parts.push('```\n');
  return { pack: parts.join(''), skipped };
}

/** The line numbers, in the new version of each file, that the pull request adds or changes. */
function changedLines(repo: string, base: string, head: string): ChangedLines {
  const lines: ChangedLines = new Map();
  let path: string | null = null;
  for (const row of git(repo, 'diff', '-U0', `${base}...${head}`).split('\n')) {
    if (row.startsWith('+++ ')) {
      path = row.startsWith('+++ b/') ? row.slice(6) : null;
      if (path && !lines.has(path)) lines.set(path, new Set());
    } else if (row.startsWith('@@') && path) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(row)!;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let n = start; n < start + count; n++) lines.get(path)!.add(n);
    }
  }
  return lines;
}

/** The changed line to comment on, or null when the finding sits outside the diff. */
function anchor(finding: Finding, lines: ChangedLines): number | null {
  const candidates = [...(lines.get(finding.path.replace(/^\/+/, '')) ?? [])];
  if (!candidates.length) return null;
  if (candidates.includes(finding.line)) return finding.line;
  const nearest = candidates.reduce((a, b) => (Math.abs(b - finding.line) < Math.abs(a - finding.line) ? b : a));
  return Math.abs(nearest - finding.line) <= ANCHOR_DISTANCE ? nearest : null;
}

/**
 * A finding blocks only on a line that the pull request changes: the bench saw the model block a
 * clean pull request for code that the pull request did not touch.
 */
function isBlocking(finding: Finding, lines: ChangedLines): boolean {
  return (
    BLOCKING_SEVERITIES.has(finding.severity) &&
    finding.confidence >= BLOCKING_CONFIDENCE &&
    anchor(finding, lines) !== null
  );
}

function findingKey(finding: Finding): string {
  const title = finding.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(`${finding.path.replace(/^\/+/, '')}\n${title}`).digest('hex').slice(0, 12);
}

// The model

type Reply = { answer: Answer; usage: Usage };

/** One call to one model. It throws on an error, a timeout or an answer that is not the schema. */
async function callModel(model: string, prompt: string, pack: string, timeoutMs: number): Promise<Reply> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'Sakuga Review',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      reasoning: { effort: 'low' },
      usage: { include: true },
      // The diff goes only to a provider that keeps nothing and trains on nothing, and that honours
      // the answer schema. Of those, the cheapest under MAX_PRICE answers first.
      provider: { zdr: true, data_collection: 'deny', require_parameters: true, sort: 'price', max_price: MAX_PRICE },
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: pack },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'review', strict: true, schema: ANSWER_SCHEMA } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`OpenRouter answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const out = await response.json();
  const content: string = out.choices?.[0]?.message?.content ?? '';
  const answer: Answer = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
  answer.findings = (answer.findings ?? []).filter((f) => f && typeof f.path === 'string' && f.path);
  return { answer, usage: { model: out.model, provider: out.provider, ...out.usage } };
}

async function askModel(pack: string): Promise<Reply> {
  const prompt = readFileSync(join(HERE, 'prompt.md'), 'utf8');
  let lastError: unknown;
  for (const [attempt, model] of MODELS.slice(0, 2).entries()) {
    try {
      return await callModel(model, prompt, pack, ATTEMPT_TIMEOUT_MS[attempt]);
    } catch (error) {
      lastError = error;
      log(`attempt ${attempt + 1} with ${model} failed: ${error}`);
    }
  }
  throw new Error(`no model gave a usable answer: ${lastError}`);
}

// GitHub

async function github(method: string, path: string, payload?: unknown): Promise<any> {
  const response = await fetch(path.startsWith('http') ? path : GITHUB_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function graphql(query: string, variables: Record<string, unknown>): Promise<any> {
  const out = await github('POST', '/graphql', { query, variables });
  if (out.errors) throw new Error(`GraphQL: ${JSON.stringify(out.errors)}`);
  return out.data;
}

/** The review threads that this bot opened on the pull request. */
async function botThreads(owner: string, name: string, number: number): Promise<Thread[]> {
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id isResolved path
              comments(first: 50) { nodes { databaseId body author { login } commit { oid } } }
            }
          }
        }
      }
    }`;
  const logins = new Set([BOT_LOGIN, BOT_LOGIN.replace(/\[bot\]$/, '')]);
  const threads: Thread[] = [];
  let after: string | null = null;
  for (;;) {
    const data = await graphql(query, { owner, name, number, after });
    const page = data.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      const first = node.comments.nodes[0];
      if (!first || !logins.has(first.author?.login)) continue;
      const key = FINDING_KEY.exec(first.body);
      if (key) {
        threads.push({
          id: node.id,
          resolved: node.isResolved,
          path: node.path,
          key: key[1],
          commit: first.commit?.oid,
          commentId: first.databaseId,
          // A later comment of the bot in the thread is its reply that the finding is gone.
          answered: node.comments.nodes
            .slice(1)
            .some((c: { body: string; author?: { login: string } }) => c.body.includes(MARKER_GONE) || logins.has(c.author?.login ?? '')),
        });
      }
    }
    if (!page.pageInfo.hasNextPage) return threads;
    after = page.pageInfo.endCursor;
  }
}

// The review

const badge = (label: string, colour: string) =>
  `<img alt="${label}" src="https://img.shields.io/badge/${encodeURIComponent(label)}-${colour}?style=flat-square" align="top">`;

function badges(finding: Finding): string {
  const [priority, colour] = PRIORITY[finding.severity];
  return badge(priority, colour) + (finding.category === 'security' ? ` ${badge('sécurité', '8e44ad')}` : '');
}

/**
 * The score that the reader sees. A blocking finding caps it at 2: a review that asks for changes
 * and calls the pull request safe would contradict itself.
 */
function score(answer: Answer, lines: ChangedLines): number {
  const raw = Math.min(5, Math.max(1, Math.round(answer.confidence_score || 3)));
  return answer.findings.some((f) => isBlocking(f, lines)) ? Math.min(raw, 2) : raw;
}

/** The diagram, or null when the model gave none or a shape that GitHub could fail to render. */
function diagram(answer: Answer): string | null {
  const text = answer.diagram.replace(/^```(mermaid)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!/^(flowchart|graph)\s+(LR|RL|TD|TB)\b/.test(text)) return null;
  const rows = text.split('\n');
  // `click` can open a link, and `style`/`classDef` fight the theme of the reader.
  if (rows.length > 40 || text.length > 3000 || rows.some((r) => /^\s*(click|style|classDef|class)\b/.test(r))) return null;
  // GitHub reads `<` and `>` in a label as HTML and can drop the diagram.
  return text.replace(/"([^"]*)"/g, (_, label: string) => `"${label.replace(/</g, '‹').replace(/>/g, '›')}"`);
}

/** A suggestion goes on the exact lines the model named, when all of them are changed lines. */
function suggestionRange(finding: Finding, lines: ChangedLines): [number, number] | null {
  if (!finding.suggestion.trim()) return null;
  const changed = lines.get(finding.path.replace(/^\/+/, '')) ?? new Set<number>();
  const start = Math.min(finding.start_line || finding.line, finding.line);
  if (finding.line - start > 30) return null;
  for (let n = start; n <= finding.line; n++) if (!changed.has(n)) return null;
  return [start, finding.line];
}

function inlineBody(finding: Finding, withSuggestion: boolean): string {
  const out = [`${badges(finding)} **${finding.title}**`, '', finding.scenario, '', `**Correction :** ${finding.fix}`];
  if (withSuggestion) out.push('', '```suggestion', finding.suggestion.replace(/\n$/, ''), '```');
  out.push('', `<!-- sakuga-review:finding ${findingKey(finding)} -->`);
  return out.join('\n');
}

// The score from which a review with no blocking finding approves the pull request.
const APPROVE_SCORE = 4;

/** REQUEST_CHANGES on a sure blocking finding, APPROVE on a score of 4 or 5, COMMENT otherwise. */
function verdict(answer: Answer, lines: ChangedLines): 'REQUEST_CHANGES' | 'APPROVE' | 'COMMENT' {
  if (answer.findings.some((f) => isBlocking(f, lines))) return 'REQUEST_CHANGES';
  return score(answer, lines) >= APPROVE_SCORE ? 'APPROVE' : 'COMMENT';
}

function reviewBody(answer: Answer, lines: ChangedLines): string {
  const blocking = answer.findings.filter((f) => isBlocking(f, lines)).length;
  const head = blocking
    ? `⛔ ${blocking} point${blocking > 1 ? 's' : ''} bloquant${blocking > 1 ? 's' : ''}`
    : answer.findings.length
      ? '⚠️ Rien de bloquant'
      : '✅ Rien de bloquant';
  return (
    `${MARKER_SUMMARY}\n**Score de confiance : ${score(answer, lines)}/5** · ${head} · ${answer.risk}\n\n` +
    '<sub>Le résumé, le diagramme et la liste des constats sont à la fin de la description de la PR.</sub>'
  );
}

type Link = { finding: Finding; url: string | null };

function descriptionBlock(
  answer: Answer,
  links: Link[],
  skipped: string[],
  resolved: number,
  usage: Usage,
  lines: ChangedLines,
  context: { count: number; head: string; subject: string; commitUrl: string },
): string {
  const out = [BLOCK_START, '', '---', '', `<h2>Sakuga Review · Score de confiance : ${score(answer, lines)}/5</h2>`, '', answer.risk, ''];
  if (links.length) {
    out.push('<h3>Constats</h3>', '');
    links.forEach(({ finding: f, url }, i) => {
      // The line of the thread: the nearest changed line when the model named one outside the diff.
      const where = `\`${f.path}:${anchor(f, lines) ?? f.line}\``;
      out.push(`${i + 1}. ${badges(f)}&nbsp;**${f.title}** ${where}${url ? ` <a href="${url}">▶</a>` : ''}`);
      // A finding with no thread shows its scenario here: this is the only place it appears.
      if (!url) out.push(`   ${f.scenario} **Correction :** ${f.fix}`);
    });
    out.push('');
  }
  out.push('<details><summary>Résumé</summary>', '', answer.summary, '');
  if (resolved) {
    out.push(`${resolved} constat${resolved > 1 ? 's' : ''} d'une revue précédente n'apparai${resolved > 1 ? 'ssent' : 't'} plus : le fil peut être résolu.`, '');
  }
  out.push('</details>', '');
  const flow = diagram(answer);
  if (flow) out.push('<details><summary>Diagramme</summary>', '', '```mermaid', "%%{init: {'theme': 'neutral'}}%%", flow, '```', '</details>', '');
  const notReviewed = [...skipped, ...answer.not_reviewed.filter((n) => !skipped.includes(n))];
  if (notReviewed.length) out.push('<details><summary>Non relu</summary>', '', ...notReviewed.map((n) => `- ${n}`), '', '</details>', '');
  const cost = typeof usage.cost === 'number' ? ` · ${usage.cost.toFixed(3)} $` : '';
  const subject = context.subject.length > 50 ? `${context.subject.slice(0, 47)}...` : context.subject;
  out.push(
    `<sub>Revues (${context.count}) · Dernier commit relu : [${subject.replace(/[[\]]/g, '')}](${context.commitUrl}) · \`${usage.model}\`${cost}</sub>`,
    '',
    `<!-- sakuga-review:count ${context.count} -->`,
    BLOCK_END,
  );
  return out.join('\n');
}

/** The body of the pull request with the block of the review at its end, in place of the earlier one. */
function withBlock(body: string, block: string): string {
  const start = body.indexOf(BLOCK_START);
  const end = body.indexOf(BLOCK_END);
  if (start !== -1 && end > start) return body.slice(0, start) + block + body.slice(end + BLOCK_END.length);
  return `${body.replace(/\s+$/, '')}\n\n${block}`;
}

/** One label `review: N/5` on the pull request, created on the first use in a repository. */
async function setScoreLabel(owner: string, name: string, pr: number, value: number) {
  const label = `${LABEL_PREFIX}${value}/5`;
  const repo = `/repos/${owner}/${name}`;
  try {
    await github('GET', `${repo}/labels/${encodeURIComponent(label)}`);
  } catch {
    await github('POST', `${repo}/labels`, {
      name: label,
      color: SCORE_COLOUR[value],
      description: 'Score de confiance de Sakuga Review (5 : prête à merger)',
    });
  }
  const current: { name: string }[] = (await github('GET', `${repo}/issues/${pr}/labels`)) ?? [];
  for (const old of current) {
    if (old.name.startsWith(LABEL_PREFIX) && old.name !== label) {
      await github('DELETE', `${repo}/issues/${pr}/labels/${encodeURIComponent(old.name)}`);
    }
  }
  await github('POST', `${repo}/issues/${pr}/labels`, { labels: [label] });
}

type Args = { repoDir: string; repository: string; pr: number; head: string };

async function post(args: Args, answer: Answer, usage: Usage, skipped: string[], lines: ChangedLines) {
  const [owner, name] = args.repository.split('/');
  const threads = await botThreads(owner, name, args.pr);
  const openThreads = new Map(threads.filter((t) => !t.resolved).map((t) => [t.key, t]));
  const keysNow = new Set(answer.findings.map(findingKey));
  const threadUrl = (commentId: number) => `https://github.com/${owner}/${name}/pull/${args.pr}#discussion_r${commentId}`;

  const ordered = [...answer.findings].sort(
    (a, b) =>
      Number(isBlocking(b, lines)) - Number(isBlocking(a, lines)) ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.confidence - a.confidence,
  );
  const inline: Finding[] = [];
  const comments: { path: string; line: number; start_line?: number; side: 'RIGHT'; start_side?: 'RIGHT'; body: string }[] = [];
  for (const f of ordered) {
    if (openThreads.has(findingKey(f))) continue;
    const line = anchor(f, lines);
    if (line === null || f.confidence < INLINE_CONFIDENCE || inline.length >= MAX_INLINE) continue;
    const range = line === f.line ? suggestionRange(f, lines) : null;
    const comment: (typeof comments)[number] = { path: f.path.replace(/^\/+/, ''), line, side: 'RIGHT', body: inlineBody(f, range !== null) };
    if (range && range[0] < range[1]) Object.assign(comment, { start_line: range[0], start_side: 'RIGHT' });
    inline.push(f);
    comments.push(comment);
  }

  // A thread closes only when its file changed since the comment and the finding did not come back.
  // A finding that the model did not repeat is not a fixed finding: the same code can be read twice.
  let resolved = 0;
  for (const t of threads) {
    if (t.resolved || t.answered || keysNow.has(t.key) || !t.commit) continue;
    if (!git(args.repoDir, 'diff', '--name-only', `${t.commit}..${args.head}`, '--', t.path).trim()) continue;
    try {
      await graphql('mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }', { id: t.id });
    } catch (error) {
      // GitHub refuses this mutation to an App that cannot write the contents. The reply tells the
      // person who resolves the thread why it can go.
      log(`cannot resolve thread ${t.id}: ${error}`);
      await github('POST', `/repos/${owner}/${name}/pulls/${args.pr}/comments/${t.commentId}/replies`, {
        body:
          `Ce constat n'apparaît plus au commit \`${args.head.slice(0, 9)}\`, et le fichier a changé depuis. ` +
          `Le fil peut être résolu.\n\n${MARKER_GONE}`,
      });
    }
    resolved++;
  }

  const review = { commit_id: args.head, body: reviewBody(answer, lines), event: verdict(answer, lines), comments };
  const path = `/repos/${owner}/${name}/pulls/${args.pr}/reviews`;
  let posted;
  try {
    posted = await github('POST', path, review);
  } catch (error) {
    if (!String(error).includes('422') || !comments.length) throw error;
    // A line that the API refuses drops the inline comments, never the review.
    log(`the inline comments were refused, the review goes without them: ${error}`);
    comments.length = 0;
    inline.length = 0;
    posted = await github('POST', path, { ...review, comments: [] });
  }

  // A COMMENT does not lift an earlier REQUEST_CHANGES, so the review of the previous head would keep
  // the pull request blocked after its findings are fixed. An APPROVE lifts it, and the dismissal
  // also clears it from the list of reviews.
  for (const previous of (await github('GET', `${path}?per_page=100`)) ?? []) {
    if (previous.user.login === BOT_LOGIN && previous.state === 'CHANGES_REQUESTED' && previous.id !== posted.id) {
      await github('PUT', `${path}/${previous.id}/dismissals`, { message: 'Remplacée par la revue du dernier commit.', event: 'DISMISS' });
    }
  }

  // Each finding links to its thread: a new comment of this review, or the open thread that carries it.
  const postedComments: { id: number; body: string }[] = inline.length
    ? ((await github('GET', `${path}/${posted.id}/comments?per_page=100`)) ?? [])
    : [];
  const newThreads = new Map(
    postedComments.flatMap((c) => {
      const key = FINDING_KEY.exec(c.body);
      return key ? [[key[1], c.id] as const] : [];
    }),
  );
  const links: Link[] = ordered.map((f) => {
    const key = findingKey(f);
    const id = newThreads.get(key) ?? openThreads.get(key)?.commentId;
    return { finding: f, url: id ? threadUrl(id) : null };
  });

  // The block goes at the end of the description, read again just before the write: the author can
  // edit the description while the review runs.
  const prPath = `/repos/${owner}/${name}/pulls/${args.pr}`;
  const current = (await github('GET', prPath)).body ?? '';
  const count = Number(REVIEW_COUNT.exec(current)?.[1] ?? 0) + 1;
  const subject = git(args.repoDir, 'log', '-1', '--format=%s', args.head).trim();
  const block = descriptionBlock(answer, links, skipped, resolved, usage, lines, {
    count,
    head: args.head,
    subject,
    commitUrl: `https://github.com/${owner}/${name}/commit/${args.head}`,
  });
  await github('PATCH', prPath, { body: withBlock(current, block) });
  await setScoreLabel(owner, name, args.pr, score(answer, lines));
  return { posted, inlineCount: comments.length, resolved, score: score(answer, lines) };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'repo-dir': { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      repository: { type: 'string' },
      pr: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const repoDir = values['repo-dir'];
  if (!repoDir || !values.base || !values.head) throw new Error('--repo-dir, --base and --head are required');

  // --base is the tip of the base branch: the diff starts at the merge base.
  const base = git(repoDir, 'merge-base', values.base, values.head).trim();
  const { pack, skipped } = buildPack(repoDir, base, values.head);
  const lines = changedLines(repoDir, base, values.head);
  const { answer, usage } = await askModel(pack);
  log(
    `model=${usage.model} provider=${usage.provider} tokens=${usage.prompt_tokens}+${usage.completion_tokens} ` +
      `cost=${usage.cost} score=${score(answer, lines)}/5 verdict=${verdict(answer, lines)} findings=${answer.findings.length} ` +
      `diagram=${diagram(answer) ? 'yes' : 'no'}`,
  );

  if (values['dry-run']) {
    const findings = answer.findings.map((f) => ({
      ...f,
      anchor: anchor(f, lines),
      blocking: isBlocking(f, lines),
      suggestion_range: anchor(f, lines) === f.line ? suggestionRange(f, lines) : null,
    }));
    const block = descriptionBlock(
      answer,
      answer.findings.map((finding) => ({ finding, url: null })),
      skipped,
      0,
      usage,
      lines,
      { count: 1, head: values.head, subject: git(repoDir, 'log', '-1', '--format=%s', values.head).trim(), commitUrl: '#' },
    );
    console.log(JSON.stringify({ answer: { ...answer, findings }, usage, skipped, pack_bytes: pack.length, block }, null, 2));
    return;
  }
  if (!values.repository || !values.pr) throw new Error('--repository and --pr are required to post');
  const { posted, inlineCount, resolved, score: value } = await post(
    { repoDir, repository: values.repository, pr: Number(values.pr), head: values.head },
    answer,
    usage,
    skipped,
    lines,
  );
  log(`posted review ${posted.id} (${posted.state}) with ${inlineCount} inline comments, ${resolved} threads resolved, score ${value}/5`);
}

main().catch((error) => {
  log(String(error?.stack ?? error));
  process.exit(1);
});
