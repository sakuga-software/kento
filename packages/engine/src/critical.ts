// KNT-154. A critical change: a pull request that touches authentication, access control, CI,
// secrets, webhooks, payments or a migration of data. The review of such a change gets a checklist,
// a score of 3/5 at most unless it names the paths and the roles that it checked, and a lite review
// of it recommends a deeper one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.ts';

/** The areas that make a change critical. */
export const CRITICAL_AREAS = ['auth', 'access', 'ci', 'secrets', 'webhooks', 'payments', 'migrations'] as const;
export type CriticalArea = (typeof CRITICAL_AREAS)[number];

/** Why a change is critical: each area, with the files that put it there. Null: not critical. */
export type Criticality = { areas: CriticalArea[]; files: { path: string; area: CriticalArea }[] };

/** The lines of one changed file: its path at the head (or before a delete), its added and removed lines. */
export type ChangedFile = { path: string; added: string[]; removed: string[] };

// A test, a document or a translation file never makes a change critical by itself.
const TEST_FILE = /\.test\.|\.spec\.|(^|\/)(tests?|__tests__|e2e|fixtures?)\//;
const DOC_FILE = /\.(md|mdx|txt|rst|adoc)$|(^|\/)(docs?|locales?|i18n|translations?)\//;
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|php|cs|ex|exs|sql|prisma)$/;

// The files of CI: a workflow, an action, the config of another CI service, and a script under ci/.
const CI_FILE = /^\.github\/(workflows|actions)\/|^\.gitlab-ci\.ya?ml$|^\.circleci\/|^\.buildkite\/|(^|\/)Jenkinsfile$|^azure-pipelines\.ya?ml$|(^|\/)(ci|\.ci)\/|^scripts\/ci[-_./]/;
// A migration of data, a backfill, or a schema that a migration tool reads.
const MIGRATION_FILE = /(^|\/)migrations?\/|(^|[\/_.-])backfills?([-_./]|$)|\.sql$|(^|\/)schema\.prisma$/;
// A file of secrets or of the environment.
const SECRET_FILE = /(^|\/)\.env(\.[\w-]+)?$|(^|\/)(secrets?|credentials?)(\.[\w-]+)?$/;

// The words of a path, split on separators and on camelCase: `routes/api/orgMembers/$id.ts` gives
// `routes api org members id ts`.
const words = (path: string): string[] =>
  path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const PATH_WORDS: Record<Exclude<CriticalArea, 'ci' | 'migrations'>, ReadonlySet<string>> = {
  auth: new Set(['auth', 'authn', 'authentication', 'login', 'logout', 'signin', 'signup', 'oauth', 'oidc', 'saml', 'sso', 'session', 'sessions', 'password', 'passwords', 'jwt', 'csrf', 'impersonation', 'impersonate']),
  access: new Set(['authz', 'authorization', 'authorize', 'permission', 'permissions', 'role', 'roles', 'rbac', 'acl', 'acls', 'policy', 'policies', 'guard', 'guards', 'member', 'members', 'membership', 'memberships', 'invitation', 'invitations', 'invite', 'invites', 'admin', 'admins']),
  secrets: new Set(['secret', 'secrets', 'credential', 'credentials', 'vault', 'kms']),
  webhooks: new Set(['webhook', 'webhooks']),
  payments: new Set(['payment', 'payments', 'billing', 'stripe', 'invoice', 'invoices', 'subscription', 'subscriptions', 'refund', 'refunds', 'payout', 'payouts']),
};

