import type { Handle } from 'remix/component'
import { renderToString } from 'remix/component/server'
import { completeAuth, finishExternalAuth, startExternalAuth, type OAuthProvider } from 'remix/auth'
import { createCookie } from 'remix/cookie'
import { cop } from 'remix/middleware/cop'
import { csrf, getCsrfToken } from 'remix/middleware/csrf'
import { formData } from 'remix/middleware/form-data'
import { session as sessionMiddleware } from 'remix/middleware/session'
import { createContextKey, createController, type Middleware } from 'remix/router'
import { Session, type SessionStorage } from 'remix/session'

import { currentMemberships, decideSignIn, saveSignInRoles } from '../auth/access.ts'
import type { GitHubProfile, LookupRole } from '../auth/github.ts'
import { readSessionAuth, SESSION_TTL_MS } from '../auth/session-storage.ts'
import type { AuthStore, MembershipRow, UserRow } from '../auth/store.ts'
import { errorMessage, log } from '../log.ts'
import { authRoutes, pageRoutes } from '../routes.ts'
import { readKeyForm, readProviderForm } from '../providers/form.ts'
import type { Probe } from '../providers/probe.ts'
import { SecretsError } from '../providers/secrets.ts'
import type { ProvidersStore } from '../providers/store.ts'
import {
  CONFIG_FIELDS,
  readCapForm,
  readLevelForm,
  readModelsForm,
  readPathsForm,
  readTriggerForm,
  withoutField,
  hasField,
  type ConfigField,
  type ConfigOverrides,
} from '../repo-config/model.ts'
import type { ProviderCatalog } from '../repo-config/providers.ts'
import type { ReadAppStatus } from '../org-settings/app-status.ts'
import { readCapsForm, readTrustedBotsForm } from '../org-settings/model.ts'
import type { OrgSaveOutcome, OrgSettingsStore, OrgSettingsValues } from '../org-settings/store.ts'
import type { RepoConfigStore, SaveOutcome } from '../repo-config/store.ts'
import type { RepoCheck } from '../repos/check.ts'
import type { ReposStore } from '../repos/store.ts'
import type { RunnersAdminStore } from '../runner/admin.ts'
import { hashToken, newRegistrationToken } from '../runner/tokens.ts'
import type { ReadPullRequest } from '../dashboard/github.ts'
import type { DashboardStore, RetryOutcome } from '../dashboard/store.ts'
import { DASHBOARD_NOTICES, DashboardPage, type DashboardNotice } from './dashboard.tsx'
import { ConfigPage, isConfigTab, tabOf, type ConfigForm, type ConfigNotice, type ConfigTab } from './config.tsx'
import { ReposPage, type ReposNotice } from './repos.tsx'
import { readRegistrationForm, RUNNER_NOTICES, RunnersPage, type RunnerNotice, type RunnersPageProps } from './runners.tsx'
import { securityHeaders } from './security-headers.ts'
import { anchorOf, ORG_FIELDS, ORG_RESET_FIELDS, type OrgField, type OrgForm, type OrgNotice, type OrgSectionProps } from './org-settings.tsx'
import { PROVIDER_NOTICES, SettingsPage, type ProviderNotice, type SettingsPageProps } from './settings.tsx'
import { Shell, type PageFrame, type Section, type Viewer } from './shell.tsx'
import { SignInPage, type SignInNotice } from './sign-in.tsx'
import { isTheme, readTheme, themeCookie, type Theme } from './theme.ts'

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
}

/** The Repos screen (REV-9). Null: the screen shows its empty frame. */
export interface ReposDependencies {
  store: ReposStore
  /** Reads the repositories on GitHub. Null without the GitHub App. */
  check: RepoCheck | null
  /** `https://github.com`, or the GitHub Enterprise Server. */
  githubUrl: string
}

/** The dashboard (REV-14). Null: it shows its empty frame. */
export interface DashboardDependencies {
  store: DashboardStore
  /** `https://github.com`, or the GitHub Enterprise Server: the links to the pull requests. */
  githubUrl: string
  /** Reads the head of a pull request before a retry. Null without the GitHub App: the jobs of the database decide alone. */
  readPullRequest: ReadPullRequest | null
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
  /** The Runners screen (REV-10). Null: it shows its empty frame. */
  runners?: RunnersAdminStore | null
  /** The providers of the settings (REV-11). Null: the settings show their empty frame. */
  providers?: ProvidersDependencies | null
  repoConfig?: RepoConfigDependencies | null
  dashboard?: DashboardDependencies | null
  orgSettings?: OrgSettingsDependencies | null
}

interface SignedIn {
  user: UserRow
  membership: MembershipRow
  memberships: MembershipRow[]
}

/** The signed-in person on the screen, set by `requireViewer`. */
const Signed = createContextKey<SignedIn>()

const NOTICES: readonly SignInNotice[] = ['not_member', 'failed', 'signed_out', 'expired', 'disabled']

/**
 * The screens of milestone M3. Each one is a frame with an empty state until its own ticket fills
 * it: REV-14 the dashboard, REV-9 the repos, REV-18 the findings, REV-10 the runners, REV-13 the
 * settings of the org.
 */
const PLACEHOLDERS: Record<Section, { title: string; lead: string; empty: string }> = {
  dashboard: {
    title: 'Tableau de bord',
    lead: 'Ce qui tourne, ce qui a échoué, et ce que ça coûte.',
    empty: 'Les dernières reviews, la file de jobs, le coût du jour et les runners s’afficheront ici.',
  },
  repos: {
    title: 'Repos',
    lead: 'Les repos de l’installation, et où en est chacun dans sa bascule.',
    empty: 'La liste des repos, leur mode et leur compteur de bascule s’afficheront ici.',
  },
  findings: {
    title: 'Findings',
    lead: 'Chaque finding, et la précision des reviews.',
    empty: 'Les findings filtrables et la précision par repo s’afficheront ici.',
  },
  runners: {
    title: 'Runners',
    lead: 'Les machines qui font les reviews.',
    empty: 'Les runners, leur dernier signal et leurs jobs s’afficheront ici.',
  },
  settings: {
    title: 'Réglages',
    lead: 'Ce qui vaut pour toute l’organisation.',
    empty: 'Le plafond de coût, les valeurs par défaut, les providers et l’état de l’App s’afficheront ici.',
  },
}

