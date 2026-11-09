// REV-87. A push must not cancel a command of review.yml, and a newer push must still cancel the
// review of the previous push. The two jobs now have their own concurrency groups, so a command and
// the review of a push can run at once on one pull request: the command whose head a push replaced
// posts its review alone, and leaves the shared state of the pull request to the review of the push.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'review.yml'), 'utf8');

/** The `concurrency` block of a job of review.yml. */
function concurrencyOf(job: string): { group: string; cancel: string } {
  const start = WORKFLOW.indexOf(`\n  ${job}:\n`);
  assert.ok(start >= 0, `job ${job}`);
  const next = WORKFLOW.slice(start + 1).search(/\n  [a-z_]+:\n/);
  const body = next < 0 ? WORKFLOW.slice(start) : WORKFLOW.slice(start, start + 1 + next);
  const block = /\n    concurrency:\n      group: (.+)\n      cancel-in-progress: (true|false)\n/.exec(body);
  assert.ok(block, `concurrency of ${job}`);
  return { group: block[1]!, cancel: block[2]! };
}

test('review.yml: a push cancels the review of the previous push, never a command (REV-87)', () => {
  const push = concurrencyOf('sakuga_review');
  const command = concurrencyOf('sakuga_command');
  // The number of the pull request is `pull_request.number` in one event and `issue.number` in the
  // other: the two groups are the same group when they differ only there.
  const pr = (group: string) => group.replace(/github\.event\.(?:pull_request|issue)\.number/, '<pr>');
  assert.notEqual(pr(push.group), pr(command.group), 'a push and a command share no group: the push would cancel the command');
  assert.equal(push.cancel, 'true', 'a newer push still cancels the review of the previous one');
  assert.equal(command.cancel, 'false', 'a command never cancels another command');
  // Each group is one pull request of one repository.
  assert.match(push.group, /\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.pull_request\.number \}\}$/);
  assert.match(command.group, /\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.issue\.number \}\}$/);
});

// --- the command whose head a push replaced --------------------------------------------------------

let repo = '';
let base = '';
let head = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

/** A blocking P1 on the changed line: the verdict of the review is REQUEST_CHANGES. */
const BLOCKING = {
  confidence_score: 2,
  risk: 'Moyen',
  summary: 'Résumé',
  diagram: '',
  findings: [{ path: 'sum.ts', start_line: 2, line: 2, severity: 'major', category: 'bug', confidence: 90, title: 'Soustraction', scenario: 'sum(1, 2) donne -1.', fix: 'a + b', suggestion: '' }],
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
};
/** No finding and a score of 5: the verdict of the review is APPROVE. */
const CLEAN = { ...BLOCKING, confidence_score: 5, risk: 'Faible', findings: [] };

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'action-concurrency-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'sum.ts'), 'export function sum(a: number, b: number) {\n  return a + b;\n}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'sum.ts'), 'export function sum(a: number, b: number) {\n  return a - b;\n}\n');
  git('commit', '-q', '-am', 'fix: sum');
  head = git('rev-parse', 'HEAD');
  // The model answers MODEL_ANSWER. Every other URL goes to the fake GitHub.
  writeFileSync(
    join(repo, 'model.mjs'),
    `const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://openrouter.ai/')) return real(url, init);
  const body = JSON.parse(String(init.body));
  return new Response(JSON.stringify({ model: body.model, provider: 'Stub', choices: [{ message: { content: process.env.MODEL_ANSWER } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }));
};
`,
  );
});

after(() => rmSync(repo, { recursive: true, force: true }));

/**
 * A fake GitHub that records every call. `heads`: the head of the pull request at each read, the
 * last one repeated. `thread`: one open thread of the bot on `sum.ts`, opened at the base.
 */
