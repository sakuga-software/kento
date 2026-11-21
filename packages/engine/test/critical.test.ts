import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { criticality, criticalSection, diffCriticality, namesChecks, type ChangedFile } from '../src/critical.ts';
import { deeperReview, score, verdict, type Answer } from '../src/findings.ts';
import { levelConfig, reviewInPasses, reviewPullRequest } from '../src/index.ts';
import { BASE_PASSES } from '../src/passes.ts';

// KNT-154. A change of authentication, access control, CI, secrets, webhooks, payments or a
// migration of data is critical.

const file = (path: string, added: string[] = ['export const x = 1;'], removed: string[] = []): ChangedFile => ({ path, added, removed });

test('a workflow of CI is critical', () => {
  const found = criticality([file('.github/workflows/release.yml', ['    permissions:', '      packages: write'])]);
  assert.deepEqual(found?.areas, ['ci']);
  assert.deepEqual(found?.files, [{ path: '.github/workflows/release.yml', area: 'ci' }]);
  assert.deepEqual(criticality([file('.github/actions/setup/action.yml')])?.areas, ['ci']);
});

test('a changed role check is critical, in a file whose path names nothing of it', () => {
  const found = criticality([file('app/routes/projects/$id/edit.tsx', ["  if (member.role !== 'admin') throw forbidden();"], ["  if (member.role === 'viewer') throw forbidden();"])]);
  assert.deepEqual(found?.areas, ['access']);
  assert.ok(criticality([file('src/lib/tools.ts', ['  if (!hasPermission(user, "search")) return null;'])]));
  assert.ok(criticality([file('src/lib/tools.ts', [], ['  if (!roles.includes("owner")) return deny();'])]), 'a removed check counts');
});

test('the paths of authentication, access, secrets, webhooks, payments and migrations are critical', () => {
  const cases: [string, string][] = [
    ['app/lib/auth.server.ts', 'auth'],
    ['src/session/cookies.ts', 'auth'],
    ['app/routes/api/orgMembers/$id.ts', 'access'],
    ['src/permissions/map.ts', 'access'],
    ['app/routes/webhooks/github.ts', 'webhooks'],
    ['src/billing/plan.ts', 'payments'],
    ['db/migrations/0042_roles.sql', 'migrations'],
    ['drizzle/0007_backfill.ts', 'migrations'],
    ['.env.production', 'secrets'],
  ];
  for (const [path, area] of cases) assert.deepEqual(criticality([file(path)])?.areas, [area], path);
});

test('a copy change, a document, a test or a style is not critical', () => {
  assert.equal(criticality([file('app/components/Header.tsx', ['      <Button>Sign in to your session</Button>'], ['      <Button>Log in</Button>'])]), null);
  assert.equal(criticality([file('README.md', ['Admins can sign in with SSO.'])]), null);
  assert.equal(criticality([file('docs/auth.md')]), null);
  assert.equal(criticality([file('app/locales/en/auth.json', ['"signIn": "Sign in"'])]), null);
  assert.equal(criticality([file('test/auth.test.ts', ["  assert.equal(member.role === 'admin', true);"])]), null);
  assert.equal(criticality([file('app/routes/admin/styles.css')]), null);
  // An attribute of the markup is no check of a role.
  assert.equal(criticality([file('app/components/Menu.tsx', ['  <ul role="menu">'])]), null);
});

test('the reasons list each area once, with at most five files each', () => {
  const found = criticality([...Array.from({ length: 8 }, (_, i) => file(`.github/workflows/w${i}.yml`)), file('src/auth/login.ts')]);
  assert.deepEqual(found?.areas, ['auth', 'ci']);
  assert.equal(found?.files.filter((f) => f.area === 'ci').length, 5);
});

test('the review names what it checked: one file of the head and one role', () => {
  const exists = (path: string) => path === 'app/routes/members.ts' || path === 'node_modules/auth-lib/endpoints.ts';
  assert.equal(namesChecks({ paths: ['app/routes/members.ts:42'], roles: ['member', 'admin of another org'] }, exists), true);
  assert.equal(namesChecks({ paths: ['The "remove member" endpoint of `node_modules/auth-lib/endpoints.ts`.'], roles: ['owner'] }, exists), true);
  assert.equal(namesChecks({ paths: ['app/routes/members.ts'], roles: [] }, exists), false, 'no role');
  assert.equal(namesChecks({ paths: ['every route'], roles: ['member'] }, exists), false, 'no file');
  assert.equal(namesChecks({ paths: ['app/made/up.ts'], roles: ['member'] }, exists), false, 'a file that is not at the head');
  assert.equal(namesChecks(undefined, exists), false);
});

const critical = { areas: ['access' as const], files: [{ path: 'app/routes/members.ts', area: 'access' as const }] };
const answer = (extra: Partial<Answer> = {}): Answer => ({
  confidence_score: 5,
  risk: 'Low risk.',
  summary: 'Summary.',
  diagram: '',
  findings: [],
  not_reviewed: [],
  deeper_review: { recommended: false, reason: '' },
  ...extra,
});
const lines = new Map<string, Set<number>>();

test('a critical answer at 5 that names no checked path scores 3, and does not approve', () => {
  const unchecked = answer({ critical: { ...critical, checked: false } });
  assert.equal(score(unchecked, lines), 3);
  assert.equal(verdict(unchecked, lines, 'balanced'), 'COMMENT');
  const checked = answer({ critical: { ...critical, checked: true } });
  assert.equal(score(checked, lines), 5);
  assert.equal(verdict(checked, lines, 'balanced'), 'APPROVE');
  // Not critical: the score of the model.
  assert.equal(score(answer(), lines), 5);
  assert.equal(score(answer({ critical: null }), lines), 5);
});

