import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { changedFiles, criticality, criticalSection, diffCriticality, isRealRole, namesChecks, type ChangedFile, type CheckContext, type CheckResult } from '../src/critical.ts';
import { deeperReview, score, verdict, type Answer, type CriticalReview } from '../src/findings.ts';
import { levelConfig, reviewInPasses, reviewPullRequest } from '../src/index.ts';
import { BASE_PASSES } from '../src/passes.ts';
import { criticalReview, withCriticalText } from '../src/review.ts';
import { PROMPT_FILES } from '../src/reuse.ts';

// KNT-154. A change of authentication, access control, CI, the supply chain, secrets, webhooks,
// payments, a migration of data or the security of the web layer is critical.

const file = (path: string, added: string[] = ['export const x = 1;'], removed: string[] = []): ChangedFile => ({ path, added, removed });
const areaOf = (f: ChangedFile) => criticality([f])?.areas ?? [];

test('a workflow of CI is critical', () => {
  const found = criticality([file('.github/workflows/release.yml', ['    permissions:', '      packages: write'])]);
  assert.deepEqual(found?.areas, ['ci']);
  assert.deepEqual(found?.files, [{ path: '.github/workflows/release.yml', area: 'ci' }]);
  assert.deepEqual(areaOf(file('.github/actions/setup/action.yml')), ['ci']);
  assert.deepEqual(areaOf(file('.gitea/workflows/ci.yml')), ['ci']);
});

test('a changed role check is critical, in a file whose path names nothing of it', () => {
  assert.deepEqual(areaOf(file('app/routes/projects/$id/edit.tsx', ["  if (member.role !== 'admin') throw forbidden();"], ["  if (member.role === 'viewer') throw forbidden();"])), ['access']);
  assert.deepEqual(areaOf(file('src/lib/tools.ts', ['  if (!hasPermission(user, "search")) return null;'])), ['access']);
  assert.deepEqual(areaOf(file('src/lib/tools.ts', [], ['  if (!roles.includes("owner")) return deny();'])), ['access'], 'a removed check counts');
  assert.deepEqual(areaOf(file('src/x.ts', ['  if (!userIsStaff(u)) return deny();'])), ['access'], 'a renamed role helper');
});

