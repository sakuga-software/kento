// KNT-154. A critical change: a pull request that touches authentication, access control, CI, the
// supply chain, secrets, webhooks, payments, a migration of data or the security of the web layer.
// The review of such a change gets a checklist, and a score of 3/5 at most unless it names a file
// of the diff and a role that it checked. A lite review of it scores 3 at most and recommends a
// deeper one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.ts';

/** The areas that make a change critical. */
export const CRITICAL_AREAS = ['auth', 'access', 'ci', 'supply', 'secrets', 'webhooks', 'payments', 'migrations', 'web'] as const;
export type CriticalArea = (typeof CRITICAL_AREAS)[number];

/** Why a change is critical: each area, with the files that put it there. Null: not critical. */
export type Criticality = { areas: CriticalArea[]; files: { path: string; area: CriticalArea }[] };

/**
 * The lines of one changed file: its path at the head (or before a delete), the path before a
 * rename (`from`), and its added and removed lines.
 */
export type ChangedFile = { path: string; from?: string; added: string[]; removed: string[] };

// A test, a story, a document or a translation never makes a change critical by itself.
const TEST_FILE =
  /\.(test|spec|cy|e2e|stories)\.[a-z]+$|_(test|spec)\.(go|py|rb|ts|js|ex|exs)$|(^|\/)test_[^/]*\.py$|(^|\/)(tests?|tests?_\w+|__tests__|__mocks__|mocks?|spec|specs|e2e|fixtures?|cypress|playwright|testing|stories)\//;
const DOC_FILE = /\.(md|mdx|txt|rst|adoc)$|(^|\/)(docs?|locales?|i18n|translations?)\//;
// Code, and the templates that hold code (a role check in a Svelte or a Vue file).
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|svelte|vue|astro|erb|py|rb|go|rs|java|kt|php|cs|ex|exs|prisma)$/;
// A file of config that can hold rules of access.
const CONFIG_FILE = /\.(ya?ml|json|toml|rules|rego)$/;
const SQL_FILE = /\.sql$/;
const PACKAGE_FILE = /(^|\/)package\.json$/;
const LOCK_FILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json)$/;

// The files of CI: a workflow, an action, the config of another CI service, and a script under ci/.
const CI_FILE =
  /^\.(github|gitea|forgejo)\/(workflows|actions)\/|^\.gitlab-ci\.ya?ml$|^\.circleci\/|^\.buildkite\/|(^|\/)Jenkinsfile$|^azure-pipelines\.ya?ml$|^bitbucket-pipelines\.ya?ml$|(^|\/)\.?ci\/|^scripts\/ci[-_./]/;
// The supply chain: the build of an image, an action of the repository, the owners of the code, the
// updates of the dependencies, and the config of the package manager.
const SUPPLY_FILE =
  /(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$|\.dockerfile$|^action\.ya?ml$|(^|\/)CODEOWNERS$|^\.github\/dependabot\.ya?ml$|(^|\/)renovate\.json5?$|(^|\/)\.(npmrc|yarnrc|yarnrc\.yml|pnpmfile\.cjs)$/;
// A migration of data, a backfill, or a schema that a migration tool reads.
const MIGRATION_FILE = /(^|\/)(migrations?|migrate)\/|(^|\/)alembic\/versions\/|(^|[/_.-])backfills?([-_./]|$)|(^|\/)schema\.prisma$/;
// A file of secrets or of the environment. An example of the environment holds no secret.
const SECRET_FILE =
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$|defaults$)[\w-]+)?$|(^|\/)(secrets?|credentials?)(\.[\w.-]+)?$|\.(pem|key|p12|pfx|jks|keystore)$|(^|\/)id_(rsa|ecdsa|ed25519)$/;
// A folder whose files gate a request or hold the rules of access: any change there is critical.
const AUTH_FOLDER = /(^|\/)(auth|authn|authentication|sessions?|security|middlewares?)\//;
const ACCESS_FOLDER = /(^|\/)(authz|authorization|permissions?|policies|rbac|acl)\//;
// The gate of every request of a framework: Next.js `middleware.ts`, SvelteKit `hooks.server.ts`.
// A hook of the client that follows the user of the session: `useCurrentUser.ts`, `useSession.ts`.
const GATE_FILE = /(^|\/)(middleware|hooks\.server)\.[jt]s$|(^|\/)use(CurrentUser|Session|Auth|Viewer|Me)\.[jt]sx?$/;
// A file of rules of access: `permissions.yml`, `roles.json`, `firestore.rules`, a Rego policy.
const RULES_FILE = /(^|\/)(permissions?|roles|policies|policy|acl)\.(ya?ml|json|toml)$|\.rules(\.json)?$|\.rego$/;
// A map of the routes to their permissions or domains: `route-domains.ts`, `routePermissions.ts`.
const ROUTE_MAP_FILE = /(^|\/)routes?[-_]?(domains?|permissions?|scopes?|access|polic(y|ies)|guards?)\.[a-z]+$/i;
const WEBHOOK_FOLDER = /(^|\/)webhooks?\//;
const PAYMENT_FOLDER = /(^|\/)(billing|payments?|stripe|checkout)\//;

