// REV-48. What the controllers of the screens need from the server: one interface per screen.
import type { OAuthProvider } from 'remix/auth'
import type { SessionStorage } from 'remix/session'

import type { GitHubProfile, LookupRole } from '../../auth/github.ts'
import type { AuthStore } from '../../auth/store.ts'
import type { ReadPullRequest } from '../../dashboard/github.ts'
import type { DashboardStore } from '../../dashboard/store.ts'
import type { BulkStatus, StatusOutcome } from '../../findings/dismiss.ts'
import type { FindingsScreenStore } from '../../findings/screen.ts'
import type { ReadAppStatus } from '../../org-settings/app-status.ts'
import type { OrgSettingsStore } from '../../org-settings/store.ts'
import type { Probe } from '../../providers/probe.ts'
import type { ProvidersStore } from '../../providers/store.ts'
import type { ProviderCatalog } from '../../repo-config/providers.ts'
import type { RepoConfigStore } from '../../repo-config/store.ts'
import type { RepoCheck } from '../../repos/check.ts'
import type { ReposStore } from '../../repos/store.ts'
import type { AssignmentStore } from '../../assignment/store.ts'
import type { RulesStore } from '../../rules/store.ts'
import type { RunnersAdminStore } from '../../runner/admin.ts'

/** The GitHub sign-in and the sessions. Null: nobody can sign in, and every screen says so. */
export interface AuthDependencies {
  /** The origin of the service as the browser sees it. Traefik ends TLS, so the request URL is http. */
  publicUrl: URL
  sessionSecrets: string[]
  sessionStorage: SessionStorage
  provider: OAuthProvider<GitHubProfile, 'github'>
  store: AuthStore
  lookupRole: LookupRole
  now?: () => number
  /** REV-32. The page of GitHub that installs the App on an org, for « Accès refusé ». */
  installUrl?: string | null
}

/** The Repos screen (REV-9). Null: the screen shows its empty frame. */
export interface ReposDependencies {
  store: ReposStore
  /** Reads the repositories on GitHub. Null without the GitHub App. */
  check: RepoCheck | null
  /** `https://github.com`, or the GitHub Enterprise Server. */
  githubUrl: string
}

/** The Findings screen (REV-18). Null: the screen shows its empty frame. */
export interface FindingsDependencies {
  store: FindingsScreenStore
  /**
   * REV-18. Sets findings dismissed or wontfix, and replies in their threads. Null: the screen only
   * reads (a test of the routes without a database).
   */
  setStatus?: ((input: { orgId: string; ids: string[]; status: BulkStatus; reason: string | null; actor: string }) => Promise<StatusOutcome>) | null
  /** `https://github.com`, or the GitHub Enterprise Server: the links to the pull requests. */
  githubUrl: string
}

/** The dashboard (REV-14). Null: it shows its empty frame. */
export interface DashboardDependencies {
  store: DashboardStore
  /** `https://github.com`, or the GitHub Enterprise Server: the links to the pull requests. */
  githubUrl: string
  /** Reads the head of a pull request before a retry. Null without the GitHub App: the jobs of the database decide alone. */
  readPullRequest: ReadPullRequest | null
  /** KENTO_PROVIDER_API_KEY is set: the list « Mise en route » counts it as a provider (REV-26). */
  serviceKey?: boolean
}

/** The section « Providers et clés » of the settings (REV-11). */
export interface ProvidersDependencies {
  store: ProvidersStore
  /** « Tester »: one call to the provider with its key. */
  probe: Probe
  /** KENTO_SECRETS_KEY is set. */
  secretsConfigured: boolean
  /** KENTO_PROVIDER_API_KEY is set. */
  serviceKey: boolean
}

/** The Config screen of a repository (REV-12). Null: the screen answers 404. */
export interface RepoConfigDependencies {
  store: RepoConfigStore
  /** The providers that an org can choose for a level. */
  providers: ProviderCatalog
}

/** The settings of the org (REV-13): limits, defaults, trusted bots, state of the App. */
export interface OrgSettingsDependencies {
  store: OrgSettingsStore
  /** The providers that a default level can use: the catalog of the Config screen. */
  providers: ProviderCatalog
  /** Reads the App on GitHub. Null without the GitHub App. */
  readAppStatus: ReadAppStatus | null
  /** `<public URL>/webhooks/github`, or null without the public URL. */
  webhookUrl: string | null
  /** GITHUB_WEBHOOK_SECRET is set. */
  webhookSecret: boolean
}

export interface UiDependencies {
  version: string
  /** The commit of the image, when the build gives it: it versions the URLs of the assets. */
  commit: string | null
  auth: AuthDependencies | null
  repos?: ReposDependencies | null
  /** REV-18. The Findings screen. Null: it shows its empty frame. */
  findings?: FindingsDependencies | null
  /** The Runners screen (REV-10). Null: it shows its empty frame. */
  runners?: RunnersAdminStore | null
  /** The providers of the settings (REV-11). Null: the settings show their empty frame. */
  providers?: ProvidersDependencies | null
  repoConfig?: RepoConfigDependencies | null
  dashboard?: DashboardDependencies | null
  orgSettings?: OrgSettingsDependencies | null
  /** REV-19. The rules of the repositories and of the org. Null: the tab Règles says « Bientôt ». */
  rules?: RulesStore | null
  /** REV-21. The assignment rules of the repositories. Null: the tab Assignation says « Bientôt ». */
  assignment?: AssignmentStore | null
}