// One case for each surface of the critique of #40.
const SURFACES: [string, ChangedFile, string][] = [
  ['a protected-names check', file('src/lib/reserved-names.ts', ['  if (PROTECTED.has(name.toLowerCase())) throw new Error("taken");']), 'access'],
  ['a hidden edit control', file('app/components/EditButton.tsx', ['  {canEdit && <Button>Edit</Button>}']), 'access'],
  ['the client follows the session', file('app/hooks/useCurrentUser.ts', ['  const { data: user } = useQuery(["me"])']), 'auth'],
  ['the cache of the client is cleared on a change of user', file('src/lib/query-client.ts', ['  queryClient.clear();']), 'auth'],
  ['a route-to-permission map', file('src/server/route-domains.ts', ["  '/api/search': { requiredPermission: 'documents' },"]), 'access'],
  ['a route-to-domain map', file('src/server/route-domains.ts', ["  '/api/search': 'documents',"]), 'access'],
  ['Next.js middleware', file('src/middleware.ts', ['  if (!req.cookies.get("sid")) return NextResponse.redirect(login);']), 'auth'],
  ['SvelteKit hooks', file('src/hooks.server.ts', ['  event.locals.user = await lucia.validateSession(id);']), 'auth'],
  ['a role check in Svelte', file('src/routes/+page.svelte', ["{#if user.role === 'admin'}"]), 'access'],
  ['a role check in Vue', file('src/views/Edit.vue', ["  <button v-if=\"user.role === 'admin'\">"]), 'access'],
  ['permissions.yml', file('config/permissions.yml', ['viewer: [read, write]']), 'access'],
  ['roles.json', file('src/config/roles.json', ['{}']), 'access'],
  ['firestore.rules', file('firestore.rules', ['allow write: if true;']), 'access'],
  ['a config file that grants rights', file('config/access.yml', ['  permissions:', '    - write']), 'access'],
  ['a Dockerfile', file('Dockerfile', ['FROM node:22', 'USER root']), 'supply'],
  ['a postinstall script', file('package.json', ['    "postinstall": "node setup.js",']), 'supply'],
  ['.npmrc', file('.npmrc', ['registry=https://registry.example.com/']), 'supply'],
  ['a lock file that takes a package from git', file('pnpm-lock.yaml', ['    resolution: {tarball: https://codeload.github.com/acme/lib/tar.gz/abc}']), 'supply'],
  ['the root action.yml', file('action.yml', ['runs:']), 'supply'],
  ['CODEOWNERS', file('.github/CODEOWNERS', ['* @acme/team']), 'supply'],
  ['dependabot', file('.github/dependabot.yml', ['version: 2']), 'supply'],
  ['a Rails migration', file('db/migrate/20240101_add_admin.rb', ['add_column :users, :admin, :boolean']), 'migrations'],
  ['an Alembic migration', file('alembic/versions/abc_add_col.py', ['op.add_column("users", sa.Column("is_admin"))']), 'migrations'],
  ['DDL in a SQL file', file('db/schema/roles.sql', ['ALTER TABLE users ADD COLUMN role text;']), 'migrations'],
  ['encrypted credentials', file('config/credentials.yml.enc', ['x']), 'secrets'],
  ['a key file', file('certs/server.pem', ['x']), 'secrets'],
  ['a CSP header', file('src/server.ts', ["res.setHeader('Content-Security-Policy', \"default-src *\")"]), 'web'],
  ['CORS for any origin', file('src/server.ts', ["  cors({ origin: '*', credentials: true })"]), 'web'],
  ['a removed rate limit', file('src/server.ts', [], ['app.use(rateLimit({ max: 5 }))']), 'web'],
  ['an HMAC of a webhook', file('src/hook.ts', ["crypto.createHmac('sha256', key).update(body)"]), 'webhooks'],
  ['a secret of the environment', file('src/pay.ts', ['const k = process.env.STRIPE_SECRET_KEY;']), 'secrets'],
  ['import.meta.env', file('src/x.ts', ['const k = import.meta.env.JWT_SECRET;']), 'secrets'],
  ['os.environ', file('app/x.py', ['k = os.environ["JWT_SECRET"]']), 'secrets'],
  ['a read of the session', file('src/x.ts', ['  if (!session?.user) throw redirect("/login");']), 'auth'],
  ['req.user', file('src/routes/projects.ts', ['  where: { ownerId: req.user.id }']), 'auth'],
  ['Nest guards', file('src/x.controller.ts', ['  @UseGuards(AuthGuard)']), 'auth'],
  ['a Django decorator', file('app/views.py', ['@login_required']), 'auth'],
  ['a Rails filter', file('app/controllers/x_controller.rb', ['  before_action :authenticate_user!']), 'auth'],
];

test('each surface of access, session, CI, supply chain, secrets and web security is critical', () => {
  for (const [label, changed, area] of SURFACES) assert.deepEqual(areaOf(changed), [area], label);
});

test('a filter of ownership that goes from a query is critical', () => {
  assert.deepEqual(areaOf(file('src/routes/projects.ts', ['  where: { id },'], ['  where: { id, orgId: user.orgId },'])), ['access']);
  assert.deepEqual(areaOf(file('src/db/projects.ts', ['  .where(eq(projects.id, id))'], ['  .where(and(eq(projects.id, id), eq(projects.orgId, orgId)))'])), ['access']);
  assert.deepEqual(areaOf(file('src/db/projects.ts', ['  const row = { orgId: user.orgId, name };'])), [], 'an added orgId is no removed filter');
});

test('a rename out of an auth folder counts its old path', () => {
  assert.deepEqual(areaOf({ path: 'src/lib/check.ts', from: 'src/auth/check.ts', added: [], removed: [] }), ['auth']);
});

