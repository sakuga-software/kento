// The settings of an org (REV-13): its cost limits, its trusted bots, and what the App must hold on
// GitHub. No database, no network.

import { MAX_CAP_USD, type FormResult } from '../repo-config/model.ts'

/** The bot that the earlier variable KENTO_TRUSTED_BOTS trusted by default, and a new org trusts. */
export const DEFAULT_TRUSTED_BOTS: readonly string[] = ['sakuga-agent[bot]']
export const MAX_TRUSTED_BOTS = 20
/** A login of a GitHub App bot: the slug of the App (39 characters at most), then `[bot]`. */
const BOT_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})\[bot\]$/

export type CapPeriod = 'day' | 'month'

export interface OrgCaps {
  /** Dollars per UTC day, or null: no limit. */
  dailyCapUsd: number | null
  /** Dollars per UTC calendar month, or null: no limit. */
  monthlyCapUsd: number | null
  /** The screen warns from this percentage of a limit. */
  alertPct: number
}

export interface OrgSpent {
  dayUsd: number
  monthUsd: number
}

export interface CapHit {
  period: CapPeriod
  spentUsd: number
  capUsd: number
  /** When the period ends: the next midnight UTC, or the first day of the next month at midnight UTC. */
  resetsAt: Date
}

/** The end of the current period, in UTC. */
export function nextReset(period: CapPeriod, now: Date): Date {
  if (period === 'day') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

/**
 * The limit that the org has reached, the day first, or null. A limit of 0 stops every new job. The
 * cost of a job is known only when it ends: the jobs queued before the limit still run, and can
 * take the cost over it.
 */
export function capReached(caps: Pick<OrgCaps, 'dailyCapUsd' | 'monthlyCapUsd'>, spent: OrgSpent, now: Date): CapHit | null {
  if (caps.dailyCapUsd !== null && spent.dayUsd >= caps.dailyCapUsd) {
    return { period: 'day', spentUsd: spent.dayUsd, capUsd: caps.dailyCapUsd, resetsAt: nextReset('day', now) }
  }
  if (caps.monthlyCapUsd !== null && spent.monthUsd >= caps.monthlyCapUsd) {
    return { period: 'month', spentUsd: spent.monthUsd, capUsd: caps.monthlyCapUsd, resetsAt: nextReset('month', now) }
  }
  return null
}

/** The periods whose cost reached the alert percentage of their limit, without the limit itself. */
export function capAlerts(caps: OrgCaps, spent: OrgSpent): CapPeriod[] {
  let out: CapPeriod[] = []
  let near = (cap: number | null, value: number) => cap !== null && cap > 0 && value < cap && value >= (cap * caps.alertPct) / 100
  if (near(caps.dailyCapUsd, spent.dayUsd)) out.push('day')
  if (near(caps.monthlyCapUsd, spent.monthUsd)) out.push('month')
  return out
}

/** A `numeric` of Postgres, as postgres.js gives it (a string), or null. */
export function readMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null
  let number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

/** The trusted bots of a row, lowercase. A value that is not a login of a bot is dropped. */
export function readTrustedBots(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_TRUSTED_BOTS]
  return [...new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase()))].filter((v) => BOT_LOGIN.test(v))
}

// --- The forms of the screen ------------------------------------------------------------------

function field(form: FormData, name: string): string {
  let value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function money(form: FormData, name: string, errors: Record<string, string>): number | null {
  let raw = field(form, name).replace(/\s/g, '').replace(',', '.')
  if (raw === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    errors[name] = 'An amount in dollars, for example 8 or 0.50. Leave it empty for no cap.'
    return null
  }
  let value = Number(raw)
  if (value > MAX_CAP_USD) errors[name] = `$${MAX_CAP_USD.toLocaleString('en-US')} at most.`
  return value
}

/** "Cost cap": the two limits (empty: none) and the alert percentage. */
export function readCapsForm(form: FormData): FormResult<OrgCaps> {
  let errors: Record<string, string> = {}
  let dailyCapUsd = money(form, 'dailyCapUsd', errors)
  let monthlyCapUsd = money(form, 'monthlyCapUsd', errors)
  let rawPct = field(form, 'alertPct').replace(/\s|%/g, '')
  let alertPct = Number(rawPct)
  if (!/^\d{1,3}$/.test(rawPct) || alertPct < 1 || alertPct > 100) errors.alertPct = 'A whole percentage, from 1 to 100.'
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, value: { dailyCapUsd, monthlyCapUsd, alertPct } }
}

/**
 * "Trusted bots": one login per line, or separated by commas. `renovate` becomes
 * `renovate[bot]`: a person is never a trusted bot.
 */
export function readTrustedBotsForm(form: FormData): FormResult<string[]> {
  let logins = field(form, 'trustedBots')
    .split(/[\s,]+/)
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean)
    .map((login) => (login.endsWith('[bot]') ? login : `${login}[bot]`))
  let unique = [...new Set(logins)]
  if (unique.length > MAX_TRUSTED_BOTS) return { ok: false, errors: { trustedBots: `${MAX_TRUSTED_BOTS} bots at most.` } }
  let wrong = unique.find((login) => !BOT_LOGIN.test(login))
  if (wrong) {
    return {
      ok: false,
      errors: { trustedBots: `"${wrong.slice(0, 60)}" is not the login of a bot. A bot login is the name of a GitHub App followed by [bot], for example renovate[bot].` },
    }
  }
  return { ok: true, value: unique }
}

// --- The GitHub App ---------------------------------------------------------------------------

/** What Kentō needs, as GitHub names it. `metadata: read` comes with every App. */
export const REQUIRED_PERMISSIONS: Readonly<Record<string, 'read' | 'write'>> = {
  contents: 'read',
  pull_requests: 'write',
  issues: 'write',
  checks: 'write',
  members: 'read',
  metadata: 'read',
}

/** The events that create the jobs. `installation` and `installation_repositories` come without a box. */
export const REQUIRED_EVENTS: readonly string[] = ['pull_request', 'issue_comment']

export interface PermissionCheck {
  name: string
  needed: 'read' | 'write'
  granted: 'read' | 'write' | null
  ok: boolean
}

/** Each permission that Kentō needs, and what the installation grants. `write` covers `read`. */
export function checkPermissions(granted: Record<string, string>): PermissionCheck[] {
  return Object.entries(REQUIRED_PERMISSIONS).map(([name, needed]) => {
    let value = granted[name]
    let have: 'read' | 'write' | null = value === 'write' || value === 'read' ? value : null
    return { name, needed, granted: have, ok: have === 'write' || (have === 'read' && needed === 'read') }
  })
}

export function missingEvents(events: readonly string[]): string[] {
  return REQUIRED_EVENTS.filter((event) => !events.includes(event))
}
