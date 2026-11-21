// Writes the frames of the board design/socle/ from the real components of the app, so that the
// board shows the markup and the stylesheet that the screens use.
//
//   pnpm -F @kento-review/web design:board
//
// Each frame is one HTML document; the board shows it in an <iframe> at its width, so that the
// media queries of the stylesheet apply as on a screen of that width.
import { mkdir, writeFile } from 'node:fs/promises'

import { renderToString } from 'remix/component/server'

import type { RepoView } from '../app/repos/store.ts'
import { buttonClass } from '../app/ui/controls.tsx'
import { ReposPage, type ReposPageProps } from '../app/ui/repos.tsx'
import { Shell, type PageFrame, type Viewer } from '../app/ui/shell.tsx'
import { SignInPage } from '../app/ui/sign-in.tsx'
import type { Theme } from '../app/ui/theme.ts'
import type { RunnersScreen } from '../app/runner/admin.ts'
import { RunnersPage } from '../app/ui/runners.tsx'
import type { ProviderView } from '../app/providers/store.ts'
import { SettingsPage, type SettingsPageProps } from '../app/ui/settings.tsx'
import { serviceProviders } from '../app/repo-config/providers.ts'
import type { RepoConfigView } from '../app/repo-config/store.ts'
import { ConfigPage, type ConfigPageProps } from '../app/ui/config.tsx'
import type { DashboardScreen } from '../app/dashboard/store.ts'
import { DashboardPage, type DashboardPageProps } from '../app/ui/dashboard.tsx'
import type { AppStatus } from '../app/org-settings/app-status.ts'
import type { OrgSettingsView } from '../app/org-settings/store.ts'
import type { OrgSectionProps } from '../app/ui/org-settings.tsx'

const OUT = new URL('../../../design/socle/frames/', import.meta.url)
// From design/socle/frames/ to the assets of the app.
const ASSETS = '../../../apps/web/public/assets/'

const admin: Viewer = { login: 'octocat', name: 'Alex Martin', avatarUrl: null, role: 'admin', canEdit: true, org: { id: 'org-1', name: 'sakuga-software' }, orgs: [{ id: 'org-1', name: 'sakuga-software', role: 'admin' }] }
const member: Viewer = { ...admin, login: 'camille', name: 'Camille', role: 'member', canEdit: false }

function frame(theme: Theme, viewer: Viewer | null, path: string): PageFrame {
  return { theme, version: '0.1.0', assetVersion: 'board', viewer, csrfToken: 'board', path }
}

const frames: { file: string; node: unknown }[] = [
  {
    file: 'signin-paper.html',
    node: <SignInPage theme="paper" version="0.1.0" assetVersion="board" signInHref="#" notice={null} />,
  },
  {
    file: 'signin-refused-sumi-390.html',
    node: <SignInPage theme="sumi" version="0.1.0" assetVersion="board" signInHref="#" notice="not_member" />,
  },
  {
    file: 'dashboard-admin-paper.html',
    node: (
      <Shell
        frame={frame('paper', admin, '/')}
        section="dashboard"
        title="Dashboard"
        lead="What runs, what failed, and what it costs."
        actions={<a class={buttonClass('primary')} href="#">Run again at balanced</a>}
      >
        <section class="empty"><h2>Soon here</h2><p>The last reviews, the job queue, the cost of the day and the runners will show here.</p></section>
      </Shell>
    ),
  },
  {
    file: 'repos-member-sumi.html',
    node: (
      <Shell
        frame={frame('sumi', member, '/repos')}
        section="repos"
        title="Repos"
        lead="The repos of the installation, and where each one is in its switch."
        actions={<a class={buttonClass('primary')} href="#">Enable a repo</a>}
      >
        <section class="empty"><h2>Soon here</h2><p>The list of the repos, their mode and their switch counter will show here.</p></section>
      </Shell>
    ),
  },
  {
    file: 'dashboard-member-paper-390.html',
    node: (
      <Shell frame={frame('paper', member, '/')} section="dashboard" title="Dashboard" lead="What runs, what failed, and what it costs.">
        <section class="empty"><h2>Soon here</h2><p>The last reviews, the job queue, the cost of the day and the runners will show here.</p></section>
      </Shell>
    ),
  },
  {
    file: 'runners-admin-sumi-390.html',
    node: (
      <Shell frame={frame('sumi', admin, '/runners')} section="runners" title="Runners" lead="The machines that do the reviews." actions={<a class={buttonClass('primary')} href="#">New runner</a>}>
        <section class="empty"><h2>Soon here</h2><p>The runners, their last signal and their jobs will show here.</p></section>
      </Shell>
    ),
  },
]