// The words of a name, split on separators and on camelCase: `orgMembers.ts` gives `org members ts`.
const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// A word of the name of a file that makes it critical alone: `auth.server.ts`, `rbac.ts`, `billing.ts`.
const STRONG_WORDS: [CriticalArea, ReadonlySet<string>][] = [
  ['auth', new Set(['auth', 'authn', 'authentication'])],
  ['access', new Set(['authz', 'authorization', 'permission', 'permissions', 'rbac', 'acl', 'acls'])],
  ['webhooks', new Set(['webhook', 'webhooks'])],
  ['payments', new Set(['billing', 'payment', 'payments', 'stripe'])],
];
// A word of a path that makes the file critical only when its changed lines hold logic: a change of
// the text of `routes/login.tsx` or of `routes/admin/index.tsx` is copy.
const WEAK_WORDS: [CriticalArea, ReadonlySet<string>][] = [
  ['auth', new Set(['login', 'logout', 'signin', 'signup', 'oauth', 'oidc', 'saml', 'sso', 'session', 'sessions', 'password', 'passwords', 'jwt', 'csrf', 'impersonate', 'impersonation'])],
  ['access', new Set(['role', 'roles', 'member', 'members', 'membership', 'memberships', 'invitation', 'invitations', 'invite', 'invites', 'admin', 'admins', 'owner', 'owners'])],
  ['payments', new Set(['invoice', 'invoices', 'refund', 'refunds', 'payout', 'payouts', 'checkout'])],
  ['secrets', new Set(['secret', 'secrets', 'credential', 'credentials', 'vault', 'kms'])],
];
// A changed line that does something: a condition, a return, a call that writes. A line of markup
// text or of a class name is none.
const LOGIC = /\bawait\b|\bif\s*\(|\breturn\b|=>|\bfunction\b|\bwhere\b|\bthrow\b|&&|\|\||\.(delete|update|insert|remove|create|upsert|set|save|destroy)\w*\s*\(/;

// The roles of ARIA, which a check of `node.role` compares: no role of a user.
const ARIA_ROLE = /role\s*(===|!==|==|!=)\s*['"`](button|link|menu|menuitem|dialog|alertdialog|tab|tabpanel|checkbox|radio|listbox|option|presentation|none|img|heading|navigation|main|textbox|grid|row|cell|switch|slider|tooltip|status|alert|region|banner|list|listitem|group|separator|combobox|searchbox|form|article)['"`]/;

/** A rule of the changed lines: its area, its pattern, and whether it reads only the removed lines. */
type ContentRule = { area: CriticalArea; pattern: RegExp; removedOnly?: boolean; unless?: RegExp };

// Changed code that checks who may act, or that handles a session, a credential or a signature.
// Identifiers only: the text of a screen ("Sign in") is copy.
const CODE_RULES: ContentRule[] = [
  {
    area: 'access',
    pattern:
      /\b(isAdmin|isOwner|isStaff|isSuperuser|isSuperAdmin|isModerator|hasRoles?|hasPermissions?|hasAccess|hasScope|requireRole|requireAdmin|requireOwner|requirePermission|checkPermission|checkAccess|assertPermission|assertCan|authorize[A-Z]?\w*|userIs[A-Z]\w*|ensure[A-Z]\w*(Admin|Owner|Member|Access|Permission)\w*)\b/,
  },
  { area: 'access', pattern: /\bcan(Edit|Delete|Manage|Update|Create|Write|Read|View|Access|Invite|Remove|Publish|Approve|Admin|Administer|Moderate|Impersonate|Transfer)\w*\b/ },
  {
    area: 'access',
    pattern: /\b(user|member|me|viewer|actor|account|currentUser|membership|profile|principal|session\??\.user|ctx\.user|req\.user|request\.user|locals\.user)\??\.(role|roles|isAdmin|permissions)\b/,
  },
  { area: 'access', pattern: /\brole\s*(===|!==|==|!=)\s*['"`]|\brole\s+in\b/, unless: ARIA_ROLE },
  { area: 'access', pattern: /\b(roles|permissions|scopes|grants)\??\.(includes|has|some|every|indexOf)\s*\(/ },
  { area: 'access', pattern: /\b\w*[a-z]Permissions?\b|\bpermissions?\s*[:=[(]/ },
  // A check against a list of protected values: a reserved name, a blocked domain.
  { area: 'access', pattern: /\b(PROTECTED|RESERVED|BLOCKED|BANNED|FORBIDDEN|DENIED)_?\w*\.(has|includes)\s*\(|\b(isReserved|isProtected|reservedNames|protectedNames|blockedNames)\b/i },
  // A filter of ownership that goes from a query: the rows of another org can then be read.
  { area: 'access', pattern: /\b(orgId|organizationId|organisationId|tenantId|ownerId|workspaceId|teamId|accountId|org_id|organization_id|tenant_id|owner_id|workspace_id|team_id|account_id)\b\s*[:=,)]/, removedOnly: true },
  // The guards of a framework.
  {
    area: 'auth',
    pattern: /@UseGuards|\bAuthGuard\b|@PreAuthorize|@RolesAllowed|@Secured|@login_required|@permission_required|@requires_auth|\bbefore_action\s+:(authenticate|authorize|require)\w*!?|\bskip_before_action\s+:authenticate|\bpassport\.authenticate|\bprotect_from_forgery/,
  },
  {
    area: 'auth',
    pattern:
      /\b(getSession|getServerSession|requireAuth|requireUser|requireSession|validateSession|verifySession|invalidateSession|createSession|destroySession|verifyToken|verifyJwt|verifyPassword|hashPassword|comparePassword|timingSafeEqual|bcrypt|argon2|scrypt|signIn|signOut|setCookie|useCurrentUser|currentUser)\b|\b(httpOnly|sameSite|secure)\s*[:=]|\bjwt\.(sign|verify|decode)\b|\bcookies\(\)\.(get|set|delete)\b|\.cookies\.(get|set|delete)\b|\buseSession\s*\(|\bsession\??\.(user|userId|destroy|regenerate)\b|\b(req|request|ctx\.state|locals|event\.locals)\.user\b|\bqueryClient\.(clear|resetQueries|removeQueries)\s*\(/,
  },
  { area: 'webhooks', pattern: /x-hub-signature|stripe-signature|x-signature|\bcreateHmac\b|\bverifySignature\b|\bconstructEvent\b|\bverifyWebhook\w*/i },
  { area: 'secrets', pattern: /(process\.env|import\.meta\.env|Deno\.env\.get\(|os\.environ(\.get)?|os\.getenv|\bENV)\W{0,3}[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|API_KEY|_KEY|CREDENTIAL)/ },
  {
    area: 'web',
    pattern: /Content-Security-Policy|contentSecurityPolicy|\bhelmet\s*\(|Access-Control-Allow-(Origin|Credentials)|\bcors\s*\(|origin:\s*['"`]\*['"`]|\brate_?[lL]imit\w*|\bRateLimit\w*|\bthrottle\w*\s*\(|X-Frame-Options|Strict-Transport-Security/,
  },
];
// A config file that holds rules of access: a key of permissions or roles, or a rule of Firebase.
const CONFIG_RULES: ContentRule[] = [{ area: 'access', pattern: /^\s*["']?(permissions|roles|scopes|policies|acl|allow|deny)["']?\s*:|\ballow\s+(read|write|create|update|delete|list|get)\b/i }];
// A script of the package manager that runs on install, a registry, or a dependency from git.
const PACKAGE_RULES: ContentRule[] = [{ area: 'supply', pattern: /"(pre|post)?install"|"prepare"|"prepublish(Only)?"|"(pre|post)pack"|"publishConfig"|"registry"|"(git\+|github:|https?:\/\/)/ }];
// A lock file whose source of a package is not the public registry: more than a change of version.
const LOCK_RULES: ContentRule[] = [{ area: 'supply', pattern: /(git\+|github:|codeload\.github|https?:\/\/(?!registry\.npmjs\.org|registry\.yarnpkg\.com)[\w.-]+\/)/ }];
// A change of the schema or of the rights in a SQL file: a plain query is none.
const SQL_RULES: ContentRule[] = [
  { area: 'migrations', pattern: /\b(create|alter|drop|truncate|rename)\s+(table|index|column|type|schema|view|policy|role|function|trigger|extension|sequence)\b|\b(grant|revoke)\b/i },
];

// The most files that the reasons of a critical change list for each area.
const MAX_FILES_PER_AREA = 5;

const excluded = (path: string) => TEST_FILE.test(path) || DOC_FILE.test(path);

/** The area of a path, from the path alone, or null. */
export function pathArea(path: string): CriticalArea | null {
  if (CI_FILE.test(path)) return 'ci';
  if (excluded(path)) return null;
  if (SUPPLY_FILE.test(path)) return 'supply';
  if (SECRET_FILE.test(path)) return 'secrets';
  if (MIGRATION_FILE.test(path)) return 'migrations';
  if (RULES_FILE.test(path) || ROUTE_MAP_FILE.test(path) || ACCESS_FOLDER.test(path)) return 'access';
  if (GATE_FILE.test(path) || AUTH_FOLDER.test(path)) return 'auth';
  if (WEBHOOK_FOLDER.test(path)) return 'webhooks';
  if (PAYMENT_FOLDER.test(path)) return 'payments';
  if (!SOURCE_FILE.test(path)) return null;
  const name = words(path.split('/').pop() ?? '');
  for (const [area, set] of STRONG_WORDS) if (name.some((w) => set.has(w))) return area;
  return null;
}

/** The area of the words of a path when the changed lines hold logic, or null. */
function weakPathArea(file: ChangedFile): CriticalArea | null {
  if (excluded(file.path) || !SOURCE_FILE.test(file.path)) return null;
  // `useSessionStorage` is the storage of the browser, no session of a user.
  const pathWords = words(file.path).filter((w, i, all) => !(w === 'session' && all[i + 1] === 'storage'));
  const lines = [...file.added, ...file.removed];
  if (!lines.some((line) => LOGIC.test(line))) return null;
  for (const [area, set] of WEAK_WORDS) if (pathWords.some((w) => set.has(w))) return area;
  return null;
}

function matchRules(rules: readonly ContentRule[], file: ChangedFile): CriticalArea | null {
  for (const { area, pattern, removedOnly, unless } of rules) {
    const lines = removedOnly ? file.removed : [...file.added, ...file.removed];
    if (lines.some((line) => pattern.test(line) && !(unless && unless.test(line)))) return area;
  }
  return null;
}

/** The area of the changed lines of a file, or null. */
export function contentArea(file: ChangedFile): CriticalArea | null {
  if (LOCK_FILE.test(file.path)) return matchRules(LOCK_RULES, file);
  if (excluded(file.path)) return null;
  if (PACKAGE_FILE.test(file.path)) return matchRules(PACKAGE_RULES, file);
  if (SQL_FILE.test(file.path)) return matchRules(SQL_RULES, file);
  if (SOURCE_FILE.test(file.path)) return matchRules(CODE_RULES, file);
  if (CONFIG_FILE.test(file.path)) return matchRules(CONFIG_RULES, file);
  return null;
}

/** The area of one changed file: its path, its old path, then its changed lines. Null: none. */
export function fileArea(file: ChangedFile): CriticalArea | null {
  return pathArea(file.path) ?? (file.from ? pathArea(file.from) : null) ?? contentArea(file) ?? weakPathArea(file);
}

/** Whether a change is critical, from its changed files. Null: not critical. */
export function criticality(files: readonly ChangedFile[]): Criticality | null {
  const found: { path: string; area: CriticalArea }[] = [];
  for (const file of files) {
    const area = fileArea(file);
    if (area && found.filter((f) => f.area === area).length < MAX_FILES_PER_AREA) found.push({ path: file.path, area });
  }
  if (!found.length) return null;
  const areas = CRITICAL_AREAS.filter((area) => found.some((f) => f.area === area));
  return { areas, files: found };
}

/** The changed files of `base...head`, with their added and removed lines, and the old path of a rename. */
export function changedFiles(repo: string, base: string, head: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;
  // The header of a file runs from `diff --git` to its first hunk: a removed line `-- x` of a hunk
  // reads `--- x`, and is no header.
  let header = false;
  let from: string | null = null;
  let renamedFrom: string | null = null;
  const start = (path: string) => {
    current = { path, ...(renamedFrom && renamedFrom !== path ? { from: renamedFrom } : {}), added: [], removed: [] };
    files.push(current);
  };
  for (const row of git(repo, 'diff', '-U0', '--no-color', '-M', `${base}...${head}`).split('\n')) {
    if (row.startsWith('diff --git ')) {
      current = null;
      header = true;
      from = null;
      renamedFrom = null;
    } else if (header && row.startsWith('@@')) {
      header = false;
    } else if (header) {
      if (row.startsWith('rename from ')) renamedFrom = row.slice('rename from '.length);
      // A rename with no change of content has no `---` and `+++` lines.
      else if (row.startsWith('rename to ')) start(row.slice('rename to '.length));
      else if (row.startsWith('--- ')) from = row.startsWith('--- a/') ? row.slice(6) : null;
      else if (row.startsWith('+++ ') && !current) {
        // A deleted file has no path at the head: its old path counts.
        const path = row.startsWith('+++ b/') ? row.slice(6) : from;
        if (path) start(path);
      }
    } else if (current && row.startsWith('+')) (current as ChangedFile).added.push(row.slice(1));
    else if (current && row.startsWith('-')) (current as ChangedFile).removed.push(row.slice(1));
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
 * What a named path can be checked against: the files of the diff and the critical files (`files`),
 * and the texts where a route or a library must appear (`texts`: the changed lines, and the critical
 * files at the head).
 */
export type CheckContext = { files: ReadonlySet<string>; texts: readonly string[] };

/**
 * What the engine verified of the `checked` of an answer: the paths that name a file of the diff, a
 * route or a library that the texts hold (`paths`), the others (`others`), the roles that are no
 * placeholder (`roles`), and what is missing for the cap to go.
 */
export type CheckResult = { checked: boolean; paths: string[]; others: string[]; roles: string[]; missing: ('paths' | 'roles')[] };

// A role that names no role.
const PLACEHOLDER_ROLES = new Set(['', 'none', 'n/a', 'na', 'n.a', '-', '--', '—', '–', 'all', 'any', 'anyone', 'everyone', 'all roles', 'every role', 'any role', 'all users', 'nothing', 'unknown', 'tbd', '?', 'null', 'undefined', 'no role', 'no roles', 'not applicable']);

const normalRole = (role: string) => role.toLowerCase().replace(/[`'"*_]/g, '').replace(/\s+/g, ' ').trim().replace(/^[.,;:]+|[.,;:]+$/g, '');

/** Whether a role is a real role, and no placeholder ("none", "n/a", "-", "all", empty). */
export function isRealRole(role: unknown): boolean {
  if (typeof role !== 'string') return false;
  const text = normalRole(role);
  return !PLACEHOLDER_ROLES.has(text) && !/^(no|not|none)\b/.test(text);
}

// A token of a path, without its anchor: `a.ts#L12-L14`, `a.ts:12:3`, `a.ts:12-14`, `./a.ts`.
const pathToken = (token: string) =>
  token
    .replace(/^[./]*\//, '')
    .replace(/^\/+/, '')
    .replace(/#L\d+(-L?\d+)?$/, '')
    .replace(/(:\d+){1,2}(-\d+)?$/, '')
    .replace(/[.,:;]+$/, '');

const ROUTE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[\w\-./:{}$[\]*]*)/;
const LIBRARY = /^\s*lib(?:rary)?\s+([@\w./-]+)\s*:\s*\S/i;

/** Whether one entry of `checked.paths` names a file of the diff, a route or a library that the context holds. */
function verifiedPath(entry: unknown, context: CheckContext): boolean {
  if (typeof entry !== 'string') return false;
  const tokens = entry.split(/[\s,;()[\]{}<>`'"]+/).map(pathToken).filter(Boolean);
  if (tokens.some((t) => context.files.has(t))) return true;
  const route = ROUTE.exec(entry)?.[2];
  if (route) {
    // A route up to its first parameter: `/api/members/:id` gives `/api/members`.
    const literal = route.split(/[:{$[*]/)[0]!.replace(/\/+$/, '');
    if (literal.length > 1 && context.texts.some((text) => text.includes(literal))) return true;
  }
  const library = LIBRARY.exec(entry)?.[1];
  return Boolean(library && library.length > 1 && context.texts.some((text) => text.includes(library)));
}

/**
 * Whether a review named what it checked: one path that is a file of the diff or a critical file
 * (with or without an anchor, alone or inside a sentence), a route or a library endpoint that the
 * changed lines or the critical files hold (`POST /api/members`, `lib better-auth: removeMember`),
 * and one role that is no placeholder.
 */
export function namesChecks(checked: Checked | undefined | null, context: CheckContext): CheckResult {
  const entries = (checked?.paths ?? []).filter((p): p is string => typeof p === 'string' && Boolean(p.trim()));
  const paths = entries.filter((p) => verifiedPath(p, context));
  const others = entries.filter((p) => !paths.includes(p));
  const roles = (checked?.roles ?? []).filter(isRealRole);
  const missing = [...(paths.length ? [] : (['paths'] as const)), ...(roles.length ? [] : (['roles'] as const))];
  return { checked: missing.length === 0, paths, others, roles, missing };
}

/** The text of the areas, as a reader sees them: "access control and CI". */
export function areasText(areas: readonly CriticalArea[]): string {
  const name: Record<CriticalArea, string> = {
    auth: 'authentication',
    access: 'access control',
    ci: 'CI',
    supply: 'the supply chain',
    secrets: 'secrets',
    webhooks: 'webhooks',
    payments: 'payments',
    migrations: 'data migrations',
    web: 'web security',
  };
  const names = areas.map((a) => name[a]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}
