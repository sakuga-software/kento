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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const HERE = import.meta.dirname;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GITHUB_API = 'https://api.github.com';

// The first model answers. OpenRouter calls the next one if it fails.
const MODELS = (process.env.REVIEW_MODELS ?? 'xiaomi/mimo-v2.6-pro,z-ai/glm-5.3').split(',');
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
// Two attempts fit in the 15 minutes of the job.
const ATTEMPT_TIMEOUT_MS = 300_000;
// A finding can anchor on a changed line this far from the line the model named.
const ANCHOR_DISTANCE = 10;

const SKIP =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock)$|\.snap$|(^|\/)(dist|build|vendor|\.next|\.react-router)\/|drizzle\/migrations\/meta\/|\.gen\.[a-z]+$|\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|mp4|webm|woff2?|ttf|otf|zip|tgz)$/;
const TEST_FILE = /\.test\.|\.spec\.|(^|\/)(tests?|__tests__)\//;

const MARKER_SUMMARY = '<!-- sakuga-review:summary -->';
const FINDING_KEY = /<!-- sakuga-review:finding ([0-9a-f]{12}) -->/;
const MARKER_GONE = '<!-- sakuga-review:gone -->';

const SEVERITY_LABEL = { critical: '🔴 Critique', major: '🟠 Majeur', minor: '🟡 Mineur' } as const;
const SEVERITY_ORDER = ['critical', 'major', 'minor'] as const;

type Severity = (typeof SEVERITY_ORDER)[number];
type Finding = {
  path: string;
  line: number;
  severity: Severity;
  confidence: number;
  title: string;
  scenario: string;
  fix: string;
};
type Answer = {
  verdict: 'approve' | 'request_changes' | 'comment';
  pr_confidence: number;
  summary: string;
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
    line: { type: 'integer' },
    severity: { type: 'string', enum: SEVERITY_ORDER },
    confidence: { type: 'integer' },
    title: { type: 'string' },
    scenario: { type: 'string' },
    fix: { type: 'string' },
  },
  required: ['path', 'line', 'severity', 'confidence', 'title', 'scenario', 'fix'],
  additionalProperties: false,
};
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes', 'comment'] },
    pr_confidence: { type: 'integer' },
    summary: { type: 'string' },
    findings: { type: 'array', items: FINDING_SCHEMA },
    not_reviewed: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'pr_confidence', 'summary', 'findings', 'not_reviewed'],
  additionalProperties: false,
};

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

const log = (message: string) => process.stderr.write(`${message}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The pack

/** The first message of the review, and the files left out with their reason. */
function buildPack(repo: string, base: string, head: string): { pack: string; skipped: string[] } {
  const reviewed: string[] = [];
  const skipped: string[] = [];
  for (const row of git(repo, 'diff', '--numstat', `${base}...${head}`).split('\n').filter(Boolean)) {
    const [added, removed, path] = row.split('\t');
    if (SKIP.test(path)) skipped.push(`${path} : fichier généré ou binaire`);
    else if (added !== '-' && Number(added) + Number(removed) > MAX_FILE_CHANGED_LINES)
      skipped.push(`${path} : plus de ${MAX_FILE_CHANGED_LINES} lignes modifiées`);
    else reviewed.push(path);
  }

  const hunks = new Map<string, string>();
  for (const path of reviewed) {
    hunks.set(path, git(repo, 'diff', TEST_FILE.test(path) ? '-U3' : '-W', `${base}...${head}`, '--', path));
  }

  let docs = '';
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    const full = join(repo, doc);
    if (!existsSync(full)) continue;
    const text = readFileSync(full, 'utf8');
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

async function askModel(pack: string): Promise<{ answer: Answer; usage: Usage }> {
  const prompt = readFileSync(join(HERE, 'prompt.md'), 'utf8');
  const body = {
    max_tokens: 16000,
    reasoning: { effort: 'low' },
    usage: { include: true },
    // The diff goes only to a provider that keeps nothing and trains on nothing, and that honours
    // the answer schema.
    provider: { zdr: true, data_collection: 'deny', require_parameters: true },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: pack },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'review', strict: true, schema: ANSWER_SCHEMA } },
  };
  let lastError: unknown;
  // OpenRouter moves to the next model on an error, not on a slow answer: the second attempt
  // starts with the other model.
  for (const [attempt, models] of [MODELS, [...MODELS.slice(1), MODELS[0]]].entries()) {
    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Title': 'Sakuga Review',
        },
        body: JSON.stringify({ ...body, models }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`OpenRouter answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const out = await response.json();
      const content: string = out.choices?.[0]?.message?.content ?? '';
      const answer: Answer = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
      answer.findings = (answer.findings ?? []).filter((f) => f && typeof f.path === 'string' && f.path);
      return { answer, usage: { model: out.model, provider: out.provider, ...out.usage } };
    } catch (error) {
      lastError = error;
      log(`attempt ${attempt + 1} with ${models[0]} failed: ${error}`);
      await sleep(5000);
    }
  }
  throw new Error(`the model gave no usable answer: ${lastError}`);
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