// The Runners screen (REV-10), with the states that the ticket names.
const RUNNERS_OUT = new URL('../../../design/runners/frames/', import.meta.url)
const now = new Date('2026-10-29T10:00:00Z')
const minutes = (n: number) => new Date(now.getTime() - n * 60_000)
const runnersScreen: RunnersScreen = {
  now,
  registrations: [
    { id: '00000000-0000-4000-8000-000000000001', name: 'gpu-runner', labels: ['gpu', 'linux'], trusted: false, expiresAt: new Date(now.getTime() + 42 * 60_000), createdAt: minutes(18) },
    { id: '00000000-0000-4000-8000-000000000002', name: 'poste-camille', labels: ['local'], trusted: true, expiresAt: minutes(95), createdAt: minutes(155) },
  ],
  runners: [
    { id: '00000000-0000-4000-8000-000000000010', name: 'runner-1', labels: ['macos', 'arm64'], version: '0.1.0', trusted: true, orgId: 'org-1', revokedAt: null, lastSeenAt: new Date(now.getTime() - 12_000), createdAt: minutes(3000), currentJob: { kind: 'review', repo: 'sakuga-software/sakuga-review', prNumber: 57, startedAt: minutes(2) }, jobs24h: 14 },
    { id: '00000000-0000-4000-8000-000000000011', name: 'shared-01', labels: ['linux', 'x64'], version: '0.1.0', trusted: true, orgId: null, revokedAt: null, lastSeenAt: new Date(now.getTime() - 25_000), createdAt: minutes(9000), currentJob: null, jobs24h: 31 },
    { id: '00000000-0000-4000-8000-000000000012', name: 'runner-laptop', labels: ['local'], version: '0.0.9', trusted: false, orgId: 'org-1', revokedAt: null, lastSeenAt: minutes(47), createdAt: minutes(6000), currentJob: null, jobs24h: 2 },
    { id: '00000000-0000-4000-8000-000000000013', name: 'gpu-test', labels: ['gpu'], version: '0.1.0', trusted: false, orgId: 'org-1', revokedAt: null, lastSeenAt: minutes(60 * 24 * 4), createdAt: minutes(60 * 24 * 9), currentJob: null, jobs24h: 0 },
    { id: '00000000-0000-4000-8000-000000000014', name: 'old-mac', labels: ['macos'], version: '0.0.8', trusted: false, orgId: 'org-1', revokedAt: minutes(60 * 30), lastSeenAt: minutes(60 * 31), createdAt: minutes(60 * 24 * 20), currentJob: null, jobs24h: 0 },
  ],
}
const kentoUrl = 'https://review.sakuga.dev'
const created = { name: 'runner-2', labels: ['macos', 'arm64'], trusted: true, token: 'kento_reg_EXAMPLE-not-a-real-token-0000000000000', expiresAt: new Date(now.getTime() + 60 * 60_000) }
const runnersFrames: { file: string; node: unknown }[] = [
  { file: 'runners-admin-paper.html', node: <RunnersPage frame={frame('paper', admin, '/runners')} screen={runnersScreen} version="0.1.0" kentoUrl={kentoUrl} /> },
  { file: 'runners-admin-token-sumi.html', node: <RunnersPage frame={frame('sumi', admin, '/runners')} screen={{ ...runnersScreen, registrations: [] }} version="0.1.0" kentoUrl={kentoUrl} created={created} /> },
  { file: 'runners-member-sumi-390.html', node: <RunnersPage frame={frame('sumi', member, '/runners')} screen={runnersScreen} version="0.1.0" kentoUrl={kentoUrl} /> },
  { file: 'runners-admin-paper-390.html', node: <RunnersPage frame={frame('paper', admin, '/runners')} screen={runnersScreen} version="0.1.0" kentoUrl={kentoUrl} notice="revoked" /> },
  {
    file: 'runners-admin-empty-sumi.html',
    node: (
      <RunnersPage
        frame={frame('sumi', admin, '/runners')}
        screen={{ now, registrations: [], runners: [] }}
        version="0.1.0"
        kentoUrl={kentoUrl}
        form={{ values: { name: 'runner 1', labels: 'macos', keyMode: 'app' }, errors: { name: 'Letters, digits, dots, hyphens or underscores, 100 at most.' } }}
      />
    ),
  },
]

