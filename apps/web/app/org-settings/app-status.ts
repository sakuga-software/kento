import type { KeyObject } from 'node:crypto'

import { appJwt } from '../github/installation-token.ts'
import { errorMessage, log } from '../log.ts'
import { createGitHub } from '../publish/github.ts'

/** What GitHub says about the App and one of its installations, for the section "App GitHub". */
export interface AppStatus {
  /** `kento-review`. */
  slug: string
  name: string
  /** The public page of the App, `https://github.com/apps/kento-review`. */
  htmlUrl: string
  /** "Advanced" of the settings of the App: Recent Deliveries and "Redeliver". */
  deliveriesUrl: string
  /** The URL that GitHub posts to, and whether it checks its certificate. Null: GitHub did not give it. */
  webhook: { url: string; sslVerified: boolean } | null
  installation: {
    /** The permissions that the installation grants, as GitHub names them. */
    permissions: Record<string, string>
    events: string[]
    /** `all`, or `selected` repositories. */
    repositorySelection: string
    suspendedAt: Date | null
    /** The page of the installation in the org, where an owner accepts new permissions. */
    htmlUrl: string
  }
}

export type ReadAppStatus = (githubInstallationId: number) => Promise<{ ok: true; status: AppStatus } | { ok: false; error: string }>

const TTL_MS = 5 * 60 * 1000

/**
 * Reads the App and the installation on GitHub with the JWT of the App, and keeps the answer 5
 * minutes: the screen does not call GitHub at each display. A failure is not kept.
 */
export function createAppStatusReader(deps: {
  appId: string
  privateKey: KeyObject
  apiUrl: string
  /** `https://github.com`, or the GitHub Enterprise Server. */
  githubUrl: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}): ReadAppStatus {
  let now = deps.now ?? Date.now
  let cache = new Map<number, { at: number; status: AppStatus }>()
  let githubUrl = deps.githubUrl.replace(/\/+$/, '')

  return async (installationId) => {
    let kept = cache.get(installationId)
    if (kept && now() - kept.at < TTL_MS) return { ok: true, status: kept.status }
    let github = createGitHub({ apiUrl: deps.apiUrl, token: appJwt(deps.appId, deps.privateKey, now()), fetch: deps.fetch })
    try {
      let app: { slug: string; name: string; html_url: string; owner?: { login?: string; type?: string } } = await github.rest('GET', '/app')
      let installation: {
        permissions?: Record<string, string>
        events?: string[]
        repository_selection?: string
        suspended_at?: string | null
        html_url?: string
      } = await github.rest('GET', `/app/installations/${installationId}`)
      let webhook: AppStatus['webhook'] = null
      try {
        let hook: { url?: string; insecure_ssl?: string | number } = await github.rest('GET', '/app/hook/config')
        if (typeof hook.url === 'string') webhook = { url: hook.url, sslVerified: String(hook.insecure_ssl ?? '0') === '0' }
      } catch (error) {
        log('warn', 'settings.app_hook_unreadable', { error: errorMessage(error) })
      }
      let owner = app.owner?.login ?? ''
      let settingsBase = app.owner?.type === 'Organization' ? `${githubUrl}/organizations/${encodeURIComponent(owner)}/settings/apps` : `${githubUrl}/settings/apps`
      let status: AppStatus = {
        slug: app.slug,
        name: app.name,
        htmlUrl: app.html_url,
        deliveriesUrl: `${settingsBase}/${encodeURIComponent(app.slug)}/advanced`,
        webhook,
        installation: {
          permissions: installation.permissions ?? {},
          events: installation.events ?? [],
          repositorySelection: installation.repository_selection ?? 'selected',
          suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
          htmlUrl: installation.html_url ?? `${githubUrl}/settings/installations/${installationId}`,
        },
      }
      cache.set(installationId, { at: now(), status })
      return { ok: true, status }
    } catch (error) {
      let message = errorMessage(error)
      log('warn', 'settings.app_status_failed', { installationId, error: message })
      return { ok: false, error: message.slice(0, 200) }
    }
  }
}