function inlineBody(finding: Finding): string {
  return (
    `**${SEVERITY_LABEL[finding.severity]} · confiance ${finding.confidence} %** — ${finding.title}\n\n` +
    `${finding.scenario}\n\n**Correction :** ${finding.fix}\n\n<!-- sakuga-review:finding ${findingKey(finding)} -->`
  );
}

function summaryBody(
  answer: Answer,
  inline: Finding[],
  outside: Finding[],
  carried: Set<string>,
  resolved: number,
  skipped: string[],
  usage: Usage,
  lines: ChangedLines,
): string {
  const blocking = answer.findings.filter((f) => isBlocking(f, lines));
  const plural = blocking.length > 1 ? 's' : '';
  const heading = blocking.length
    ? `### ⛔ ${blocking.length} point${plural} bloquant${plural}`
    : answer.findings.length
      ? '### ⚠️ Rien de bloquant, des points à regarder'
      : '### ✅ Rien de bloquant';
  const out = [MARKER_SUMMARY, heading, '', `**Confiance dans la PR : ${answer.pr_confidence} %** · ${answer.summary}`, ''];

  if (answer.findings.length) {
    out.push('| | Confiance | Fichier | Constat |', '|---|---|---|---|');
    const sorted = [...answer.findings].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.confidence - a.confidence,
    );
    for (const f of sorted) {
      const where = inline.includes(f) ? 'en ligne' : carried.has(findingKey(f)) ? 'déjà signalé' : 'ci-dessous';
      out.push(`| ${SEVERITY_LABEL[f.severity]} | ${f.confidence} % | \`${f.path}:${f.line}\` (${where}) | ${f.title} |`);
    }
    out.push('');
  }
  if (outside.length) {
    out.push('<details>', '<summary>Constats sans commentaire en ligne</summary>', '');
    for (const f of outside) {
      out.push(
        `- **${SEVERITY_LABEL[f.severity]} · ${f.confidence} %** \`${f.path}:${f.line}\` — ${f.title}`,
        `  ${f.scenario} **Correction :** ${f.fix}`,
      );
    }
    out.push('', '</details>', '');
  }
  const notReviewed = [...skipped, ...answer.not_reviewed.filter((n) => !skipped.includes(n))];
  if (notReviewed.length) {
    out.push('<details>', '<summary>Non relu</summary>', '', ...notReviewed.map((n) => `- ${n}`), '', '</details>', '');
  }
  if (resolved) {
    const many = resolved > 1;
    out.push(
      `${resolved} constat${many ? 's' : ''} d'une revue précédente n'apparai${many ? 'ssent' : 't'} plus, et le code a changé : ` +
        "le fil est résolu, ou une réponse dit qu'il peut l'être.",
      '',
    );
  }
  const cost = typeof usage.cost === 'number' ? ` · ${usage.cost.toFixed(3)} $` : '';
  out.push(
    `<sub>Sakuga Review · \`${usage.model}\` · ${usage.prompt_tokens ?? '?'} jetons lus${cost}` +
      ' · une revue automatique ne remplace pas une relecture humaine.</sub>',
  );
  return out.join('\n');
}