/** The session of a request; the session middleware runs before every action that calls it. */
function sessionOf(context: { get(key: typeof Session): Session | undefined }): Session {
  let session = context.get(Session)
  if (!session) throw new Error('the session middleware did not run')
  return session
}

/** The signed-in person of a request; `requireViewer` runs before every action that calls it. */
function signedOf(context: { get(key: typeof Signed): SignedIn | undefined }): SignedIn {
  let signed = context.get(Signed)
  if (!signed) throw new Error('requireViewer did not run')
  return signed
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The page of the installation of the App on GitHub, where an owner picks the repositories it sees. */
export function installationUrl(githubUrl: string, org: { login: string; githubInstallationId: number }): string {
  return `${githubUrl}/organizations/${encodeURIComponent(org.login)}/settings/installations/${org.githubInstallationId}`
}

function forbidden() {
  return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

function redirect(location: string) {
  return new Response(null, { status: 303, headers: { Location: location } })
}

/** The controllers of the screens (`pageRoutes`) and of the sign-in (`authRoutes`). */
export function createUiControllers(deps: UiDependencies) {
  let assetVersion = deps.commit ?? deps.version
  let auth = deps.auth
  let now = auth?.now ?? Date.now
  let secure = auth?.publicUrl.protocol === 'https:'

  // cop() refuses a cross-site POST from what the browser says (Sec-Fetch-Site, Origin); csrf()
  // wants the token of the session in each form, and an Origin that is the public URL. The session
  // cookie is signed, HttpOnly, SameSite=Lax (the callback from GitHub is a top-level GET from
  // another site, and must carry it), and `__Host-` over HTTPS (no Domain, Path=/, Secure).
  let sessionLayer: Middleware<any>[] = auth
    ? [
        cop({ trustedOrigins: [auth.publicUrl.origin] }),
        sessionMiddleware(
          createCookie(secure ? '__Host-kento_session' : 'kento_session', {
            secrets: auth.sessionSecrets,
            httpOnly: true,
            secure,
            sameSite: 'lax',
            path: '/',
            maxAge: SESSION_TTL_MS / 1000,
          }),
          auth.sessionStorage,
        ),
        formData(),
        csrf({ origin: auth.publicUrl.origin }),
      ]
    : []

  function toSignIn(path: string, notice?: SignInNotice) {
    let query = new URLSearchParams()
    if (notice) query.set('notice', notice)
    if (path !== '/') query.set('returnTo', path)
    let search = query.toString()
    return redirect(`${authRoutes.signIn.href()}${search ? `?${search}` : ''}`)
  }

  /**
   * Every screen needs a signed-in member of an org. The role comes from GitHub again when it is
   * older than ten minutes: a person removed from the org on GitHub loses the access.
   */
  let requireViewer: Middleware = async (context, next) => {
    let path = `${context.url.pathname}${context.url.search}`
    let isGet = context.request.method === 'GET' || context.request.method === 'HEAD'
    if (!auth) return isGet ? toSignIn(path) : new Response('Unauthorized', { status: 401 })
    let session = sessionOf(context)
    let record = readSessionAuth(session)
    if (!record || record.signedInAt + SESSION_TTL_MS <= now()) {
      if (record) session.destroy()
      return isGet ? toSignIn(path, record ? 'expired' : undefined) : new Response('Unauthorized', { status: 401 })
    }
    let user = await auth.store.findUser(record.userId)
    let { memberships, unconfirmed } = user
      ? await currentMemberships(auth.store, auth.lookupRole, user, now())
      : { memberships: [], unconfirmed: 0 }
    if (user && memberships.length === 0 && unconfirmed > 0) {
      // GitHub has not answered for over an hour: no access, but no sign-out either. The session
      // works again as soon as GitHub confirms the role.
      log('warn', 'auth.role_unconfirmed', { login: user.login, orgs: unconfirmed })
      let html = await renderToString(
        <SignInPage
          theme={readTheme(context.headers.get('Cookie'))}
          version={deps.version}
          assetVersion={assetVersion}
          signInHref={null}
          notice="unavailable"
        />,
      )
      return new Response(`<!DOCTYPE html>${html}`, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '60' },
      })
    }
    if (!user || memberships.length === 0) {
      session.destroy()
      return isGet ? toSignIn(path, 'expired') : new Response('Unauthorized', { status: 401 })
    }
    let orgId = session.get('orgId')
    let membership = memberships.find((m) => m.org.id === orgId)
    if (!membership) {
      // The org of the session is gone (left on GitHub, or suspended): the session moves to the
      // first org that remains, and stays there, so the org on screen and the role match.
      membership = memberships[0]!
      session.set('orgId', membership.org.id)
    }
    context.set(Signed, { user, membership, memberships })
    return next()
  }

  function frame(signed: SignedIn, context: { headers: Headers; url: URL }, csrfToken: string): PageFrame {
    let viewer: Viewer = {
      login: signed.user.login,
      name: signed.user.name,
      avatarUrl: signed.user.avatarUrl,
      role: signed.membership.role,
      org: { id: signed.membership.org.id, login: signed.membership.org.login },
      orgs: signed.memberships.map((m) => ({ id: m.org.id, login: m.org.login })),
    }
    return {
      theme: readTheme(context.headers.get('Cookie')),
      version: deps.version,
      assetVersion,
      viewer,
      csrfToken,
      path: `${context.url.pathname}${context.url.search}`,
    }
  }

  async function renderRunners(
    context: { render(node: any, init?: ResponseInit): Response },
    signed: SignedIn,
    page: PageFrame,
    extra: Pick<RunnersPageProps, 'created' | 'form' | 'notice'>,
    status = 200,
  ) {
    let screen = await deps.runners!.screen(signed.membership.org.id)
    return context.render(
      <RunnersPage frame={page} screen={screen} version={deps.version} kentoUrl={auth!.publicUrl.origin} {...extra} />,
      { status },
    )
  }

  async function renderSettings(
    context: { render(node: any, init?: ResponseInit): Response },
    signed: SignedIn,
    page: PageFrame,
    extra: Pick<SettingsPageProps, 'notice' | 'form' | 'keyError'> & { orgNotice?: OrgNotice | null; orgForm?: OrgForm | null },
    status = 200,
  ) {
    let providers = deps.providers
    let orgId = signed.membership.org.id
    let list = providers ? await providers.store.list(orgId) : null
    let org: OrgSectionProps | null = null
    let settings = deps.orgSettings
    let view = settings ? await settings.store.read(orgId) : null
    if (settings && view) {
      org = {
        view,
        app: settings.readAppStatus ? await settings.readAppStatus(view.githubInstallationId) : null,
        providers: await settings.providers.list(orgId),
        webhookUrl: settings.webhookUrl,
        webhookSecret: settings.webhookSecret,
        version: deps.version,
        commit: deps.commit,
        now: new Date(now()),
        notice: extra.orgNotice ?? null,
        form: extra.orgForm ?? null,
      }
    }
    let { orgNotice: _notice, orgForm: _form, ...providerExtra } = extra
    return context.render(
      <SettingsPage
        frame={page}
        providers={list}
        org={org}
        now={new Date(now())}
        secretsConfigured={providers?.secretsConfigured ?? false}
        serviceKey={providers?.serviceKey ?? false}
        {...providerExtra}
      />,
      { status },
    )
  }

  type SettingsContext = Parameters<typeof getCsrfToken>[0] & {
    get(key: typeof Signed): SignedIn | undefined
    headers: Headers
    url: URL
    render(node: any, init?: ResponseInit): Response
  } & { get(key: typeof FormData): FormData | undefined }

  /**
   * REV-13. One form of the settings of the org: the limits, the trusted bots, the level or the
   * models of a level of the defaults. An admin only; cop() and csrf() of the session layer ran
   * before. `reset` removes a default of the org: the repositories then inherit the value of Kentō.
   */
  async function changeOrgSettings(context: SettingsContext, reset: boolean) {
    let signed = signedOf(context)
    let settings = deps.orgSettings
    if (!settings) return new Response('Not Found', { status: 404 })
    if (signed.membership.role !== 'admin') {
      log('warn', 'org_settings.change_refused', { login: signed.user.login, org: signed.membership.org.login, reason: 'not an admin' })
      return forbidden()
    }
    let form = context.get(FormData)
    let field = form?.get('field')
    let versionText = form?.get('version')
    let version = typeof versionText === 'string' && /^\d{1,9}$/.test(versionText) ? Number(versionText) : null
    let known = reset ? (ORG_RESET_FIELDS as readonly unknown[]).includes(field) : (ORG_FIELDS as readonly unknown[]).includes(field)
    if (!form || version === null || !known) return new Response('Bad Request', { status: 400 })
    let key = field as OrgField
    let orgId = signed.membership.org.id
    let page = frame(signed, context, getCsrfToken(context))

    let change: (current: OrgSettingsValues) => OrgSettingsValues
    if (reset) {
      change = (current) => ({ ...current, config: withoutField(current.config, key as ConfigField) })
    } else {
      let parsed =
        key === 'caps'
          ? readCapsForm(form)
          : key === 'trustedBots'
            ? readTrustedBotsForm(form)
            : key === 'level'
              ? readLevelForm(form)
              : readModelsForm(form, await settings.providers.list(orgId))
      if (!parsed.ok) {
        return renderSettings(context, signed, page, { orgForm: { field: key, values: formValues(form), errors: parsed.errors } }, 422)
      }
      let value = parsed.value
      change = (current) => {
        if (key === 'caps') return { ...current, caps: value as OrgSettingsValues['caps'] }
        if (key === 'trustedBots') return { ...current, trustedBots: value as string[] }
        if (key === 'level') return { ...current, config: { ...current.config, level: value as 'lite' | 'balanced' | 'heavy' } }
        let level = key.slice('models.'.length) as 'lite' | 'balanced' | 'heavy'
        return { ...current, config: { ...current.config, models: { ...current.config.models, [level]: value } } }
      }
    }

    let audit: { before: OrgSettingsValues; after: OrgSettingsValues } | null = null
    let outcome: OrgSaveOutcome = await settings.store.save(orgId, signed.user.id, version, (current) => {
      let after = change(current)
      audit = { before: current, after }
      return after
    })
    if (outcome.kind === 'not_found') return new Response('Not Found', { status: 404 })
    if (outcome.kind === 'conflict') {
      log('info', 'org_settings.conflict', { login: signed.user.login, org: signed.membership.org.login, field: key, sent: version, current: outcome.version })
      return renderSettings(
        context,
        signed,
        page,
        { orgNotice: { kind: 'conflict', version: outcome.version, updatedBy: outcome.updatedBy, updatedAt: outcome.updatedAt } },
        409,
      )
    }
    // The log keeps what changed for the cost and the rights: the limits and the bots, before and after.
    let changed = audit as { before: OrgSettingsValues; after: OrgSettingsValues } | null
    log('info', reset ? 'org_settings.reset' : 'org_settings.saved', {
      login: signed.user.login,
      org: signed.membership.org.login,
      field: key,
      version: outcome.version,
      ...(key === 'caps' && changed ? { before: changed.before.caps, after: changed.after.caps } : {}),
      ...(key === 'trustedBots' && changed ? { before: changed.before.trustedBots, after: changed.after.trustedBots } : {}),
    })
    let query = new URLSearchParams({ org: reset ? 'reset' : 'saved', v: String(outcome.version) })
    return redirect(`${pageRoutes.settings.href()}?${query}#${anchorOf(key)}`)
  }

  /** The providers and the signed-in admin of a form of the section, or the 403 to send. */
  function providerAdmin(context: { get(key: typeof Signed): SignedIn | undefined }, action: string): { signed: SignedIn; providers: ProvidersDependencies } | Response {
    let signed = signedOf(context)
    if (!deps.providers || signed.membership.role !== 'admin') {
      log('warn', 'providers.change_refused', { login: signed.user.login, org: signed.membership.org.login, action, reason: 'not an admin' })
      return forbidden()
    }
    return { signed, providers: deps.providers }
  }

  // The notice is a fixed word: no text of the URL is ever written into the page.
  function toSettings(notice: ProviderNotice, id?: string) {
    return redirect(`${pageRoutes.settings.href()}?notice=${notice}${id ? `#provider-${id}` : ''}`)
  }

  function signInPage(theme: Theme, notice: SignInNotice | null, returnTo: string) {
    let href = auth
      ? `${authRoutes.signInGitHub.href()}${returnTo !== '/' ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`
      : null
    return (
      <SignInPage
        theme={theme}
        version={deps.version}
        assetVersion={assetVersion}
        signInHref={href}
        notice={auth ? notice : 'disabled'}
      />
    )
  }

  async function setRepoEnabled(context: { get(key: typeof Signed): SignedIn | undefined; params: { id: string } }, enabled: boolean) {
    let signed = signedOf(context)
    if (signed.membership.role !== 'admin') {
      log('warn', 'repos.change_refused', { login: signed.user.login, org: signed.membership.org.login, reason: 'not an admin' })
      return forbidden()
    }
    let store = deps.repos?.store
    let result = store ? await store.setEnabled(signed.membership.org.id, context.params.id, enabled) : null
    if (!result) return new Response('Not Found', { status: 404 })
    log('info', enabled ? 'repos.enabled' : 'repos.disabled', {
      login: signed.user.login,
      org: signed.membership.org.login,
      repo: result.fullName,
      cancelled: result.cancelled,
    })
    let query = new URLSearchParams({ done: enabled ? 'enabled' : 'disabled', repo: context.params.id })
    if (!enabled) query.set('cancelled', String(result.cancelled))
    return redirect(`${pageRoutes.repos.href()}?${query}#repo-${context.params.id}`)
  }

  type ConfigContext = Parameters<typeof getCsrfToken>[0] & {
    get(key: typeof Signed): SignedIn | undefined
    params: { id: string }
    headers: Headers
    url: URL
    render(node: any, init?: ResponseInit): Response
  }

  async function renderConfig(
    context: ConfigContext,
    signed: SignedIn,
    page: PageFrame,
    tab: ConfigTab,
    extra: { notice?: ConfigNotice | null; form?: ConfigForm | null },
    status = 200,
  ) {
    let deps2 = deps.repoConfig!
    let view = await deps2.store.read(signed.membership.org.id, context.params.id)
    if (!view) return new Response('Not Found', { status: 404 })
    let providers = await deps2.providers.list(signed.membership.org.id)
    return context.render(
      <ConfigPage
        frame={page}
        view={view}
        providers={providers}
        tab={tab}
        notice={extra.notice ?? null}
        form={extra.form ?? null}
      />,
      { status },
    )
  }

  /** The form values of a change, as the person typed them, to show again with their errors. */
  function formValues(form: FormData | undefined): Record<string, string> {
    let values: Record<string, string> = {}
    for (let [key, value] of form?.entries() ?? []) if (typeof value === 'string' && key !== '_csrf') values[key] = value
    return values
  }

  async function changeConfig(context: ConfigContext & { get(key: typeof FormData): FormData | undefined }, reset: boolean) {
    let signed = signedOf(context)
    let configDeps = deps.repoConfig
    if (!configDeps) return new Response('Not Found', { status: 404 })
    if (signed.membership.role !== 'admin') {
      log('warn', 'repo_config.change_refused', { login: signed.user.login, org: signed.membership.org.login, reason: 'not an admin' })
      return forbidden()
    }
    let id = context.params.id
    if (!UUID.test(id)) return new Response('Not Found', { status: 404 })
    let form = context.get(FormData)
    let field = form?.get('field')
    let versionText = form?.get('version')
    let version = typeof versionText === 'string' && /^\d{1,9}$/.test(versionText) ? Number(versionText) : null
    let known = (CONFIG_FIELDS as readonly unknown[]).includes(field)
    if (!form || version === null || !known) return new Response('Bad Request', { status: 400 })
    let key = field as ConfigField
    let tab = tabOf(key)
    let page = frame(signed, context, getCsrfToken(context))

    let change: (current: { config: ConfigOverrides; defaultLevel: 'lite' | 'balanced' | 'heavy' }) => { config: ConfigOverrides; defaultLevel: 'lite' | 'balanced' | 'heavy' }
    if (reset) {
      // The column goes back to `lite` with the key: the level of the org then applies (REV-13).
      change = (current) => ({ config: withoutField(current.config, key), defaultLevel: key === 'level' ? 'lite' : current.defaultLevel })
    } else {
      let parsed =
        key === 'level'
          ? readLevelForm(form)
          : key === 'trigger'
            ? readTriggerForm(form)
            : key === 'paths'
              ? readPathsForm(form)
              : key === 'monthlyCapUsd'
                ? readCapForm(form)
                : readModelsForm(form, await configDeps.providers.list(signed.membership.org.id))
      if (!parsed.ok) {
        return renderConfig(context, signed, page, tab, { form: { field: key, values: formValues(form), errors: parsed.errors } }, 422)
      }
      let value = parsed.value
      change = (current) => {
        // The column keeps the level too: a release before REV-13 reads only the column.
        if (key === 'level') {
          let level = value as 'lite' | 'balanced' | 'heavy'
          return { config: { ...current.config, level }, defaultLevel: level }
        }
        let config: ConfigOverrides = { ...current.config }
        if (key.startsWith('models.')) {
          let level = key.slice('models.'.length) as 'lite' | 'balanced' | 'heavy'
          config.models = { ...config.models, [level]: value }
        } else {
          ;(config as Record<string, unknown>)[key] = value
        }
        return { ...current, config }
      }
    }

    let outcome: SaveOutcome = await configDeps.store.save(signed.membership.org.id, id, signed.user.id, version, (current) => {
      // « Revenir à l'org » on a key that the repository does not set changes nothing, but still
      // writes a version: the person sees which version they are on.
      if (reset && !hasField(current.config, key) && !(key === 'level' && current.defaultLevel !== 'lite')) return current
      return change(current)
    })
    if (outcome.kind === 'not_found') return new Response('Not Found', { status: 404 })
    if (outcome.kind === 'conflict') {
      log('info', 'repo_config.conflict', { login: signed.user.login, repoId: id, field: key, sent: version, current: outcome.version })
      return renderConfig(
        context,
        signed,
        page,
        tab,
        { notice: { kind: 'conflict', version: outcome.version, updatedBy: outcome.updatedBy, updatedAt: outcome.updatedAt } },
        409,
      )
    }
    log('info', reset ? 'repo_config.reset' : 'repo_config.saved', {
      login: signed.user.login,
      org: signed.membership.org.login,
      repo: outcome.fullName,
      field: key,
      version: outcome.version,
    })
    let query = new URLSearchParams({ tab, done: reset ? 'reset' : 'saved', v: String(outcome.version) })
    return redirect(`${pageRoutes.repoConfig.href({ id })}?${query}`)
  }

  let pages = createController(pageRoutes, {
    middleware: [securityHeaders(), ...sessionLayer, requireViewer],
    actions: {
      // REV-14. The dashboard: a member reads it; an admin can also retry the last failure.
      async home(context) {
        let signed = signedOf(context)
        let page = frame(signed, context, getCsrfToken(context))
        let dashboard = deps.dashboard
        if (!dashboard) return context.render(<PlaceholderPage frame={page} section="dashboard" />)
        let screen = await dashboard.store.screen(signed.membership.org.id)
        let notice = context.url.searchParams.get('notice')
        return context.render(
          <DashboardPage
            frame={page}
            screen={screen}
            githubUrl={dashboard.githubUrl}
            notice={notice !== null && notice in DASHBOARD_NOTICES ? (notice as DashboardNotice) : null}
          />,
        )
      },
      // cop() and csrf() of the session layer ran before.
      async jobRetry(context) {
        let signed = signedOf(context)
        let dashboard = deps.dashboard
        if (!dashboard || signed.membership.role !== 'admin') {
          log('warn', 'dashboard.retry_refused', { login: signed.user.login, org: signed.membership.org.login, reason: 'not an admin' })
          return forbidden()
        }
        let level = context.get(FormData)?.get('level')
        if (level !== 'lite' && level !== 'balanced' && level !== 'heavy') return new Response('Bad Request', { status: 400 })
        let id = context.params.id
        let orgId = signed.membership.org.id
        let outcome: RetryOutcome | { kind: 'github_failed' }
        let target = UUID.test(id) ? await dashboard.store.retryTarget(orgId, id) : null
        if (!target) {
          outcome = { kind: 'not_found' }
        } else {
          let now: Awaited<ReturnType<ReadPullRequest>> | null = null
          try {
            now = dashboard.readPullRequest ? await dashboard.readPullRequest(target) : null
          } catch (error) {
            log('warn', 'dashboard.retry_github_failed', { failedJobId: id, repo: target.fullName, pr: target.prNumber, error: errorMessage(error) })
          }
          outcome =
            dashboard.readPullRequest && !now
              ? { kind: 'github_failed' }
              : now && !now.open
                ? { kind: 'closed' }
                : await dashboard.store.retry(orgId, id, level, now?.headSha ?? null)
        }
        log('info', 'dashboard.retry', {
          login: signed.user.login,
          org: signed.membership.org.login,
          failedJobId: id,
          level,
          outcome: outcome.kind,
          ...('jobId' in outcome ? { jobId: outcome.jobId } : {}),
        })
        let notice: DashboardNotice =
          outcome.kind === 'queued' ? 'retried' : outcome.kind === 'not_found' ? 'missing' : outcome.kind
        return redirect(`${pageRoutes.home.href()}?notice=${notice}`)
      },
      async repos(context) {
        let signed = signedOf(context)
        let page = frame(signed, context, getCsrfToken(context))
        let repos = deps.repos
        if (!repos) return context.render(<PlaceholderPage frame={page} section="repos" />)
        let org = signed.membership.org
        let rows = await repos.store.list(org.id)
        let checking = repos.check?.refreshIfStale(org, rows) ?? false
        let query = context.url.searchParams
        let named = rows.find((row) => row.id === query.get('repo'))
        let done = query.get('done')
        let notice: ReposNotice | null =
          done === 'checked' || done === 'check_failed'
            ? { kind: done }
            : done === 'enabled' && named
              ? { kind: 'enabled', fullName: named.fullName }
              : done === 'disabled' && named
                ? { kind: 'disabled', fullName: named.fullName, cancelled: Number(query.get('cancelled')) || 0 }
                : null
        let confirm = signed.membership.role === 'admin' ? (rows.find((row) => row.id === query.get('confirm') && row.enabled) ?? null) : null
        return context.render(
          <ReposPage
            frame={page}
            repos={rows}
            installationUrl={installationUrl(repos.githubUrl, org)}
            githubUrl={repos.githubUrl}
            checking={checking}
            notice={notice}
            confirm={confirm}
            now={new Date(now())}
          />,
        )
      },

      // REV-9. The forms of the Repos screen: an admin of the org on screen only. cop() and csrf()
      // of the session layer ran before.
      async repoEnable(context) {
        return setRepoEnabled(context, true)
      },
      async repoDisable(context) {
        return setRepoEnabled(context, false)
      },
      async reposCheck(context) {
        let signed = signedOf(context)
        if (signed.membership.role !== 'admin') return forbidden()
        let check = deps.repos?.check
        if (!check) return redirect(`${pageRoutes.repos.href()}?done=check_failed`)
        try {
          await check.run(signed.membership.org)
          return redirect(`${pageRoutes.repos.href()}?done=checked`)
        } catch {
          // The check logs its error.
          return redirect(`${pageRoutes.repos.href()}?done=check_failed`)
        }
      },
      // REV-12. The Config screen of a repository: a member reads it, an admin changes it.
      async repoConfig(context) {
        let signed = signedOf(context)
        if (!deps.repoConfig || !UUID.test(context.params.id)) return new Response('Not Found', { status: 404 })
        let page = frame(signed, context, getCsrfToken(context))
        let query = context.url.searchParams
        let tab = query.get('tab')
        let done = query.get('done')
        let version = Number(query.get('v'))
        let notice: ConfigNotice | null =
          (done === 'saved' || done === 'reset') && Number.isSafeInteger(version) && version > 0 ? { kind: done, version } : null
        return renderConfig(context, signed, page, isConfigTab(tab) ? tab : 'models', { notice })
      },
      // cop() and csrf() of the session layer ran before.
      async repoConfigSave(context) {
        return changeConfig(context, false)
      },
      async repoConfigReset(context) {
        return changeConfig(context, true)
      },
      findings(context) {
        let page = frame(signedOf(context), context, getCsrfToken(context))
        return context.render(<PlaceholderPage frame={page} section="findings" />)
      },
      async runners(context) {
        let signed = signedOf(context)
        let page = frame(signed, context, getCsrfToken(context))
        if (!deps.runners) return context.render(<PlaceholderPage frame={page} section="runners" />)
        let notice = context.url.searchParams.get('notice')
        return renderRunners(context, signed, page, {
          notice: notice !== null && notice in RUNNER_NOTICES ? (notice as RunnerNotice) : null,
        })
      },

      // « Nouveau runner »: a registration token, shown on this response only. A reload posts the
      // form again and makes another token; the first one then ends unused after its hour.
      async runnerNew(context) {
        let signed = signedOf(context)
        let store = deps.runners
        if (!store || signed.membership.role !== 'admin') return forbidden()
        let page = frame(signed, context, getCsrfToken(context))
        let { values, input, errors } = readRegistrationForm(context.get(FormData))
        if (!input) return renderRunners(context, signed, page, { form: { values, errors } }, 422)
        let token = newRegistrationToken()
        let created = await store.createRegistration({
          orgId: signed.membership.org.id,
          userId: signed.user.id,
          name: input.name,
          labels: input.labels,
          trusted: input.trusted,
          tokenHash: hashToken(token),
        })
        log('info', 'runner.registration_created', {
          registrationId: created.id,
          org: signed.membership.org.login,
          by: signed.user.login,
          name: input.name,
          labels: input.labels,
          trusted: input.trusted,
        })
        return renderRunners(context, signed, page, { created: { ...input, token, expiresAt: created.expiresAt } }, 201)
      },

      async runnerRenew(context) {
        let signed = signedOf(context)
        let store = deps.runners
        if (!store || signed.membership.role !== 'admin') return forbidden()
        let id = context.params.id
        if (!UUID.test(id)) return redirect(`${pageRoutes.runners.href()}?notice=missing`)
        let token = newRegistrationToken()
        let renewed = await store.renewRegistration({
          orgId: signed.membership.org.id,
          registrationId: id,
          userId: signed.user.id,
          tokenHash: hashToken(token),
        })
        if (!renewed) return redirect(`${pageRoutes.runners.href()}?notice=missing`)
        log('info', 'runner.registration_created', {
          registrationId: renewed.id,
          replaces: id,
          org: signed.membership.org.login,
          by: signed.user.login,
          name: renewed.name,
          labels: renewed.labels,
          trusted: renewed.trusted,
        })
        let page = frame(signed, context, getCsrfToken(context))
        return renderRunners(context, signed, page, { created: { ...renewed, token } }, 201)
      },

      async runnerDiscard(context) {
        let signed = signedOf(context)
        let store = deps.runners
        if (!store || signed.membership.role !== 'admin') return forbidden()
        let id = context.params.id
        let done = UUID.test(id) && (await store.discardRegistration(signed.membership.org.id, id))
        if (done) log('info', 'runner.registration_discarded', { registrationId: id, by: signed.user.login })
        return redirect(`${pageRoutes.runners.href()}?notice=${done ? 'discarded' : 'missing'}`)
      },

      async runnerTrust(context) {
        let signed = signedOf(context)
        let store = deps.runners
        if (!store || signed.membership.role !== 'admin') return forbidden()
        let id = context.params.id
        let value = context.get(FormData)?.get('trusted')
        if (value !== 'true' && value !== 'false') return new Response('Bad Request', { status: 400 })
        let trusted = value === 'true'
        let done = UUID.test(id) && (await store.setTrusted(signed.membership.org.id, id, trusted))
        if (done) log('info', 'runner.trust_changed', { runnerId: id, trusted, by: signed.user.login })
        return redirect(`${pageRoutes.runners.href()}?notice=${done ? (trusted ? 'trusted' : 'untrusted') : 'missing'}`)
      },

      async runnerRevoke(context) {
        let signed = signedOf(context)
        let store = deps.runners
        if (!store || signed.membership.role !== 'admin') return forbidden()
        let id = context.params.id
        let revoked = UUID.test(id) ? await store.revoke(signed.membership.org.id, id) : null
        if (revoked) {
          log('info', 'runner.revoked', { runnerId: id, name: revoked.name, requeued: revoked.requeued, by: signed.user.login })
        }
        return redirect(`${pageRoutes.runners.href()}?notice=${revoked ? 'revoked' : 'missing'}`)
      },

      async settings(context) {
        let signed = signedOf(context)
        let page = frame(signed, context, getCsrfToken(context))
        if (!deps.providers && !deps.orgSettings) return context.render(<PlaceholderPage frame={page} section="settings" />)
        let query = context.url.searchParams
        let notice = query.get('notice')
        let done = query.get('org')
        let version = Number(query.get('v'))
        return renderSettings(context, signed, page, {
          notice: notice !== null && notice in PROVIDER_NOTICES ? { kind: notice as ProviderNotice } : null,
          orgNotice: (done === 'saved' || done === 'reset') && Number.isSafeInteger(version) && version > 0 ? { kind: done, version } : null,
        })
      },

      async orgSettingsSave(context) {
        return changeOrgSettings(context, false)
      },
      async orgSettingsReset(context) {
        return changeOrgSettings(context, true)
      },

      // REV-11. The forms of « Providers et clés »: an admin of the org on screen only. cop() and
      // csrf() of the session layer ran before. A key is read from the form, encrypted, and never
      // written back into a page, a redirect or a log.
      async providerAdd(context) {
        let admin = providerAdmin(context, 'add')
        if (admin instanceof Response) return admin
        let { signed, providers } = admin
        let page = frame(signed, context, getCsrfToken(context))
        let { values, input, errors } = readProviderForm(context.get(FormData))
        if (input && input.apiKey !== null && !providers.secretsConfigured) {
          errors.apiKey = 'Le service ne peut pas chiffrer de clé (KENTO_SECRETS_KEY) : laissez-la sur le runner.'
        }
        if (!input || errors.apiKey) return renderSettings(context, signed, page, { form: { values, errors } }, 422)
        let added
        try {
          added = await providers.store.add({ ...input, orgId: signed.membership.org.id, userId: signed.user.id })
        } catch (error) {
          if (!(error instanceof SecretsError)) throw error
          return renderSettings(context, signed, page, { form: { values, errors: { apiKey: error.message } } }, 422)
        }
        log('info', 'providers.added', {
          providerId: added.id,
          org: signed.membership.org.login,
          by: signed.user.login,
          kind: added.kind,
          runnerHeld: added.runnerHeld,
          isDefault: added.isDefault,
        })
        return toSettings('added', added.id)
      },

      // The answer of a test is the page itself, with the message of the probe: it never goes
      // through a URL.
      async providerTest(context) {
        let admin = providerAdmin(context, 'test')
        if (admin instanceof Response) return admin
        let { signed, providers } = admin
        let id = context.params.id
        let page = frame(signed, context, getCsrfToken(context))
        let failed = (detail: string) => renderSettings(context, signed, page, { notice: { kind: 'test_failed', detail } })
        let found
        try {
          found = UUID.test(id) ? await providers.store.withKey(signed.membership.org.id, id) : null
        } catch (error) {
          if (!(error instanceof SecretsError)) throw error
          log('error', 'providers.key_unreadable', { providerId: id, error: error.message })
          return failed('La clé ne se déchiffre pas avec la clé maître du service.')
        }
        if (!found) return toSettings('missing')
        if (found.apiKey === null) return failed('Ce provider se teste depuis le runner qui le tient.')
        let result = await providers.probe({ kind: found.provider.kind, baseUrl: found.provider.baseUrl, apiKey: found.apiKey })
        log(result.outcome === 'ok' ? 'info' : 'warn', 'providers.tested', {
          providerId: id,
          org: signed.membership.org.login,
          by: signed.user.login,
          outcome: result.outcome,
          ...(result.outcome === 'refused' ? { status: result.status } : {}),
        })
        if (result.outcome === 'ok') {
          await providers.store.recordOk(id, found.provider.keySetAt)
          return toSettings('tested_ok', id)
        }
        if (result.outcome === 'refused') {
          await providers.store.recordRefused(id, result.status, result.message, found.provider.keySetAt)
          return toSettings('tested_refused', id)
        }
        return failed(result.message)
      },

      async providerKey(context) {
        let admin = providerAdmin(context, 'replace_key')
        if (admin instanceof Response) return admin
        let { signed, providers } = admin
        let id = context.params.id
        if (!UUID.test(id)) return toSettings('missing')
        let { apiKey, error } = readKeyForm(context.get(FormData))
        let page = frame(signed, context, getCsrfToken(context))
        if (!apiKey) return renderSettings(context, signed, page, { keyError: { id, message: error! } }, 422)
        let replaced
        try {
          replaced = await providers.store.replaceKey(signed.membership.org.id, id, apiKey)
        } catch (cause) {
          if (!(cause instanceof SecretsError)) throw cause
          return renderSettings(context, signed, page, { keyError: { id, message: cause.message } }, 422)
        }
        if (!replaced) return toSettings('missing')
        log('info', 'providers.key_replaced', { providerId: id, org: signed.membership.org.login, by: signed.user.login })
        return toSettings('replaced', id)
      },

      async providerDefault(context) {
        let admin = providerAdmin(context, 'default')
        if (admin instanceof Response) return admin
        let { signed, providers } = admin
        let id = context.params.id
        let done = UUID.test(id) ? await providers.store.setDefault(signed.membership.org.id, id) : null
        if (!done) return toSettings('missing')
        log('info', 'providers.default_changed', { providerId: id, org: signed.membership.org.login, by: signed.user.login })
        return toSettings('default', id)
      },

      async providerRemove(context) {
        let admin = providerAdmin(context, 'remove')
        if (admin instanceof Response) return admin
        let { signed, providers } = admin
        let id = context.params.id
        let removed = UUID.test(id) ? await providers.store.remove(signed.membership.org.id, id) : null
        if (!removed) return toSettings('missing')
        log('info', 'providers.removed', { providerId: id, org: signed.membership.org.login, by: signed.user.login, kind: removed.kind })
        return toSettings('removed')
      },

      // The theme form, for a browser without JavaScript: public/assets/theme.js does the same at once.
      theme(context) {
        let form = context.get(FormData)
        let theme = form?.get('theme')
        let response = redirect(localPath(form?.get('returnTo')))
        if (isTheme(theme)) response.headers.append('Set-Cookie', themeCookie(theme, secure))
        return response
      },

      // The org on screen, for a person who is a member of several.
      org(context) {
        let form = context.get(FormData)
        let orgId = form?.get('orgId')
        if (typeof orgId === 'string' && signedOf(context).memberships.some((m) => m.org.id === orgId)) {
          sessionOf(context).set('orgId', orgId)
        }
        return redirect(localPath(form?.get('returnTo')))
      },

      signOut(context) {
        log('info', 'auth.signed_out', { login: signedOf(context).user.login })
        sessionOf(context).destroy()
        return redirect(`${authRoutes.signIn.href()}?notice=signed_out`)
      },
    },
  })

  let signIn = createController(authRoutes, {
    middleware: [securityHeaders(), ...sessionLayer],
    actions: {
      signIn(context) {
        let notice = context.url.searchParams.get('notice')
        let returnTo = localPath(context.url.searchParams.get('returnTo'))
        if (auth) {
          let record = readSessionAuth(sessionOf(context))
          if (record && record.signedInAt + SESSION_TTL_MS > now()) return redirect(returnTo)
        }
        let theme = readTheme(context.headers.get('Cookie'))
        return context.render(signInPage(theme, NOTICES.find((n) => n === notice) ?? null, returnTo))
      },

      signInGitHub(context) {
        if (!auth) return redirect(authRoutes.signIn.href())
        return startExternalAuth(auth.provider, context, {
          returnTo: localPath(context.url.searchParams.get('returnTo')),
        })
      },

      // GitHub comes back here. The person gets a session only when GitHub counts them in an org
      // of the App: nothing is written for anyone else.
      async callback(context) {
        if (!auth) return redirect(authRoutes.signIn.href())
        let profile: GitHubProfile
        let returnTo: string | undefined
        try {
          let finished = await finishExternalAuth(auth.provider, context)
          profile = finished.result.profile
          returnTo = finished.returnTo
        } catch (error) {
          log('warn', 'auth.sign_in_failed', { error: errorMessage(error) })
          sessionOf(context).destroy()
          return redirect(`${authRoutes.signIn.href()}?notice=failed`)
        }

        let decision = await decideSignIn(auth.store, auth.lookupRole, profile)
        if (decision.kind !== 'allowed') {
          log('info', 'auth.sign_in_refused', { login: profile.login, reason: decision.kind })
          sessionOf(context).destroy()
          return redirect(`${authRoutes.signIn.href()}?notice=${decision.kind === 'refused' ? 'not_member' : 'failed'}`)
        }

        let user = await auth.store.upsertUser(profile)
        await saveSignInRoles(auth.store, user, decision.roles, decision.unconfirmed)
        // A new session id: an id known before the sign-in never becomes a signed-in one.
        let session = completeAuth(context)
        // A sign-in from a session that was already signed in (another account, or the same one)
        // keeps nothing of it: not its user, its org, nor its CSRF token.
        for (let key of ['auth', 'orgId', '_csrf']) session.unset(key)
        session.set('auth', { userId: user.id, signedInAt: now() })
        let first = decision.roles.find((r) => r.role === 'admin') ?? decision.roles[0]!
        session.set('orgId', first.org.id)
        log('info', 'auth.signed_in', {
          login: user.login,
          orgs: decision.roles.map((r) => `${r.org.login}:${r.role}`),
        })
        return redirect(localPath(returnTo ?? '/'))
      },
    },
  })

  return { pages, signIn }
}

/** A path of this site, or `/`: never another origin (`//host`, `/\host`, a scheme). */
export function localPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  try {
    let url = new URL(value, 'http://kento.invalid')
    return url.origin === 'http://kento.invalid' ? `${url.pathname}${url.search}` : '/'
  } catch {
    return '/'
  }
}

function PlaceholderPage(handle: Handle<{ frame: PageFrame; section: Section }>) {
  return () => {
    let { frame, section } = handle.props
    let page = PLACEHOLDERS[section]
    return (
      <Shell frame={frame} section={section} title={page.title} lead={page.lead}>
        <section class="empty" aria-labelledby="empty-title">
          <h2 id="empty-title">Bientôt ici</h2>
          <p>{page.empty}</p>
        </section>
      </Shell>
    )
  }
}