test('the paths of authentication, access, secrets, webhooks, payments and migrations are critical', () => {
  const cases: [string, string][] = [
    ['app/lib/auth.server.ts', 'auth'],
    ['src/session/cookies.ts', 'auth'],
    ['src/auth/login.tsx', 'auth'],
    ['src/permissions/map.ts', 'access'],
    ['app/routes/webhooks/github.ts', 'webhooks'],
    ['src/billing/plan.ts', 'payments'],
    ['db/migrations/0042_roles.sql', 'migrations'],
    ['drizzle/0007_backfill.ts', 'migrations'],
    ['.env.production', 'secrets'],
  ];
  for (const [path, area] of cases) assert.deepEqual(areaOf(file(path)), [area], path);
  // A word of a route or of the admin area counts with logic in the changed lines.
  assert.deepEqual(areaOf(file('app/routes/api/orgMembers/$id.ts', ['  await db.delete(members).where(eq(members.id, id));'])), ['access']);
});

test('a copy change, a document, a test, a story or a style is not critical', () => {
  const none: [string, ChangedFile][] = [
    ['the header', file('app/components/Header.tsx', ['      <Button>Sign in to your session</Button>'], ['      <Button>Log in</Button>'])],
    ['the login page', file('app/routes/login.tsx', ['<h1>Welcome back</h1>'], ['<h1>Hello</h1>'])],
    ['an admin page', file('app/routes/admin/index.tsx', ['<h1>Dashboard</h1>'])],
    ['the privacy policy', file('app/routes/privacy-policy.tsx', ['<p>We keep data</p>'])],
    ['a role badge', file('app/components/RoleBadge.tsx', ['className="px-2"'])],
    ['useSessionStorage', file('src/hooks/useSessionStorage.ts', ['  return JSON.parse(window.sessionStorage.getItem(key) ?? "null");'])],
    ['GraphQL subscriptions', file('src/graphql/subscriptions.ts', ['  return pubsub.asyncIterator("x");'])],
    ['type guards', file('src/utils/guards.ts', ['export const isString = (x: unknown): x is string => typeof x === "string";'])],
    ['canGoBack', file('src/nav.ts', ['  if (history.canGoBack()) back();'])],
    ['canUndo', file('src/editor.ts', ['  if (editor.canUndo()) undo();'])],
    ['an ARIA role', file('src/a11y.ts', ["  if (node.role === 'button') return true;"])],
    ['the markup role', file('app/components/Menu.tsx', ['  <ul role="menu">'])],
    ['.env.example', file('.env.example', ['NEW_FLAG='])],
    ['a SQL query', file('src/queries/report.sql', ['SELECT id, total FROM invoices WHERE paid;'])],
    ['an invoice table', file('src/components/InvoiceTable.tsx', ['<td>{total}</td>'])],
    ['a README', file('README.md', ['Admins can sign in with SSO.'])],
    ['a document', file('docs/auth.md')],
    ['a translation', file('app/locales/en/auth.json', ['"signIn": "Sign in"'])],
    ['a test', file('test/auth.test.ts', ["  assert.equal(member.role === 'admin', true);"])],
    ['a Go test', file('auth/handler_test.go', ['  if user.role == "admin" {'])],
    ['a Python test', file('tests_py/test_auth.py', ['  assert user.is_admin'])],
    ['an RSpec spec', file('spec/requests/admin_spec.rb', ['  before_action :authenticate_user!'])],
    ['a Cypress test', file('cypress/integration/login.cy.ts', ['  cy.get("#password")'])],
    ['a Playwright test', file('playwright/login.ts', ['  await page.fill("#password", "x")'])],
    ['a story', file('src/components/Admin.stories.tsx', ['  args: { isAdmin: true },'])],
    ['a helper of the tests', file('src/testing/session.ts', ['  return { user: { role: "admin" } };'])],
    ['a style', file('app/routes/admin/styles.css')],
    ['a page that documents a cookie', file('site/pages/cookies.tsx', ['<code>sameSite</code>'])],
  ];
  for (const [label, changed] of none) assert.deepEqual(areaOf(changed), [], label);
});