type Args = { repoDir: string; repository: string; pr: number; head: string };

async function post(args: Args, answer: Answer, usage: Usage, skipped: string[], lines: ChangedLines) {
  const [owner, name] = args.repository.split('/');
  const threads = await botThreads(owner, name, args.pr);
  const openKeys = new Set(threads.filter((t) => !t.resolved).map((t) => t.key));
  const keysNow = new Set(answer.findings.map(findingKey));

  const inline: Finding[] = [];
  const outside: Finding[] = [];
  const comments: { path: string; line: number; side: 'RIGHT'; body: string }[] = [];
  const ordered = [...answer.findings].sort(
    (a, b) => Number(isBlocking(b, lines)) - Number(isBlocking(a, lines)) || b.confidence - a.confidence,
  );
  for (const f of ordered) {
    if (openKeys.has(findingKey(f))) continue;
    const line = anchor(f, lines);
    if (line !== null && f.confidence >= INLINE_CONFIDENCE && inline.length < MAX_INLINE) {
      inline.push(f);
      comments.push({ path: f.path.replace(/^\/+/, ''), line, side: 'RIGHT', body: inlineBody(f) });
    } else {
      outside.push(f);
    }
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

  const blocking = answer.findings.some((f) => isBlocking(f, lines));
  const review = {
    commit_id: args.head,
    body: summaryBody(answer, inline, outside, openKeys, resolved, skipped, usage, lines),
    event: blocking ? 'REQUEST_CHANGES' : 'COMMENT',
    comments,
  };
  const path = `/repos/${owner}/${name}/pulls/${args.pr}/reviews`;
  let posted;
  try {
    posted = await github('POST', path, review);
  } catch (error) {
    if (!String(error).includes('422') || !comments.length) throw error;
    // A line that the API refuses drops the inline comments, never the review.
    posted = await github('POST', path, {
      ...review,
      comments: [],
      body: summaryBody(answer, [], [...inline, ...outside], openKeys, resolved, skipped, usage, lines),
    });
  }

  // A COMMENT does not lift an earlier REQUEST_CHANGES, so the review of the previous head would keep
  // the pull request blocked after its findings are fixed.
  for (const previous of (await github('GET', `${path}?per_page=100`)) ?? []) {
    if (previous.user.login === BOT_LOGIN && previous.state === 'CHANGES_REQUESTED' && previous.id !== posted.id) {
      await github('PUT', `${path}/${previous.id}/dismissals`, {
        message: 'Remplacée par la revue du dernier commit.',
        event: 'DISMISS',
      });
    }
  }
  return { posted, inlineCount: comments.length, resolved };
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
      `cost=${usage.cost} verdict=${answer.verdict} confidence=${answer.pr_confidence} findings=${answer.findings.length}`,
  );

  if (values['dry-run']) {
    const findings = answer.findings.map((f) => ({ ...f, anchor: anchor(f, lines), blocking: isBlocking(f, lines) }));
    console.log(JSON.stringify({ answer: { ...answer, findings }, usage, skipped, pack_bytes: pack.length }, null, 2));
    return;
  }
  if (!values.repository || !values.pr) throw new Error('--repository and --pr are required to post');
  const { posted, inlineCount, resolved } = await post(
    { repoDir, repository: values.repository, pr: Number(values.pr), head: values.head },
    answer,
    usage,
    skipped,
    lines,
  );
  log(`posted review ${posted.id} (${posted.state}) with ${inlineCount} inline comments, ${resolved} threads resolved`);
}

main().catch((error) => {
  log(String(error?.stack ?? error));
  process.exit(1);
});