// The Repos screen (REV-9): one repository of each mode and each state of the switch.
const REPOS_OUT = new URL('../../../design/repos/frames/', import.meta.url)
const NOW = new Date('2026-10-29T10:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)

function repo(fields: Partial<RepoView> & Pick<RepoView, 'id' | 'fullName'>): RepoView {
  return {
    githubRepoId: 1,
    enabled: false,
    defaultLevel: 'lite',
    private: true,
    defaultBranch: 'main',
    workflow: 'none',
    workflowPath: null,
    workflowRef: null,
    workflowCheckedAt: minutesAgo(4),
    streak: 0,
    lastReview: null,
    confidence: null,
    ...fields,
  }
}

/** The repositories of the board: one of each mode and each state of the switch. */
const REPOS: RepoView[] = [
  repo({
    id: 'r-boo', fullName: 'sakuga-software/boo', private: false, workflow: 'copy', workflowPath: '.github/workflows/sakuga-review.yml',
  }),
  repo({ id: 'r-web-front', fullName: 'sakuga-software/web-front', workflow: null, workflowCheckedAt: null }),
  repo({
    id: 'r-fruitback', fullName: 'sakuga-software/fruitback', private: false, enabled: true, workflow: 'copy',
    workflowPath: '.github/workflows/sakuga-review.yml', streak: 20,
    lastReview: { prNumber: 677, score: 4, model: 'anthropic/claude-haiku-5.5', publishedAt: minutesAgo(38) },
  }),
  repo({
    id: 'r-orchard', fullName: 'sakuga-software/orchard', enabled: true, workflow: 'reusable', workflowRef: 'stable',
    workflowPath: '.github/workflows/sakuga-review.yml', streak: 0,
    lastReview: { prNumber: 12, score: 3, model: 'anthropic/claude-haiku-5.5', publishedAt: minutesAgo(190) },
  }),
  repo({ id: 'r-pantry', fullName: 'sakuga-software/pantry', workflow: 'reusable', workflowRef: 'stable', workflowPath: '.github/workflows/sakuga-review.yml' }),
  repo({
    id: 'r-review', fullName: 'sakuga-software/sakuga-review', enabled: true, defaultLevel: 'lite', streak: 20,
    lastReview: { prNumber: 54, score: 5, model: 'anthropic/claude-haiku-5.5', publishedAt: minutesAgo(12) },
  }),
  repo({
    id: 'r-api', fullName: 'sakuga-software/api', enabled: true, defaultLevel: 'balanced', workflow: 'reusable', workflowRef: 'stable',
    workflowPath: '.github/workflows/sakuga-review.yml', streak: 7,
    lastReview: { prNumber: 1204, score: 4, model: 'anthropic/claude-sonnet-5.5', publishedAt: minutesAgo(2900) },
  }),
  repo({ id: 'r-garden', fullName: 'sakuga-software/garden', workflow: 'none' }),
]

function reposPage(theme: Theme, viewer: Viewer, extra: Partial<ReposPageProps> = {}) {
  return (
    <ReposPage
      frame={frame(theme, viewer, '/repos')}
      page={{
        rows: REPOS,
        counts: {
          all: REPOS.length,
          enabled: REPOS.filter((r) => r.enabled).length,
          disabled: REPOS.filter((r) => !r.enabled).length,
          switching: REPOS.filter((r) => r.workflow === 'reusable' || r.workflow === 'copy').length,
        },
        matching: REPOS.length,
        offset: 0,
        page: 1,
        pages: 1,
        checkedAt: minutesAgo(4),
        unchecked: true,
      }}
      list={{ filter: 'all', search: '', page: 1 }}
      installations={[{ login: 'sakuga-software', url: 'https://github.com/organizations/sakuga-software/settings/installations/1' }]}
      githubUrl="https://github.com"
      checking={false}
      notice={null}
      now={NOW}
      {...extra}
    />
  )
}

const reposFrames: { file: string; node: unknown }[] = [
  { file: 'repos-admin-paper.html', node: reposPage('paper', admin) },
  { file: 'repos-member-sumi.html', node: reposPage('sumi', member) },
  {
    file: 'repos-admin-enabled-paper-390.html',
    node: reposPage('paper', admin, { notice: { kind: 'enabled', fullName: 'sakuga-software/orchard' } }),
  },
  { file: 'repos-member-sumi-390.html', node: reposPage('sumi', member) },
]

// The section "Providers and keys" of the settings (REV-11): a valid provider, a refused key with its
// banner, a provider held by the runner, a server without prices, and the form.
const PROVIDERS_OUT = new URL('../../../design/providers/frames/', import.meta.url)
function provider(fields: Partial<ProviderView> & Pick<ProviderView, 'id' | 'label' | 'kind'>): ProviderView {
  return {
    orgId: 'org-1', baseUrl: null, keyLast4: null, keySetAt: null, runnerHeld: false, isDefault: false, models: {},
    lastOkAt: null, refusedAt: null, refusedStatus: null, refusedMessage: null, createdAt: minutes(60 * 24 * 3), ...fields,
  }
}
const ORG_PROVIDERS: ProviderView[] = [
  provider({ id: '00000000-0000-4000-8000-000000000020', label: 'Anthropic of Sakuga', kind: 'anthropic', keyLast4: 'Q7xA', keySetAt: minutes(60 * 24 * 3), isDefault: true, lastOkAt: minutes(4) }),
  provider({
    id: '00000000-0000-4000-8000-000000000021', label: 'OpenRouter (old key)', kind: 'openrouter', keyLast4: '9f2c', keySetAt: minutes(60 * 24 * 40),
    refusedAt: new Date('2026-10-29T08:40:00Z'), refusedStatus: 401, refusedMessage: '401 User not found.',
  }),
  provider({ id: '00000000-0000-4000-8000-000000000022', label: 'Office GPU', kind: 'ollama', runnerHeld: true, baseUrl: 'http://gpu.lan:11434', models: { lite: ['qwen3:32b'], balanced: ['qwen3:32b'], heavy: ['qwen3:235b'] } }),
  provider({ id: '00000000-0000-4000-8000-000000000023', label: 'vLLM interne', kind: 'openai_compatible', keyLast4: 'b81e', keySetAt: minutes(300), baseUrl: 'https://llm.example.com/v1', models: { lite: ['qwen3-coder'], balanced: ['qwen3-coder'], heavy: ['deepseek-v4'] } }),
]
function settingsPage(theme: Theme, viewer: Viewer, extra: Partial<SettingsPageProps> = {}) {
  return <SettingsPage frame={frame(theme, viewer, '/settings')} providers={ORG_PROVIDERS} now={now} secretsConfigured serviceKey {...extra} />
}
const providersFrames: { file: string; node: unknown }[] = [
  { file: 'providers-admin-paper.html', node: settingsPage('paper', admin) },
  { file: 'providers-admin-sumi-390.html', node: settingsPage('sumi', admin, { notice: { kind: 'tested_ok' } }) },
  { file: 'providers-member-paper-390.html', node: settingsPage('paper', member) },
  {
    file: 'providers-admin-empty-sumi.html',
    node: settingsPage('sumi', admin, {
      providers: [],
      secretsConfigured: false,
      form: {
        values: { kind: 'openai_compatible', label: 'vLLM', baseUrl: 'http://llm.lan/v1', runnerHeld: false, models: { lite: '', balanced: '', heavy: '' } },
        errors: { baseUrl: 'A URL with https://. The key goes in a header.', models: 'OpenAI-compatible has no default model. Name at least one model for each level.' },
      },
    }),
  },
]

// REV-12: the Config screen of orchard.
const CONFIG_OUT = new URL('../../../design/config/frames/', import.meta.url)
const ORCHARD_CONFIG: RepoConfigView = {
  id: 'r-orchard',
  fullName: 'sakuga-software/orchard',
  enabled: true,
  defaultLevel: 'lite',
  config: {
    models: { balanced: { provider: 'service', model: 'anthropic/claude-sonnet-5.6', fallback: 'anthropic/claude-sonnet-5.5' } },
    trigger: 'ready',
    paths: ['apps/web', '**/*.sql'],
    monthlyCapUsd: 25,
  },
  orgConfig: {},
  version: 7,
  updatedBy: 'octocat',
  updatedAt: new Date('2026-10-27T17:02:00Z'),
  spentThisMonthUsd: 3.42,
  trustedBots: ['sakuga-agent[bot]', 'renovate[bot]'],
}
const PROVIDERS = await serviceProviders.list('org-1')

function configPage(theme: Theme, viewer: Viewer, extra: Partial<ConfigPageProps> = {}) {
  return (
    <ConfigPage
      frame={frame(theme, viewer, '/repos/r-orchard/config')}
      view={ORCHARD_CONFIG}
      providers={PROVIDERS}
      tab="models"
      notice={null}
      form={null}
      {...extra}
    />
  )
}

const configFrames: { file: string; node: unknown }[] = [
  { file: 'config-models-admin-paper.html', node: configPage('paper', admin) },
  { file: 'config-trigger-admin-sumi.html', node: configPage('sumi', admin, { tab: 'trigger' }) },
  { file: 'config-levels-admin-paper.html', node: configPage('paper', admin, { tab: 'levels', notice: { kind: 'saved', version: 8 } }) },
  {
    file: 'config-conflict-admin-sumi.html',
    node: configPage('sumi', admin, {
      notice: { kind: 'conflict', version: 8, updatedBy: 'camille', updatedAt: new Date('2026-10-27T17:05:00Z') },
      form: { field: 'models.heavy', values: { provider: 'service', model: 'claude opus', fallback: '' }, errors: { model: 'A model id: letters, digits and ". _ : / @ -", 200 characters at most.' } },
    }),
  },
  { file: 'config-models-admin-paper-390.html', node: configPage('paper', admin) },
  { file: 'config-trigger-member-sumi-390.html', node: configPage('sumi', member, { tab: 'trigger' }) },
]

// The dashboard (REV-14): a failure with its retry, a busy week, the queue and the runners.
const DASHBOARD_OUT = new URL('../../../design/dashboard/frames/', import.meta.url)
const D_NOW = new Date('2026-10-29T10:00:00Z')
const dAgo = (seconds: number) => new Date(D_NOW.getTime() - seconds * 1000)
const DASHBOARD: DashboardScreen = {
  now: D_NOW,
  banner: {
    id: '00000000-0000-4000-8000-000000000101',
    repoId: 'r-orchard',
    repo: 'sakuga-software/orchard',
    prNumber: 128,
    kind: 'review',
    level: 'lite',
    attempts: 2,
    reason: 'lease expired 2 times',
    runnerName: 'shared-01',
    finishedAt: dAgo(240),
    previous: { score: 3, publishedAt: new Date('2026-10-29T08:12:00Z') },
    retry: null,
    estimates: { lite: 0.004, balanced: 0.118, heavy: 0.36 },
  },
  failures: [
    { id: 'f1', repoId: 'r-orchard', repo: 'sakuga-software/orchard', prNumber: 128, kind: 'review', level: 'lite', attempts: 2, reason: 'lease expired 2 times', runnerName: 'shared-01', finishedAt: dAgo(240) },
    { id: 'f2', repoId: 'r-fruitback', repo: 'sakuga-software/fruitback', prNumber: 676, kind: 'review', level: 'balanced', attempts: 1, reason: 'the provider "Anthropic" refused its key (401): invalid x-api-key', runnerName: 'runner-1', finishedAt: dAgo(60 * 60 * 26) },
    { id: 'f3', repoId: 'r-dojo', repo: 'sakuga-software/dojo', prNumber: 702, kind: 'resolve', level: 'lite', attempts: 1, reason: 'clone failed: repository not found', runnerName: 'runner-1', finishedAt: dAgo(60 * 60 * 50) },
  ],
  week: [
    { day: '2026-10-23', published: { lite: 9, balanced: 1, heavy: 0 }, failed: 0, meanDurationMs: 84_000 },
    { day: '2026-10-24', published: { lite: 4, balanced: 0, heavy: 0 }, failed: 0, meanDurationMs: 71_000 },
    { day: '2026-10-25', published: { lite: 1, balanced: 0, heavy: 0 }, failed: 0, meanDurationMs: 66_000 },
    { day: '2026-10-26', published: { lite: 12, balanced: 2, heavy: 1 }, failed: 1, meanDurationMs: 112_000 },
    { day: '2026-10-27', published: { lite: 18, balanced: 3, heavy: 1 }, failed: 0, meanDurationMs: 98_000 },
    { day: '2026-10-28', published: { lite: 22, balanced: 4, heavy: 2 }, failed: 2, meanDurationMs: 104_000 },
    { day: '2026-10-29', published: { lite: 7, balanced: 1, heavy: 0 }, failed: 1, meanDurationMs: 91_000 },
  ],
  recent: [
    { id: 'r1', repoId: 'r-sakuga-review', repo: 'sakuga-software/sakuga-review', prNumber: 64, level: 'lite', verdict: 'APPROVE', score: 4, findings: 1, costUsd: 0.0042, durationMs: 74_000, createdAt: dAgo(180), publishedAt: dAgo(170) },
    { id: 'r2', repoId: 'r-orchard', repo: 'sakuga-software/orchard', prNumber: 127, level: 'balanced', verdict: 'REQUEST_CHANGES', score: 2, findings: 6, costUsd: 0.131, durationMs: 188_000, createdAt: dAgo(1500), publishedAt: dAgo(1490) },
    { id: 'r3', repoId: 'r-fruitback', repo: 'sakuga-software/fruitback', prNumber: 675, level: 'lite', verdict: 'COMMENT', score: 3, findings: 3, costUsd: 0.0051, durationMs: 81_000, createdAt: dAgo(3600), publishedAt: dAgo(3590) },
    { id: 'r4', repoId: 'r-dojo', repo: 'sakuga-software/dojo', prNumber: 701, level: 'heavy', verdict: 'APPROVE', score: 5, findings: 0, costUsd: 0.362, durationMs: 296_000, createdAt: dAgo(7200), publishedAt: null },
  ],
  costs: {
    dayUsd: 4.12,
    monthUsd: 61.4,
    dayByProvider: [
      { providerId: 'p1', label: 'Anthropic (team)', usd: 3.6 },
      { providerId: null, label: 'Service key', usd: 0.52 },
    ],
    monthByProvider: [
      { providerId: 'p1', label: 'Anthropic (team)', usd: 48.9 },
      { providerId: null, label: 'Service key', usd: 12.5 },
      { providerId: 'p2', label: 'Office Ollama', usd: 0 },
    ],
    monthUnknown: 3,
  },
  caps: { dailyCapUsd: 5, monthlyCapUsd: 150, alertPct: 80 },
  queue: {
    running: [
      { id: 'j1', repo: 'sakuga-software/fruitback', prNumber: 677, kind: 'review', level: 'balanced', attempts: 1, createdAt: dAgo(140), startedAt: dAgo(95), leaseExpiresAt: new Date(D_NOW.getTime() + 85_000), notBefore: null, runnerName: 'runner-1', runnerSeenAt: dAgo(4) },
      { id: 'j2', repo: 'sakuga-software/orchard', prNumber: 129, kind: 'resolve', level: 'lite', attempts: 2, createdAt: dAgo(400), startedAt: dAgo(30), leaseExpiresAt: new Date(D_NOW.getTime() + 150_000), notBefore: null, runnerName: 'shared-01', runnerSeenAt: dAgo(9) },
    ],
    queued: [
      { id: 'j3', repo: 'sakuga-software/dojo', prNumber: 703, kind: 'review', level: 'lite', attempts: 0, createdAt: dAgo(20), startedAt: null, leaseExpiresAt: null, notBefore: null, runnerName: null, runnerSeenAt: null },
      { id: 'j4', repo: 'sakuga-software/pantry', prNumber: 88, kind: 'review', level: 'lite', attempts: 1, createdAt: dAgo(300), startedAt: null, leaseExpiresAt: null, notBefore: new Date(D_NOW.getTime() + 45_000), runnerName: null, runnerSeenAt: null },
    ],
    runningCount: 2,
    queuedCount: 2,
  },
  runners: [
    { id: 'u1', name: 'runner-1', orgId: 'org-1', lastSeenAt: dAgo(4), running: 1 },
    { id: 'u2', name: 'shared-01', orgId: null, lastSeenAt: dAgo(9), running: 1 },
    { id: 'u3', name: 'runner-laptop', orgId: 'org-1', lastSeenAt: dAgo(60 * 47), running: 0 },
  ],
  runnerCounts: { online: 2, late: 0, offline: 1 },
  stall: null,
  workflowRepos: ['sakuga-software/fruitback', 'sakuga-software/orchard'],
  setup: { published: true, suspended: false, enabledRepos: 4, providers: 1, serviceRunners: 1, pendingRegistrations: 0 },
}
const EMPTY_DASHBOARD: DashboardScreen = {
  now: D_NOW,
  banner: null,
  failures: [],
  week: DASHBOARD.week.map((day) => ({ ...day, published: { lite: 0, balanced: 0, heavy: 0 }, failed: 0, meanDurationMs: null })),
  recent: [],
  costs: { dayUsd: 0, monthUsd: 0, dayByProvider: [], monthByProvider: [], monthUnknown: 0 },
  caps: { dailyCapUsd: null, monthlyCapUsd: null, alertPct: 80 },
  queue: { running: [], queued: [], runningCount: 0, queuedCount: 0 },
  runners: [],
  runnerCounts: { online: 0, late: 0, offline: 0 },
  stall: null,
  workflowRepos: [],
  // REV-26: a new org, with the list "Getting started".
  setup: { published: false, suspended: false, enabledRepos: 0, providers: 0, serviceRunners: 1, pendingRegistrations: 0 },
}

function dashboardPage(theme: Theme, viewer: Viewer, screen: DashboardScreen = DASHBOARD, extra: Partial<DashboardPageProps> = {}) {
  return <DashboardPage frame={frame(theme, viewer, '/')} screen={screen} githubUrl="https://github.com" {...extra} />
}

const dashboardFrames: { file: string; node: unknown }[] = [
  { file: 'dashboard-admin-paper.html', node: dashboardPage('paper', admin) },
  {
    file: 'dashboard-admin-retried-sumi.html',
    node: dashboardPage('sumi', admin, { ...DASHBOARD, banner: { ...DASHBOARD.banner!, retry: { id: 'j5', level: 'balanced', state: 'queued' } } }, { notice: 'retried' }),
  },
  { file: 'dashboard-member-paper-390.html', node: dashboardPage('paper', member) },
  { file: 'dashboard-admin-sumi-390.html', node: dashboardPage('sumi', admin) },
  { file: 'dashboard-admin-empty-paper.html', node: dashboardPage('paper', admin, EMPTY_DASHBOARD) },
]

// REV-13: the settings of the org, above "Providers and keys".
const ORG_OUT = new URL('../../../design/org-settings/frames/', import.meta.url)
const ORG_VIEW: OrgSettingsView = {
  login: 'sakuga-software',
  githubInstallationId: 58213490,
  suspendedAt: null,
  caps: { dailyCapUsd: 8, monthlyCapUsd: 150, alertPct: 80 },
  trustedBots: ['sakuga-agent[bot]', 'renovate[bot]'],
  config: { level: 'lite', models: { balanced: { provider: '00000000-0000-4000-8000-000000000020', model: 'claude-sonnet-5-5', fallback: 'claude-haiku-5-5' } } },
  version: 3,
  updatedBy: 'octocat',
  updatedAt: new Date('2026-10-29T13:02:00Z'),
  repos: { total: 14, enabled: 3 },
  costs: {
    dayUsd: 6.71,
    monthUsd: 84.2,
    dayByProvider: [
      { providerId: '00000000-0000-4000-8000-000000000020', label: 'Anthropic of Sakuga', usd: 5.94 },
      { providerId: null, label: 'Service key', usd: 0.77 },
    ],
  },
  deliveries: {
    last: { deliveryId: 'd-1', event: 'pull_request', action: 'synchronize', status: 202, outcome: 'queued', reason: null, receivedAt: minutes(2) },
    lastPullRequest: { deliveryId: 'd-1', event: 'pull_request', action: 'synchronize', status: 202, outcome: 'queued', reason: null, receivedAt: minutes(2) },
    failures24h: 1,
    total24h: 63,
    lastFailure: { deliveryId: 'd-0', event: 'issue_comment', action: 'created', status: 500, outcome: 'failed', reason: 'connection terminated unexpectedly', receivedAt: minutes(190) },
  },
}
const APP_STATUS: AppStatus = {
  slug: 'kento-review',
  name: 'Kentō Review',
  htmlUrl: 'https://github.com/apps/kento-review',
  deliveriesUrl: 'https://github.com/organizations/sakuga-software/settings/apps/kento-review/advanced',
  webhook: { url: 'https://review.sakuga.dev/webhooks/github', sslVerified: true },
  installation: {
    permissions: { contents: 'read', pull_requests: 'write', issues: 'write', checks: 'write', members: 'read', metadata: 'read' },
    events: ['pull_request', 'issue_comment'],
    repositorySelection: 'all',
    suspendedAt: null,
    htmlUrl: 'https://github.com/organizations/sakuga-software/settings/installations/58213490',
  },
}
const ORG_PROVIDER_OPTIONS = [
  ...PROVIDERS,
  { id: '00000000-0000-4000-8000-000000000020', kind: 'anthropic' as const, label: 'Anthropic of Sakuga', hint: 'Valid · key of the service, encrypted', isDefault: true, keyFrom: 'key encrypted by the service', serviceHoldsKey: true, models: {} },
]
function orgSection(extra: Partial<OrgSectionProps> = {}): OrgSectionProps {
  return {
    view: ORG_VIEW,
    app: { ok: true, status: APP_STATUS },
    providers: ORG_PROVIDER_OPTIONS,
    webhookUrl: 'https://review.sakuga.dev/webhooks/github',
    webhookSecret: true,
    version: '0.1.0',
    commit: '3f22010a9c',
    now,
    notice: null,
    form: null,
    ...extra,
  }
}
function orgPage(theme: Theme, viewer: Viewer, extra: Partial<OrgSectionProps> = {}, providers: ProviderView[] | null = ORG_PROVIDERS.slice(0, 1)) {
  return <SettingsPage frame={frame(theme, viewer, '/settings')} providers={providers} org={orgSection(extra)} now={now} secretsConfigured serviceKey />
}
const REACHED: OrgSettingsView = { ...ORG_VIEW, costs: { ...ORG_VIEW.costs, dayUsd: 8.03 } }
const orgFrames: { file: string; node: unknown }[] = [
  { file: 'org-admin-paper.html', node: orgPage('paper', admin, { notice: { kind: 'saved', version: 3 } }) },
  { file: 'org-reached-admin-sumi.html', node: orgPage('sumi', admin, { view: REACHED }) },
  {
    file: 'org-errors-admin-paper.html',
    node: orgPage('paper', admin, {
      form: { field: 'trustedBots', values: { trustedBots: 'renovate[bot]\ngithub.com/renovate' }, errors: { trustedBots: '"github.com/renovate[bot]" is not the login of a bot. A bot login is the name of a GitHub App followed by [bot], for example renovate[bot].' } },
      app: {
        ok: true,
        status: {
          ...APP_STATUS,
          webhook: { url: 'https://kento.example.dev/webhooks/github', sslVerified: true },
          installation: { ...APP_STATUS.installation, permissions: { ...APP_STATUS.installation.permissions, checks: 'read' }, events: ['pull_request'] },
        },
      },
    }),
  },
  { file: 'org-member-paper-390.html', node: orgPage('paper', member) },
  { file: 'org-admin-sumi-390.html', node: orgPage('sumi', admin) },
  { file: 'org-noapp-admin-paper.html', node: orgPage('paper', admin, { app: { ok: false, error: 'GET /app answered 401: A JSON web token could not be decoded' } }, null) },
]

async function writeFrames(out: URL, assets: string, list: { file: string; node: unknown }[], label: string) {
  await mkdir(out, { recursive: true })
  for (let { file, node } of list) {
    let html = await renderToString(node as Parameters<typeof renderToString>[0])
    html = html.replaceAll('"/assets/', `"${assets}`).replace(/\?v=board/g, '')
    await writeFile(new URL(file, out), `<!DOCTYPE html>\n${html}\n`)
    console.log(`${label}${file}`)
  }
}

await writeFrames(OUT, ASSETS, frames, 'design/socle/frames/')
await writeFrames(RUNNERS_OUT, ASSETS, runnersFrames, 'design/runners/frames/')
await writeFrames(REPOS_OUT, ASSETS, reposFrames, 'design/repos/frames/')
await writeFrames(PROVIDERS_OUT, ASSETS, providersFrames, 'design/providers/frames/')
await writeFrames(CONFIG_OUT, ASSETS, configFrames, 'design/config/frames/')
await writeFrames(DASHBOARD_OUT, ASSETS, dashboardFrames, 'design/dashboard/frames/')
await writeFrames(ORG_OUT, ASSETS, orgFrames, 'design/org-settings/frames/')