test('the reasons list each area once, with at most five files each', () => {
  const found = criticality([...Array.from({ length: 8 }, (_, i) => file(`.github/workflows/w${i}.yml`)), file('src/auth/login.ts')]);
  assert.deepEqual(found?.areas, ['auth', 'ci']);
  assert.equal(found?.files.filter((f) => f.area === 'ci').length, 5);
});

// What a review names, checked against the diff of a change of `app/routes/members.ts` and its
// workflow, and the texts of the change.
const context: CheckContext = {
  files: new Set(['app/routes/members.ts', 'Dockerfile', '.github/workflows/ci.yml']),
  texts: ["router.post('/api/members/:id/remove', removeMember)\nimport { organization } from 'better-auth/plugins';"],
};
const checks = (paths: string[], roles: string[]): CheckResult => namesChecks({ paths, roles }, context);

test('a review names what it checked: a file of the diff, a route or a library of the change, and a real role', () => {
  assert.equal(checks(['app/routes/members.ts'], ['member', 'admin of another org']).checked, true);
  assert.equal(checks(['app/routes/members.ts#L12'], ['admin']).checked, true, 'an anchor of GitHub');
  assert.equal(checks(['app/routes/members.ts:12:3'], ['admin']).checked, true, 'a line and a column');
  assert.equal(checks(['The remove route in `app/routes/members.ts`, line 4.'], ['owner']).checked, true, 'a path inside a sentence');
  assert.equal(checks(['Dockerfile'], ['pull request from a fork']).checked, true, 'a file with no dot');
  assert.equal(checks(['.github/workflows/ci.yml#L10'], ['pull request from a fork']).checked, true);
  assert.equal(checks(['POST /api/members/:id/remove'], ['admin']).checked, true, 'a route of the change');
  assert.equal(checks(['lib better-auth: organization.removeMember'], ['owner']).checked, true, 'an endpoint of a library of the change');
});

test('a review cannot lift the cap with a file out of the diff, a sentence, or a placeholder role', () => {
  const capped: [string[], string[], string][] = [
    [['README.md'], ['none'], 'README.md and none'],
    [['package.json'], ['n/a'], 'package.json and n/a'],
    [['I did not check anything, see README.md'], ['-'], 'a sentence that names a file out of the diff'],
    [['README.md'], ['admin'], 'a real role, but a file out of the diff'],
    [['app/routes/members.ts'], ['none', 'n/a', '-', 'all', '', 'everyone', 'No role.'], 'only placeholder roles'],
    [['POST /api/billing'], ['admin'], 'a route that the change does not hold'],
    [['lib left-pad: pad'], ['admin'], 'a library that the change does not use'],
    [['every route'], ['member'], 'no file'],
    [[], [], 'nothing'],
  ];
  for (const [paths, roles, label] of capped) assert.equal(checks(paths, roles).checked, false, label);
  assert.deepEqual(checks(['README.md'], ['admin']).missing, ['paths']);
  assert.deepEqual(checks(['app/routes/members.ts'], ['all']).missing, ['roles']);
  assert.deepEqual(checks(['README.md', 'app/routes/members.ts'], ['admin']).others, ['README.md']);
  assert.equal(isRealRole('user who is not a member'), true, 'a role that holds "not" further on');
});