// Changed code that checks who may act, or that handles a credential: the lines of a role check in
// a file whose path names nothing of it. Identifiers only: the text of a screen ("Sign in") is copy.
const CONTENT: { area: CriticalArea; pattern: RegExp }[] = [
  {
    area: 'access',
    pattern:
      /\b(isAdmin|isOwner|hasRole|hasPermission|requireRole|requireAdmin|requireOwner|requirePermission|checkPermission|assertPermission|authorize[A-Z]?\w*|can[A-Z]\w*\s*\()|\.role\s*(===|!==|==|!=)|\brole\s*(===|!==|==|!=|in\b)|\b(roles|permissions)\s*\.\s*(includes|has|some|every|indexOf)\s*\(/,
  },
  {
    area: 'auth',
    pattern: /\b(getSession|requireAuth|requireUser|requireSession|verifyToken|verifyPassword|hashPassword|timingSafeEqual|bcrypt|argon2|jwt\.(sign|verify|decode)|setCookie|httpOnly|sameSite)\b/,
  },
  { area: 'webhooks', pattern: /x-hub-signature|\bverifySignature\b|\bwebhook[A-Z_]?\w*\s*\(/i },
  { area: 'secrets', pattern: /process\.env\.[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)\b/ },
];

// The most files that the reasons of a critical change list for each area.
const MAX_FILES_PER_AREA = 5;

/** The area of a path, from the path alone, or null. */
export function pathArea(path: string): CriticalArea | null {
  if (CI_FILE.test(path)) return 'ci';
  if (TEST_FILE.test(path) || DOC_FILE.test(path)) return null;
  if (SECRET_FILE.test(path)) return 'secrets';
  if (MIGRATION_FILE.test(path)) return 'migrations';
  if (!SOURCE_FILE.test(path)) return null;
  const pathWords = words(path);
  for (const area of ['auth', 'access', 'secrets', 'webhooks', 'payments'] as const) {
    if (pathWords.some((w) => PATH_WORDS[area].has(w))) return area;
  }
  return null;
}

/** The area of the changed lines of a source file, or null. */
export function contentArea(file: ChangedFile): CriticalArea | null {
  if (TEST_FILE.test(file.path) || DOC_FILE.test(file.path) || !SOURCE_FILE.test(file.path)) return null;
  const lines = [...file.added, ...file.removed];
  for (const { area, pattern } of CONTENT) if (lines.some((line) => pattern.test(line))) return area;
  return null;
}

/** Whether a change is critical, from its changed files. Null: not critical. */
export function criticality(files: readonly ChangedFile[]): Criticality | null {
  const found: { path: string; area: CriticalArea }[] = [];
  for (const file of files) {
    const area = pathArea(file.path) ?? contentArea(file);
    if (area && found.filter((f) => f.area === area).length < MAX_FILES_PER_AREA) found.push({ path: file.path, area });
  }
  if (!found.length) return null;
  const areas = CRITICAL_AREAS.filter((area) => found.some((f) => f.area === area));
  return { areas, files: found };
}

/** The changed files of `base...head`, with their added and removed lines. */
export function changedFiles(repo: string, base: string, head: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;
  let from: string | null = null;
  for (const row of git(repo, 'diff', '-U0', '--no-color', `${base}...${head}`).split('\n')) {
    if (row.startsWith('diff --git ')) {
      current = null;
      from = null;
    } else if (row.startsWith('--- ')) {
      from = row.startsWith('--- a/') ? row.slice(6) : null;
    } else if (row.startsWith('+++ ')) {
      // A deleted file has no path at the head: its old path counts.
      const path = row.startsWith('+++ b/') ? row.slice(6) : from;
      current = path ? { path, added: [], removed: [] } : null;
      if (current) files.push(current);
    } else if (current && row.startsWith('+')) current.added.push(row.slice(1));
    else if (current && row.startsWith('-')) current.removed.push(row.slice(1));
  }
  return files;
}

/** Whether `base...head` is a critical change. */
export function diffCriticality(repo: string, base: string, head: string): Criticality | null {
  return criticality(changedFiles(repo, base, head));
}

/**
 * The section of the pack of a critical change: its areas and files, then the checklist of
 * prompts/critical.md. `prompts` replaces the text of that file, as for the review prompt (model.ts).
 */
export function criticalSection(critical: Criticality, prompts?: Partial<Record<string, string>>): string {
  const checklist = (prompts?.['critical.md'] ?? readFileSync(join(import.meta.dirname, '..', 'prompts', 'critical.md'), 'utf8')).trim();
  const rows = critical.files.map((f) => `- ${f.area}: \`${f.path}\``).join('\n');
  return `\n\n# Critical change\n\nThe engine marks this pull request as critical. It changes these areas: ${critical.areas.join(', ')}.\n\n${rows}\n\n${checklist}\n`;
}

/** The paths and the roles that a review of a critical change says that it checked. */
export type Checked = { paths: string[]; roles: string[] };

/**
 * Whether a review named what it checked: one path or more that is a file at the head (`exists`),
 * and one role or more. A path can carry a line (`a.ts:12`) or sit in a sentence.
 */
export function namesChecks(checked: Checked | undefined | null, exists: (path: string) => boolean): boolean {
  if (!checked) return false;
  const roles = (checked.roles ?? []).filter((r) => typeof r === 'string' && r.trim());
  const paths = (checked.paths ?? []).filter((entry) =>
    String(entry)
      .split(/[\s,;()`'"]+/)
      .map((token) => token.replace(/^\/+/, '').replace(/(:\d+(-\d+)?)?[.:]?$/, ''))
      .some((token) => token.includes('.') && exists(token)),
  );
  return roles.length > 0 && paths.length > 0;
}

/** The text of the areas, as a reader sees them: "access control and CI". */
export function areasText(areas: readonly CriticalArea[]): string {
  const name: Record<CriticalArea, string> = {
    auth: 'authentication',
    access: 'access control',
    ci: 'CI',
    secrets: 'secrets',
    webhooks: 'webhooks',
    payments: 'payments',
    migrations: 'data migrations',
  };
  const names = areas.map((a) => name[a]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}
