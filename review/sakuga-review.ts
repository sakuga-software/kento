/**
 * Sakuga Review: one model call reviews a pull request, then the script posts the review. A comment
 * command asks for a review at another level, or for an answer to the open threads.
 *
 *     node review/sakuga-review.ts --repo-dir <checkout> --base <sha> --head <sha> [--level heavy] --dry-run
 *     node review/sakuga-review.ts --repo-dir <checkout> --repository <owner/name> --pr <n> --base <sha> --head <sha>
 *
 * Environment: OPENROUTER_API_KEY, and GITHUB_TOKEN to post. See README.md.
 * Node 26 or later runs this file as is: no package, no build. Keep to erasable TypeScript syntax.
 *
 * The engine (packages/engine) builds the pack, calls the model and renders the review. This script
 * reads the threads of GitHub and posts the review: the engine never calls GitHub. It imports the
 * engine by its relative path, so the checkout of review.yml runs it with no install.
 */
import { parseArgs } from 'node:util';
import {
  anchor,
  askJson,
  buildPack,
  costLine,
  descriptionBlock,
  fileChangedSince,
  FINDING_KEY,
  findingKey,
  git,
  inlineBody,
  isBlocking,
  isLevel,
  levelConfig,
  MARKER_GONE,
  markerResolve,
  mergeBase,
  MAX_RESOLVE_PACK_BYTES,
  MAX_THREADS,
  RESOLVE_SCHEMA,
  resolvePack,
  REVIEW_COUNT,
  reviewBody,
  reviewPullRequest,
  score,
  SEVERITY_ORDER,
  suggestionRange,
  verdict,
  withBlock,
  type Answer,
  type ChangedLines,
  type Finding,
  type Level,
  type Link,
  type OpenThread,
  type ThreadVerdict,
  type Usage,
} from '../packages/engine/src/index.ts';

const GITHUB_API = 'https://api.github.com';

const BOT_LOGIN = process.env.REVIEW_BOT_LOGIN ?? 'kento-review[bot]';

// Each inline comment is a thread that a person must resolve, so only the sure findings get one.
const INLINE_CONFIDENCE = 70;
const MAX_INLINE = 5;

const SCORE_COLOUR = ['', 'b60205', 'd93f0b', 'fbca04', 'a2d9a5', '0e8a16'];
const LABEL_PREFIX = 'review: ';

type Thread = {
  id: string;
  resolved: boolean;
  path: string;
  /** The line of the thread at the head, or null when its line is gone. */
  line: number | null;
  key: string;
  commit?: string;
  commentId: number;
  answered: boolean;
};

const log = (message: string) => process.stderr.write(`${message}\n`);

// GitHub