test('a lite review of a critical change recommends a deeper one', () => {
  const lite = answer({ critical: { ...critical, checked: true } });
  assert.match(deeperReview(lite, 'lite') ?? '', /changes access control, and a lite review does not check every route, role and permission/);
  assert.equal(verdict(lite, lines, 'lite'), 'COMMENT');
  assert.equal(deeperReview(lite, 'balanced'), null, 'only a lite review recommends one');
  assert.equal(deeperReview(answer(), 'lite'), null);
  // The reason of the model wins.
  assert.equal(deeperReview({ ...lite, deeper_review: { recommended: true, reason: 'Check the role route.' } }, 'lite'), 'Check the role route.');
});

test('the section of a critical change lists its files and gives the checklist', () => {
  const text = criticalSection(critical, { 'critical.md': 'CHECKLIST' });
  assert.match(text, /# Critical change/);
  assert.match(text, /- access: `app\/routes\/members\.ts`/);
  assert.match(text, /CHECKLIST/);
  const real = criticalSection(critical);
  for (const item of [/endpoints of a library or a\s+plugin/, /belongs to two\s+organizations/, /a digit for a\s+letter/, /the server must refuse it too/, /pinned by a tag and not by a commit SHA/, /`checked\.paths`/]) {
    assert.match(real, item);
  }
});

// The review of a pull request, with a model that answers as OpenRouter.
let repo = '';
let base = '';
let head = '';
let copyHead = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'engine-critical-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('app/routes/members.ts', "export function remove(member: { role: string }) {\n  if (member.role === 'owner') throw new Error('no');\n}\n");
  write('app/components/Header.tsx', 'export const Header = () => <h1>Hello</h1>;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  write('app/routes/members.ts', "export function remove(member: { role: string }) {\n  if (member.role === 'admin') throw new Error('no');\n}\n");
  git('commit', '-q', '-am', 'feat: admins cannot be removed');
  head = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'copy', base);
  write('app/components/Header.tsx', 'export const Header = () => <h1>Hello, sign in</h1>;\n');
  git('commit', '-q', '-am', 'copy: header');
  copyHead = git('rev-parse', 'HEAD');
});

after(() => rmSync(repo, { recursive: true, force: true }));

function fakeModel(reply: Answer) {
  const messages: string[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    messages.push(body.messages.map((m: { content: unknown }) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'));
    const content = JSON.stringify(body.response_format?.json_schema?.name === 'links' ? { links: [] } : reply);
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, messages };
}

const input = (fetch: typeof globalThis.fetch, at = head, level: 'lite' | 'balanced' = 'balanced') => ({ repoDir: repo, base, head: at, level, apiKey: 'k', fetch, log: () => {} });

test('the review of a critical change: the checklist in the pack, the cap, and the text of the risk and the summary', async () => {
  const model = fakeModel(answer({ checked: { paths: [], roles: [] } }));
  const result = await reviewPullRequest(input(model.fetch));
  assert.deepEqual(result.critical?.areas, ['access']);
  assert.equal(result.critical?.checked, false);
  assert.equal(result.score, 3);
  assert.equal(result.verdict, 'COMMENT');
  assert.match(model.messages[0]!, /# Critical change/);
  assert.match(model.messages[0]!, /access: `app\/routes\/members\.ts`/);
  assert.match(result.answer.risk, /^Critical change \(access control\)\. Low risk\./);
  assert.match(result.answer.summary, /named no file and no role that it checked, so the score of this critical change is 3 at most/);

  const named = fakeModel(answer({ checked: { paths: ['app/routes/members.ts'], roles: ['owner', 'admin'] } }));
  const checked = await reviewPullRequest(input(named.fetch));
  assert.equal(checked.critical?.checked, true);
  assert.equal(checked.score, 5);
  assert.equal(checked.verdict, 'APPROVE');
  assert.match(checked.answer.summary, /Paths checked: `app\/routes\/members\.ts`\. Roles checked: `owner`, `admin`\./);

  const lite = await reviewPullRequest(input(named.fetch, head, 'lite'));
  assert.match(lite.deeperReview ?? '', /changes access control/);
});

test('the review of a copy change: no checklist, no cap', async () => {
  const model = fakeModel(answer({ checked: { paths: [], roles: [] } }));
  assert.equal(diffCriticality(repo, base, copyHead), null);
  const result = await reviewPullRequest(input(model.fetch, copyHead));
  assert.equal(result.critical, null);
  assert.equal(result.score, 5);
  assert.doesNotMatch(model.messages[0]!, /# Critical change/);
  assert.equal(result.answer.risk, 'Low risk.');
  assert.equal(result.answer.summary, 'Summary.');
});

test('a review in passes names what any pass checked: the security pass can name the paths and roles', async () => {
  const byPass: Record<string, Answer> = {
    security: answer({ confidence_score: 5, checked: { paths: ['app/routes/members.ts'], roles: ['owner'] } }),
    data: answer({ confidence_score: 5, checked: { paths: [], roles: [] } }),
    contracts: answer({ confidence_score: 5, checked: { paths: [], roles: [] } }),
  };
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const user: string = body.messages[1].content;
    const pass = BASE_PASSES.find((p) => user.endsWith(`${p.focus}\n`));
    const content = JSON.stringify(pass ? byPass[pass.id] : { verdicts: [] });
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  }) as typeof globalThis.fetch;
  const config = (level: 'lite' | 'balanced') => ({ ...levelConfig(level), models: ['test/model'] });
  const result = await reviewInPasses(input(fetch), { passConfig: config('lite'), verifyConfig: config('balanced') });
  assert.equal(result.critical?.checked, true);
  assert.equal(result.score, 5);
});