const critical = { areas: ['access' as const], files: [{ path: 'app/routes/members.ts', area: 'access' as const }] };
const review = (paths: string[], roles: string[], level: 'lite' | 'balanced' = 'balanced'): CriticalReview => criticalReview(critical, context, { checked: { paths, roles } }, level);
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
  const unchecked = answer({ critical: review([], []) });
  assert.equal(score(unchecked, lines), 3);
  assert.equal(verdict(unchecked, lines, 'balanced'), 'COMMENT');
  const gamed = answer({ critical: review(['README.md'], ['none']) });
  assert.equal(score(gamed, lines), 3, 'README.md and none stay capped');
  const checked = answer({ critical: review(['app/routes/members.ts'], ['admin']) });
  assert.equal(score(checked, lines), 5);
  assert.equal(verdict(checked, lines, 'balanced'), 'APPROVE');
  // Not critical: the score of the model.
  assert.equal(score(answer(), lines), 5);
  assert.equal(score(answer({ critical: null }), lines), 5);
});

test('a lite review of a critical change scores 3 at most and recommends a deeper one', () => {
  const lite = answer({ critical: review(['app/routes/members.ts'], ['admin'], 'lite') });
  assert.equal(score(lite, lines), 3, 'even when it names its checks');
  assert.match(deeperReview(lite, 'lite') ?? '', /changes access control, and a lite review does not check every route, role and permission/);
  assert.equal(verdict(lite, lines, 'lite'), 'COMMENT');
  assert.equal(deeperReview(answer({ critical: review(['app/routes/members.ts'], ['admin']) }), 'balanced'), null, 'only a lite review recommends one');
  assert.equal(deeperReview(answer(), 'lite'), null);
  // The reason of the model wins.
  assert.equal(deeperReview({ ...lite, deeper_review: { recommended: true, reason: 'Check the role route.' } }, 'lite'), 'Check the role route.');
});

test('one pass must name both a path and a role: a path of one pass and a role of another do not count', () => {
  const split = criticalReview(critical, context, { checkedByPass: [{ paths: ['app/routes/members.ts'], roles: [] }, { paths: [], roles: ['admin'] }] }, 'balanced');
  assert.equal(split.capped, true);
  const one = criticalReview(critical, context, { checkedByPass: [{ paths: [], roles: [] }, { paths: ['app/routes/members.ts'], roles: ['admin'] }] }, 'balanced');
  assert.equal(one.capped, false);
});