async function github(method: string, path: string, payload?: unknown, token = process.env.GITHUB_TOKEN): Promise<any> {
  const response = await fetch(path.startsWith('http') ? path : GITHUB_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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

async function graphql(query: string, variables: Record<string, unknown>, token = process.env.GITHUB_TOKEN): Promise<any> {
  const out = await github('POST', '/graphql', { query, variables }, token);
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
              id isResolved path line
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
          line: node.line ?? null,
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

type Args = { repoDir: string; repository: string; pr: number; head: string; level: Level };

/**
 * The note of a review when a force-push removed the commit of open threads: their diff starts at the
 * merge base, and they stay open.
 */
function goneNote(gone: number, base: string): string {
  if (!gone) return '';
  const threads = gone > 1 ? `${gone} fils ouverts` : 'un fil ouvert';
  return (
    `\n\n> [!NOTE]\n> Un force-push a retiré de l'historique le commit relu par ${threads}. ` +
    `Le diff depuis ce commit est impossible : cette revue relit toute la PR depuis la base \`${base.slice(0, 9)}\`, ` +
    `et ${gone > 1 ? 'ces fils restent ouverts' : 'ce fil reste ouvert'}.`
  );
}

async function post(args: Args & { base: string }, answer: Answer, usage: Usage, skipped: string[], lines: ChangedLines) {
  const [owner, name] = args.repository.split('/');
  const threads = await botThreads(owner, name, args.pr);
  const openThreads = new Map(threads.filter((t) => !t.resolved).map((t) => [t.key, t]));
  const threadUrl = (commentId: number) => `https://github.com/${owner}/${name}/pull/${args.pr}#discussion_r${commentId}`;

  // Two models word one defect differently, so the key of the title differs. An open thread of this
  // bot a few lines away on the same file already carries the finding.
  const NEAR_THREAD_LINES = 3;
  const nearThread = (f: Finding) => {
    const line = anchor(f, lines);
    const path = f.path.replace(/^\/+/, '');
    return threads.find((t) => !t.resolved && !t.answered && t.path === path && t.line !== null && line !== null && Math.abs(t.line - line) <= NEAR_THREAD_LINES);
  };
  // The threads that a finding of this review still carries: by its key, or by its position. A thread
  // outside this set can be declared gone.
  const keysNow = new Set(answer.findings.flatMap((f) => [findingKey(f), nearThread(f)?.key ?? '']).filter(Boolean));

  const ordered = [...answer.findings].sort(
    (a, b) =>
      Number(isBlocking(b, lines)) - Number(isBlocking(a, lines)) ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      b.confidence - a.confidence,
  );
  const inline: Finding[] = [];
  const comments: { path: string; line: number; start_line?: number; side: 'RIGHT'; start_side?: 'RIGHT'; body: string }[] = [];
  for (const f of ordered) {
    if (openThreads.has(findingKey(f)) || nearThread(f)) continue;
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
  // A thread whose commit a force-push removed stays open: nothing tells what changed since.
  let resolved = 0;
  let gone = 0;
  for (const t of threads) {
    if (t.resolved || t.answered || keysNow.has(t.key)) continue;
    const changed = fileChangedSince(args.repoDir, t.commit, args.head, t.path);
    if (changed === null) gone++;
    if (!changed) continue;
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

  const review = { commit_id: args.head, body: reviewBody(answer, lines, args.level, usage) + goneNote(gone, args.base), event: verdict(answer, lines, args.level), comments };
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
    const id = newThreads.get(key) ?? openThreads.get(key)?.commentId ?? nearThread(f)?.commentId;
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
    level: args.level,
  });
  await github('PATCH', prPath, { body: withBlock(current, block) });
  await setScoreLabel(owner, name, args.pr, score(answer, lines));
  return { posted, inlineCount: comments.length, resolved, score: score(answer, lines) };
}

// Commands

type Command = { kind: 'review' | 'resolve'; level: Level } | { kind: 'unknown'; text: string } | { kind: 'other-mention' };

const COMMAND = /^\s*@sakuga-review\b[ \t]*([\w-]*)[ \t]*([\w-]*)/i;

const USAGE = [
  'Commandes de Sakuga Review, dans un commentaire de la PR :',
  '',
  '- `@sakuga-review review [lite|balanced|heavy]` : une revue de la PR au niveau donné (`lite` par défaut).',
  '- `@sakuga-review resolve [lite|balanced|heavy]` : répondre aux fils ouverts, et résoudre ceux que le code règle.',
  '',
  '`lite` : Claude Haiku 5.5, environ 1 centime. `balanced` : Claude Sonnet 5.5 avec le code autour de la diff, environ 5 centimes. ' +
    '`heavy` : Claude Opus 5.5 avec le même contexte et plus de réflexion, de 10 centimes à 1 dollar.',
].join('\n');

/**
 * The command at the start of a comment. `@sakuga-review` alone asks for a lite review. A comment
 * that starts with another name (`@sakuga-reviewer`) is not for this bot.
 */
function parseCommand(text: string): Command {
  const match = COMMAND.exec(text);
  if (!match) return { kind: 'other-mention' };
  const verb = match[1].toLowerCase();
  const level = match[2].toLowerCase();
  if (verb !== '' && verb !== 'review' && verb !== 'resolve') return { kind: 'unknown', text };
  if (level && !isLevel(level)) return { kind: 'unknown', text };
  return { kind: verb === 'resolve' ? 'resolve' : 'review', level: isLevel(level) ? level : 'lite' };
}

async function react(repository: string, commentId: number, content: 'eyes' | 'rocket' | 'confused') {
  try {
    await github('POST', `/repos/${repository}/issues/comments/${commentId}/reactions`, { content });
  } catch (error) {
    log(`cannot react to comment ${commentId}: ${error}`);
  }
}

/**
 * A command costs money: only a person who can write to the repository, or a bot of TRUSTED_BOTS,
 * can give one. The API of collaborators does not know the bots of an App, and GitHub keeps the
 * `[bot]` suffix to Apps, so a person cannot take the login of one.
 */
async function canCommand(repository: string, login: string): Promise<boolean> {
  const trustedBots = (process.env.TRUSTED_BOTS ?? '').split(',').map((bot) => bot.trim()).filter(Boolean);
  if (login.endsWith('[bot]')) return trustedBots.includes(login);
  try {
    const out = await github('GET', `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`);
    return ['admin', 'maintain', 'write'].includes(out.permission);
  } catch (error) {
    log(`cannot read the permission of ${login}: ${error}`);
    return false;
  }
}

async function comment(repository: string, pr: number, body: string) {
  await github('POST', `/repos/${repository}/issues/${pr}/comments`, { body });
}
// Resolve

/** The unresolved review threads of the pull request, of every author. */
async function openThreads(owner: string, name: string, number: number): Promise<OpenThread[]> {
  // A long thread keeps its first comment and its newest ones: the reply of a resolve, with its
  // marker, is among the newest.
  const query = `
    fragment threadComment on PullRequestReviewComment { databaseId body author { login __typename } originalCommit { oid } }
    query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id isResolved path line originalLine
              opener: comments(first: 1) { nodes { ...threadComment } }
              recent: comments(last: 29) { nodes { ...threadComment } }
            }
          }
        }
      }
    }`;
  const threads: OpenThread[] = [];
  let after: string | null = null;
  for (;;) {
    const data = await graphql(query, { owner, name, number, after });
    const page = data.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      const nodes = [...node.opener.nodes, ...node.recent.nodes.filter((c: any) => c.databaseId !== node.opener.nodes[0]?.databaseId)];
      if (node.isResolved || !nodes.length) continue;
      threads.push({
        id: node.id,
        path: node.path,
        line: node.line ?? node.originalLine ?? null,
        comments: nodes.map((c: any) => ({
          id: c.databaseId,
          author: c.author?.login ?? 'ghost',
          isBot: c.author?.__typename === 'Bot' || /\[bot\]$/.test(c.author?.login ?? ''),
          body: c.body,
          commit: c.originalCommit?.oid,
        })),
      });
    }
    if (!page.pageInfo.hasNextPage) return threads;
    after = page.pageInfo.endCursor;
  }
}

async function resolve(args: Args & { base: string }) {
  const [owner, name] = args.repository.split('/');
  const marker = markerResolve(args.head);
  const all = await openThreads(owner, name, args.pr);
  // A thread that this command already answered at this head waits for a new push.
  const waiting = all.filter((t) => !t.comments.some((c) => c.body.includes(marker)));
  const { pack, held: threads } = resolvePack(args.repoDir, args.base, args.head, waiting.slice(0, MAX_THREADS));
  if (!threads.length) {
    const at = `au commit \`${args.head.slice(0, 9)}\``;
    const text = waiting.length
      ? `Le premier fil à traiter dépasse à lui seul la taille d'une commande (${MAX_RESOLVE_PACK_BYTES / 1000} ko) : aucun fil n'a été relu ${at}.`
      : all.length
        ? `Les ${all.length} fils ouverts ont déjà reçu une réponse ${at}. Poussez un commit pour qu'ils soient relus.`
        : `Aucun fil ouvert ${at}.`;
    await comment(args.repository, args.pr, `${text}\n\n${marker}`);
    return { resolved: 0, open: 0 };
  }
  const config = levelConfig(args.level, process.env);
  const { answer, usage } = await askJson<{ threads: ThreadVerdict[] }>(model, config, 'resolve.md', pack, {
    name: 'resolve',
    schema: RESOLVE_SCHEMA,
  });
  log(`model=${usage.model} provider=${usage.provider} tokens=${usage.prompt_tokens}+${usage.completion_tokens} cost=${usage.cost} threads=${threads.length}`);

  const byId = new Map(answer.threads.map((v) => [v.id, v]));
  const writeToken = process.env.GITHUB_TOKEN_RESOLVE || process.env.GITHUB_TOKEN;
  const lines: string[] = [];
  let resolved = 0;
  for (const t of threads) {
    const v = byId.get(t.id);
    if (!v) continue;
    const opener = t.comments[0];
    // A thread of a person closes only on a change of its file: an answer of the bot is not enough.
    // A finding of a bot that the file did not change since is not fixed.
    // A force-push that removed the commit of the thread gives null: the thread stays open.
    const changed = fileChangedSince(args.repoDir, opener.commit, args.head, t.path);
    const close = v.verdict === 'fixed' ? changed === true : v.verdict === 'answered' && opener.isBot;
    let status =
      v.verdict === 'fixed' && changed === null
        ? `Un force-push a retiré de l'historique le commit de ce fil : le changement depuis ce commit est inconnu, et le fil reste ouvert.`
        : '';
    if (close) {
      try {
        await graphql('mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }', { id: t.id }, writeToken);
        status = 'Fil résolu.';
        resolved++;
      } catch (error) {
        log(`cannot resolve thread ${t.id}: ${error}`);
        status = "Le fil peut être résolu : l'App n'a pas encore le droit de le faire.";
      }
    }
    await github('POST', `/repos/${owner}/${name}/pulls/${args.pr}/comments/${opener.id}/replies`, {
      body: [v.reply.trim(), status, marker].filter(Boolean).join('\n\n'),
    });
    const url = `https://github.com/${owner}/${name}/pull/${args.pr}#discussion_r${opener.id}`;
    const label = close ? (status === 'Fil résolu.' ? '✅ résolu' : '☑️ à résoudre') : '💬 reste ouvert';
    lines.push(`- ${label} · [\`${t.path}:${t.line ?? '?'}\`](${url}) · ${opener.author}`);
  }
  const skipped = waiting.length - threads.length;
  await comment(
    args.repository,
    args.pr,
    [
      `**Sakuga Review · résolution des fils** au commit \`${args.head.slice(0, 9)}\``,
      '',
      ...lines,
      '',
      ...(skipped
        ? [`${skipped} autre${skipped > 1 ? 's' : ''} fil${skipped > 1 ? 's' : ''} ouvert${skipped > 1 ? 's' : ''} attend${skipped > 1 ? 'ent' : ''} : une commande traite au plus ${MAX_THREADS} fils et ${MAX_RESOLVE_PACK_BYTES / 1000} ko. Relancez \`@sakuga-review resolve\`.`, '']
        : []),
      `<sub>${costLine(args.level, usage)}</sub>`,
      '',
      marker,
    ].join('\n'),
  );
  return { resolved, open: threads.length - resolved };
}

// Entry

/** The model client of the engine: the key of the environment, and the failed attempts on stderr. */
const model = { apiKey: process.env.OPENROUTER_API_KEY, log };

async function review(args: Args & { base: string }, dryRun: boolean, packOnly: boolean) {
  const config = levelConfig(args.level, process.env);
  if (packOnly) {
    console.log(buildPack(args.repoDir, args.base, args.head, config.context).pack);
    return;
  }
  const result = await reviewPullRequest({ ...model, repoDir: args.repoDir, base: args.base, head: args.head, level: args.level, config });
  const { answer, usage, skipped, lines, pack } = result;
  log(
    `level=${args.level} model=${usage.model} provider=${usage.provider} tokens=${usage.prompt_tokens}+${usage.completion_tokens} ` +
      `cost=${usage.cost} score=${result.score}/5 verdict=${result.verdict} findings=${answer.findings.length} ` +
      `diagram=${result.diagram ? 'yes' : 'no'} deeper=${result.deeperReview ? 'yes' : 'no'}`,
  );

  if (dryRun) {
    const block = descriptionBlock(
      answer,
      answer.findings.map((finding) => ({ finding, url: null })),
      skipped,
      0,
      usage,
      lines,
      { count: 1, head: args.head, subject: git(args.repoDir, 'log', '-1', '--format=%s', args.head).trim(), commitUrl: '#', level: args.level },
    );
    const body = reviewBody(answer, lines, args.level, usage);
    console.log(JSON.stringify({ answer: { ...answer, findings: result.findings }, usage, skipped, pack_bytes: pack.length, body, block }, null, 2));
    return;
  }
  const { posted, inlineCount, resolved, score: value } = await post(args, answer, usage, skipped, lines);
  log(`posted review ${posted.id} (${posted.state}) with ${inlineCount} inline comments, ${resolved} threads resolved, score ${value}/5`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      'repo-dir': { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      repository: { type: 'string' },
      pr: { type: 'string' },
      level: { type: 'string', default: 'lite' },
      // A command from a comment: its text, its id and its author.
      command: { type: 'string' },
      'comment-id': { type: 'string' },
      commenter: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'pack-only': { type: 'boolean', default: false },
    },
  });
  const repoDir = values['repo-dir'];
  if (!repoDir || !values.base || !values.head) throw new Error('--repo-dir, --base and --head are required');
  if (!isLevel(values.level)) throw new Error(`--level must be lite, balanced or heavy, not ${values.level}`);
  // --base is the tip of the base branch: the diff starts at the merge base.
  const base = mergeBase(repoDir, values.base, values.head);
  const args = { repoDir, repository: values.repository ?? '', pr: Number(values.pr), head: values.head, base, level: values.level };

  if (values.command === undefined) {
    if (!values['dry-run'] && !values['pack-only'] && (!values.repository || !values.pr)) {
      throw new Error('--repository and --pr are required to post');
    }
    await review(args, values['dry-run'], values['pack-only']);
    return;
  }

  if (!values.repository || !values.pr || !values['comment-id'] || !values.commenter) {
    throw new Error('--repository, --pr, --comment-id and --commenter are required with --command');
  }
  const commentId = Number(values['comment-id']);
  const command = parseCommand(values.command);
  if (command.kind === 'other-mention') return;
  if (!(await canCommand(values.repository, values.commenter))) {
    await comment(values.repository, args.pr, `@${values.commenter} Seule une personne qui peut écrire dans le dépôt peut lancer Sakuga Review.`);
    return;
  }
  if (command.kind === 'unknown') {
    await react(values.repository, commentId, 'confused');
    await comment(values.repository, args.pr, USAGE);
    return;
  }
  await react(values.repository, commentId, 'eyes');
  try {
    if (command.kind === 'review') await review({ ...args, level: command.level }, false, false);
    else {
      const { resolved, open } = await resolve({ ...args, level: command.level });
      log(`resolve: ${resolved} threads resolved, ${open} left open`);
    }
    await react(values.repository, commentId, 'rocket');
  } catch (error) {
    await react(values.repository, commentId, 'confused');
    throw error;
  }
}

main().catch((error) => {
  log(String(error?.stack ?? error));
  process.exit(1);
});