async function fakeGitHub(heads: string[], options: { thread?: boolean; reviews?: { id: number; state: string }[] } = {}) {
  const calls: { method: string; path: string; body: any }[] = [];
  let reads = 0;
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: request.method ?? '', path, body });
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (path.endsWith('/permission')) return send(200, { permission: 'write' });
      if (path.endsWith('/reactions')) return send(201, { id: 1 });
      if (path === '/graphql') {
        if (body.query.includes('resolveReviewThread')) return send(200, { data: { resolveReviewThread: { thread: { id: body.variables.id } } } });
        const opener = { databaseId: 11, body: '**Soustraction** `#abcdef`', author: { login: 'kento-review', __typename: 'Bot' }, originalCommit: { oid: base } };
        const nodes = options.thread ? [{ id: 'PRRT_1', isResolved: false, path: 'sum.ts', line: 2, originalLine: 2, opener: { nodes: [opener] }, recent: { nodes: [opener] }, comments: { nodes: [{ ...opener, commit: { oid: base } }] } }] : [];
        return send(200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } });
      }
      if (path === '/repos/o/n/pulls/7' && request.method === 'GET') return send(200, { head: { sha: heads[Math.min(reads++, heads.length - 1)] }, body: 'Description.' });
      if (path === '/repos/o/n/pulls/7/reviews' && request.method === 'POST') return send(200, { id: 501, state: body.event });
      if (path.startsWith('/repos/o/n/pulls/7/reviews?')) {
        return send(200, (options.reviews ?? [{ id: 400, state: 'CHANGES_REQUESTED' }]).map((r) => ({ ...r, user: { login: 'kento-review[bot]' } })));
      }
      if (path.startsWith('/repos/o/n/pulls/7/reviews/501/comments')) return send(200, []);
      if (path.startsWith('/repos/o/n/issues/7/labels') && request.method === 'GET') return send(200, []);
      return send(200, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { calls, url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The command of the comment 99, as the job of review.yml runs it. */
function runCommand(apiUrl: string, answer: unknown, command = '@sakuga-review review lite'): Promise<{ code: number | null; stderr: string }> {
  const args = ['--import', join(repo, 'model.mjs'), join(ROOT, 'review', 'sakuga-review.ts'), '--repo-dir', repo, '--repository', 'o/n', '--pr', '7'];
  args.push('--base', base, '--head', head, '--command', command, '--comment-id', '99', '--commenter', 'alex');
  const child = spawn('node', args, {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_API_URL: apiUrl, GITHUB_TOKEN: 'ghs_test', OPENROUTER_API_KEY: 'sk-test', MODEL_ANSWER: JSON.stringify(answer) },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

const NEWER = 'f'.repeat(40);
const posted = (calls: { method: string; path: string; body: any }[]) => calls.filter((c) => c.method === 'POST' && c.path === '/repos/o/n/pulls/7/reviews');
const shared = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === 'PATCH' || c.path.includes('/labels') || c.path.includes('/dismissals'));

test('a command whose head a push replaced posts its review alone, with its findings: no block, no label, no dismissal, no change asked (REV-87)', async () => {
  const fake = await fakeGitHub([NEWER]);
  try {
    const { code, stderr } = await runCommand(fake.url, BLOCKING);
    assert.equal(code, 0, stderr);
    const reviews = posted(fake.calls);
    assert.equal(reviews.length, 1, 'the review of the command is posted');
    assert.equal(reviews[0]!.body.commit_id, head, 'on the head that it read');
    assert.equal(reviews[0]!.body.event, 'COMMENT', 'a review of an earlier head asks for no change');
    assert.match(reviews[0]!.body.body, /Un push est arrivé pendant cette revue : elle porte sur le commit `[0-9a-f]{9}`, et le dernier commit est `fffffffff`/);
    // The findings are in the body, with their scenario, since the description keeps the newer block.
    assert.match(reviews[0]!.body.body, /\*\*Soustraction\*\*[^\n]*\n   sum\(1, 2\) donne -1\. \*\*Correction :\*\* a \+ b/);
    assert.doesNotMatch(reviews[0]!.body.body, /sakuga-review:(start|end|count)/, 'nothing reads it as the block of the pull request');
    assert.deepEqual(shared(fake.calls), [], 'the block, the label and the reviews of the newer head stay');
    assert.ok(fake.calls.some((c) => c.path === '/repos/o/n/issues/comments/99/reactions' && c.body.content === 'rocket'), 'the command still ends with 🚀');
    assert.match(stderr, /the head moved to f{40} during this review/);
  } finally {
    await fake.close();
  }
});

test('a command whose head a push replaced never approves either (REV-87)', async () => {
  const fake = await fakeGitHub([NEWER]);
  try {
    const { code, stderr } = await runCommand(fake.url, CLEAN);
    assert.equal(code, 0, stderr);
    assert.equal(posted(fake.calls)[0]!.body.event, 'COMMENT');
  } finally {
    await fake.close();
  }
});

test('a push that lands while the review posts: the block and the label stay those of the newer head (REV-87)', async () => {
  // The first read sees the head of the command, the second one the push.
  const fake = await fakeGitHub([head, NEWER]);
  try {
    const { code, stderr } = await runCommand(fake.url, BLOCKING);
    assert.equal(code, 0, stderr);
    assert.equal(posted(fake.calls).length, 1);
    assert.deepEqual(shared(fake.calls), []);
    assert.match(stderr, /while this review of [0-9a-f]{40} posted/);
  } finally {
    await fake.close();
  }
});

test('guard: a command on the current head writes the block and the label, and dismisses only the reviews posted before it (REV-87)', async () => {
  // 400: an earlier review of the bot. 600: the review of a push on the same head, posted after this one.
  const fake = await fakeGitHub([head], { reviews: [{ id: 400, state: 'CHANGES_REQUESTED' }, { id: 600, state: 'CHANGES_REQUESTED' }] });
  try {
    const { code, stderr } = await runCommand(fake.url, BLOCKING);
    assert.equal(code, 0, stderr);
    const [review] = posted(fake.calls);
    assert.equal(review!.body.event, 'REQUEST_CHANGES');
    assert.doesNotMatch(review!.body.body, /Un push est arrivé/);
    assert.equal(fake.calls.filter((c) => c.method === 'PATCH' && c.path === '/repos/o/n/pulls/7').length, 1);
    assert.ok(fake.calls.some((c) => c.method === 'POST' && c.path === '/repos/o/n/issues/7/labels'));
    assert.deepEqual(
      fake.calls.filter((c) => c.path.includes('/dismissals')).map((c) => c.path),
      ['/repos/o/n/pulls/7/reviews/400/dismissals'],
      'the later review of the same head keeps its verdict',
    );
  } finally {
    await fake.close();
  }
});

test('a resolve whose head a push replaced answers the threads and resolves none (REV-87)', async () => {
  const answer = { threads: [{ id: 'PRRT_1', verdict: 'fixed', reply: 'Corrigé : sum additionne.' }] };
  for (const [heads, resolves] of [[[NEWER], false], [[head], true]] as const) {
    const fake = await fakeGitHub([...heads], { thread: true });
    try {
      const { code, stderr } = await runCommand(fake.url, answer, '@sakuga-review resolve');
      assert.equal(code, 0, stderr);
      const mutations = fake.calls.filter((c) => c.path === '/graphql' && c.body.query.includes('resolveReviewThread'));
      assert.equal(mutations.length, resolves ? 1 : 0);
      const [reply] = fake.calls.filter((c) => c.path === '/repos/o/n/pulls/7/comments/11/replies');
      assert.match(reply!.body.body, /^Corrigé : sum additionne\./);
      if (!resolves) assert.match(reply!.body.body, /Un push est arrivé pendant cette commande \(`fffffffff`\) : le fil reste ouvert/);
    } finally {
      await fake.close();
    }
  }
});