test('the text of a capped critical change: no "low risk", what is missing, and the paths not in the diff', () => {
  const both = withCriticalText(answer({ risk: 'Low risk. The role route has no lock.' }), review([], []));
  assert.equal(both.risk, 'Critical change (access control). The role route has no lock.');
  assert.match(both.summary, /The review named no file of the diff and no role that it checked, so the score of this critical change is 3 at most\./);
  const safe = withCriticalText(answer({ risk: 'Safe to merge.' }), review([], []));
  assert.equal(safe.risk, 'Critical change (access control). It needs a review that names the paths and the roles that it checked.');
  const paths = withCriticalText(answer(), review(['README.md'], ['admin']));
  assert.match(paths.summary, /Paths checked: `README\.md` \(not in the diff\)\. Roles checked: `admin`\. The review named no file of the diff, route or library endpoint of the change that it checked/);
  const roles = withCriticalText(answer(), review(['app/routes/members.ts'], ['none']));
  assert.match(roles.summary, /Paths checked: `app\/routes\/members\.ts`\. The review named no role \(a placeholder such as "none" or "all" is none\) that it checked/);
  const lite = withCriticalText(answer(), review(['app/routes/members.ts'], ['admin'], 'lite'));
  assert.match(lite.summary, /A lite review of a critical change scores 3 at most\./);
  assert.doesNotMatch(lite.risk, /Low risk/);
  // Not capped: the risk of the model stays.
  const ok = withCriticalText(answer({ risk: 'Low risk.' }), review(['app/routes/members.ts', 'README.md'], ['admin']));
  assert.equal(ok.risk, 'Critical change (access control). Low risk.');
  assert.match(ok.summary, /Paths checked: `app\/routes\/members\.ts`, `README\.md` \(not in the diff\)\. Roles checked: `admin`\.$/);
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
let pushed = '';
let moveHead = '';
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
  write('app/auth/check.ts', 'export const check = (id: string) => id.length > 0;\n');
  write('db/report.sql', '-- the report of the month\nSELECT id FROM orders;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  write('app/routes/members.ts', "export function remove(member: { role: string }) {\n  if (member.role === 'admin') throw new Error('no');\n}\n");
  git('commit', '-q', '-am', 'feat: admins cannot be removed');
  head = git('rev-parse', 'HEAD');
  write('app/routes/members.ts', "export function remove(member: { role: string }) {\n  if (member.role === 'admin' || member.role === 'owner') throw new Error('no');\n}\n");
  git('commit', '-q', '-am', 'fix: owners cannot be removed either');
  pushed = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'copy', base);
  write('app/components/Header.tsx', 'export const Header = () => <h1>Hello, sign in</h1>;\n');
  git('commit', '-q', '-am', 'copy: header');
  copyHead = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'move', base);
  mkdirSync(join(repo, 'app/lib'), { recursive: true });
  git('mv', 'app/auth/check.ts', 'app/lib/check.ts');
  write('db/report.sql', 'SELECT id FROM orders;\n');
  git('commit', '-q', '-am', 'refactor: move the check');
  moveHead = git('rev-parse', 'HEAD');
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
  assert.equal(result.answer.risk, 'Critical change (access control). It needs a review that names the paths and the roles that it checked.');
  assert.match(result.answer.summary, /named no file of the diff and no role that it checked, so the score of this critical change is 3 at most/);

  const named = fakeModel(answer({ checked: { paths: ['app/routes/members.ts'], roles: ['owner', 'admin'] } }));
  const checked = await reviewPullRequest(input(named.fetch));
  assert.equal(checked.critical?.checked, true);
  assert.equal(checked.score, 5);
  assert.equal(checked.verdict, 'APPROVE');
  assert.match(checked.answer.summary, /Paths checked: `app\/routes\/members\.ts`\. Roles checked: `owner`, `admin`\./);

  const lite = await reviewPullRequest(input(named.fetch, head, 'lite'));
  assert.match(lite.deeperReview ?? '', /changes access control/);
  assert.equal(lite.score, 3, 'a lite review of a critical change');

  // A file of the head that is not in the diff, and a placeholder role, do not lift the cap.
  const gamed = await reviewPullRequest(input(fakeModel(answer({ checked: { paths: ['app/components/Header.tsx'], roles: ['none'] } })).fetch));
  assert.equal(gamed.score, 3);
  assert.deepEqual(gamed.critical?.checks.missing, ['paths', 'roles']);
});

test('the diff of a move: the old path of a pure rename counts, and a removed SQL comment is a line, not a header', () => {
  const changed = changedFiles(repo, base, moveHead);
  assert.deepEqual(changed.find((f) => f.path === 'app/lib/check.ts'), { path: 'app/lib/check.ts', from: 'app/auth/check.ts', added: [], removed: [] });
  assert.deepEqual(changed.find((f) => f.path === 'db/report.sql')?.removed, ['-- the report of the month']);
  assert.deepEqual(diffCriticality(repo, base, moveHead)?.areas, ['auth']);
});


test('an incremental review of a critical change keeps the cap, the checklist and the text', async () => {
  const model = fakeModel(answer({ checked: { paths: [], roles: [] } }));
  const delta = { since: head, score: 5, findings: [], settled: [] };
  const result = await reviewPullRequest({ ...input(model.fetch, pushed), delta });
  assert.ok(result.delta, 'an incremental review');
  assert.deepEqual(result.answer.critical?.areas, ['access']);
  assert.equal(result.score, 3, 'the floor of the last review does not lift the cap');
  assert.equal(result.verdict, 'COMMENT');
  assert.match(model.messages[0]!, /# Critical change/);
  assert.match(result.answer.risk, /^Critical change \(access control\)\./);
  const lite = await reviewPullRequest({ ...input(model.fetch, pushed, 'lite'), delta });
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

test('the reuse key reads the checklist: a new checklist gives a new key', () => {
  assert.ok(PROMPT_FILES.includes('critical.md'));
});
