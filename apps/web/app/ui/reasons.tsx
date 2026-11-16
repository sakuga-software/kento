// The reasons that the service, the runner and GitHub write in English, as the screens show them:
// what happened and what to do, in words that a person reads. The stored reasons and the answers of the webhook and of
// the runner API stay in English: logs, tests and the runner read them.

import type { Handle } from 'remix/component'

import { sanitizeReason } from '../publish/failure.ts'

/** A reason in words. `raw`: the text of the service, shown under « Technical details », or null. */
export interface Reason {
  /** What happened, from a lowercase letter, with no final period. */
  text: string
  /** What to do, as whole sentences. Empty when there is nothing to do. */
  action: string
  raw: string | null
}

/** The names that the adapters of the engine give to a provider (packages/engine/src/providers.ts). */
const PROVIDER_NAMES = 'OpenRouter|Anthropic|Ollama|The OpenAI-compatible server'
/** « ProviderError: <name> <what> », at the start of the error of the model. */
const PROVIDER_ERROR = (what: string) => new RegExp(`^ProviderError: (?:${PROVIDER_NAMES}) ${what}`)

const TIMES: Record<number, string> = { 1: 'once', 2: 'twice', 3: 'three times' }

/** What a provider status means for a job, and what to do. */
function providerStatus(status: number): Omit<Reason, 'raw'> {
  if (status === 401 || status === 403) {
    return { text: `the provider refused the key, code ${status}`, action: 'Replace the key in Settings, or PROVIDER_API_KEY on the runner, then retry.' }
  }
  if (status === 404) return { text: 'the provider does not know the model, code 404', action: 'Check the id of the model in the config of the repo, then retry.' }
  if (status === 429) return { text: 'the provider limits the number of calls, code 429', action: 'Retry in a few minutes, or raise the limit at the provider.' }
  if (status >= 500) return { text: `the provider is unavailable or overloaded, code ${status}`, action: 'Retry in a few minutes.' }
  return { text: `the provider refused the request, code ${status}`, action: 'Read the technical details, then check the model in the config of the repo.' }
}

/**
 * The reason of a failed job. The service writes « lease expired N times » and « the provider « X »
 * refused its key (N): … »; the runner sends the message of its error (apps/runner/src/job.ts, the
 * engine). Any other reason is unknown, and its text goes under « Technical details ».
 */
export function jobReason(reason: string | null, runnerName: string | null): Reason {
  let trimmed = reason?.trim() ?? ''
  if (!trimmed) return { text: 'no reason recorded', action: 'Retry the review. If it fails again, read the logs of the runner.', raw: null }
  let lease = /^lease expired (\d+) times?$/.exec(trimmed)
  if (lease) {
    let n = Number(lease[1])
    return {
      text: `the runner stopped answering during the job ${TIMES[n] ?? `${n} times`}${runnerName ? `, last ${runnerName}` : ''}`,
      action: 'Check on the Runners screen that a runner is online, then retry.',
      raw: null,
    }
  }
  let raw = sanitizeReason(trimmed)
  let refused = /^the provider « (.+) » refused its key \((\d{3})\)/.exec(trimmed)
  if (refused) return { text: `the provider "${refused[1]}" refused its key, code ${refused[2]}`, action: 'Replace its key in Settings, then retry.', raw }
  let known = ((): Omit<Reason, 'raw'> | null => {
    // The steps of the service at the claim (app/runner/controller.ts).
    if (trimmed.startsWith('installation token: ')) {
      return { text: 'GitHub gave no token for this repo', action: 'Check that the GitHub App is still installed on this repo, then retry.' }
    }
    if (trimmed.startsWith('review threads: ')) return { text: 'Kentō could not read the threads of the pull request on GitHub', action: 'Retry in a few minutes.' }
    if (trimmed.startsWith('rules: ')) return { text: 'Kentō could not read the rules of the repo', action: 'Retry in a few minutes.' }
    if (/^the provider « .+ » is not of the org of the runner$/.test(trimmed)) {
      return { text: 'the provider of the config belongs to another organization than the runner', action: 'Choose a provider of this organization in the config of the repo, then retry.' }
    }
    if (/^the provider « .+ » needs a trusted runner$/.test(trimmed)) {
      return { text: 'the key of this provider goes only to a trusted runner', action: 'Mark a runner as trusted on the Runners screen, then retry.' }
    }
    if (/^the key of the provider « .+ » cannot be decrypted/.test(trimmed)) {
      return { text: 'the master key of the service does not decrypt the key of the provider', action: 'Replace the key in Settings, or check KENTO_SECRETS_KEY on the service.' }
    }
    if (/^no model key\b/.test(trimmed)) {
      return { text: 'the runner has no key for this provider', action: 'Give it PROVIDER_KIND and PROVIDER_API_KEY, or mark it as trusted on the Runners screen.' }
    }
    if (/^clone failed\b/.test(trimmed)) return { text: 'the runner could not clone the repo', action: 'Check that the GitHub App still has access to this repo, then retry.' }
    if (/^the service refused the review\b/.test(trimmed)) {
      return { text: 'the service refused the result of the runner', action: 'Update the runner to the version that the Runners screen shows, then retry.' }
    }
    if (/^the provider \S+ needs a base URL$/.test(trimmed)) return { text: 'the provider has no URL', action: 'Add its URL in Settings, then retry.' }
    if (/^no model is set for the provider \S+ at this level$|^the provider \S+ that the config chose is not in the job$|^the job names no provider$/.test(trimmed)) {
      return { text: 'the config of the repo names a provider or a model that the job does not have', action: 'Choose the provider and the models of this level in the config of the repo, then retry.' }
    }
    // The engine wraps the error of the last model (`askJson` in packages/engine/src/model.ts):
    // « no model gave a usable answer: ProviderError: <name> … » or « …: TimeoutError: … ». Each
    // pattern reads the start of that error, never a word of the answer body that follows it.
    let model = /^no model gave a usable answer: (.*)$/s.exec(trimmed)?.[1] ?? null
    let status = model === null ? /^provider: (\d{3})\b/.exec(trimmed) : PROVIDER_ERROR('answered (\\d{3})\\b').exec(model)
    if (status) return providerStatus(Number(status[1]))
    if (model === null) return null
    if (/^TimeoutError\b/.test(model)) {
      return { text: 'the model did not answer in time', action: 'Retry in a few minutes, or choose a faster model in the config of the repo.' }
    }
    if (PROVIDER_ERROR('gave (?:no JSON object|JSON that does not parse)').test(model)) {
      return { text: 'the model gave an answer that Kentō cannot read', action: 'Retry. If the failure comes back, choose another model in the config of the repo.' }
    }
    if (PROVIDER_ERROR('declined the request\\b').test(model)) {
      return { text: 'the provider declined to process this pull request', action: 'Retry with another model, chosen in the config of the repo.' }
    }
    return null
  })()
  return { ...(known ?? { text: 'the runner sent an error that Kentō does not know', action: 'Read the technical details, then retry.' }), raw }
}

const COST_PERIOD: Record<string, string> = { daily: 'daily', monthly: 'monthly' }
const TRIGGER_TEXT: Record<string, string> = { push: 'on each push', ready: 'when the pull request becomes "Ready for review"', command: 'on request' }
const UNTRUSTED_BOT = 'Add it to the trusted bots so that it starts a review.'
const REPLAY = 'Redeliver it from the page of the App.'
const INVALID = 'Open it in "Recent Deliveries", on the page of the App, to read what GitHub sent.'

/** The reasons of the webhook (app/github/events.ts, app/db/webhook-store.ts, app/commands/handler.ts). */
const DELIVERY_REASONS: [RegExp, (m: RegExpExecArray) => Omit<Reason, 'raw'>][] = [
  [/^draft pull request$/, () => ({ text: 'draft pull request, no review before it becomes "Ready for review"', action: '' })],
  [/^pushed by an untrusted bot$/, () => ({ text: 'push of a bot that is not a trusted bot', action: UNTRUSTED_BOT })],
  [/^opened by an untrusted bot$/, () => ({ text: 'pull request opened by a bot that is not a trusted bot', action: UNTRUSTED_BOT })],
  [/^command of an untrusted bot$/, () => ({ text: 'command of a bot that is not a trusted bot', action: UNTRUSTED_BOT })],
  [/^pull request from a fork$/, () => ({ text: 'pull request from a fork, no automatic review', action: 'A person who can write to the repo can start @kento-review.' })],
  [/^pull request (?:is )?closed$/, () => ({ text: 'pull request closed', action: '' })],
  [/^event (\S+) is not handled$/, (m) => ({ text: `event ${m[1]}, which Kentō does not handle`, action: '' })],
  [/^pull_request action (\S+) creates no job$/, (m) => ({ text: `pull request action ${m[1]}, no review`, action: '' })],
  [/^issue_comment action (\S+) gives no command$/, (m) => ({ text: `comment ${m[1]}, no command`, action: '' })],
  [/^installation(?:_repositories)? action (\S+) is not handled$/, (m) => ({ text: `installation action ${m[1]}, which Kentō does not handle`, action: '' })],
  [/^comment is not on a pull request$/, () => ({ text: 'comment outside a pull request', action: '' })],
  [/^comment is not a command$/, () => ({ text: 'comment with no @kento-review command', action: '' })],
  [/^comment of the App itself$/, () => ({ text: 'comment of Kentō itself', action: '' })],
  [/^(?:comment|delivery) already created a job$|^head already had a review job$/, () => ({ text: 'already handled, no second job', action: '' })],
  [/^repository is not enabled: the workflow keeps the command$/, () => ({ text: 'repo not enabled, the GitHub workflow keeps the command', action: '' })],
  [/^repository is not enabled$/, () => ({ text: 'repo not enabled', action: 'Enable it on the Repos screen so that it gets reviews.' })],
  [/^unknown repository$/, () => ({ text: 'repo unknown to Kentō', action: 'Add it to the installation of the App on GitHub.' })],
  [/^installation is suspended$/, () => ({ text: 'installation suspended on GitHub', action: 'Enable it again in the settings of the installation on GitHub.' })],
  [/^GitHub App is not configured$/, () => ({ text: 'the service has no GitHub App', action: 'Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY on the service.' })],
  [/^commands are not configured$/, () => ({ text: 'the service does not read the commands', action: 'Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY on the service.' })],
  [/^commenter cannot write to the repository$/, () => ({ text: 'the author of the comment cannot write to the repo', action: '' })],
  [/^no changed file under the paths of the config$/, () => ({ text: 'no changed file under the paths of the config', action: '' })],
  [/^trigger of the config is (\S+)$/, (m) => ({ text: `the config of the repo starts its reviews ${TRIGGER_TEXT[m[1]!] ?? m[1]}`, action: '' })],
  [/^(daily|monthly) cost limit of the org is reached$/, (m) => ({ text: `${COST_PERIOD[m[1]!]} cost cap of the organization reached`, action: 'An admin raises it in "Cost cap", above.' })],
  [/^monthly cost limit of the repository is reached$/, () => ({ text: 'monthly limit of the repo reached', action: 'An admin raises it in the config of the repo.' })],
]

/**
 * The reason of a webhook delivery, or null when it has none. A reason of 500 is the error of the
 * service; a reason of 400 says that GitHub sent what the service cannot read.
 */
export function deliveryReason(delivery: { status: number; outcome: string; reason: string | null }): Reason | null {
  let reason = delivery.reason?.trim() ?? ''
  if (delivery.outcome === 'failed' || delivery.status >= 500) {
    return { text: 'Kentō did not process the delivery', action: REPLAY, raw: reason ? sanitizeReason(reason) : null }
  }
  if (delivery.outcome === 'invalid' || delivery.status === 400) {
    // The same content gets the same 400: a replay changes nothing.
    return { text: 'GitHub sent a content that Kentō cannot read', action: INVALID, raw: reason ? sanitizeReason(reason) : null }
  }
  if (!reason) return null
  for (let [pattern, words] of DELIVERY_REASONS) {
    let match = pattern.exec(reason)
    if (match) return { ...words(match), raw: null }
  }
  return { text: 'a reason that Kentō does not translate', action: '', raw: sanitizeReason(reason) }
}

/** The error of the read of the App on GitHub (app/org-settings/app-status.ts). */
export function appStatusReason(error: string): Reason {
  let raw = sanitizeReason(error)
  let status = Number(/\banswered (\d{3})\b/.exec(error)?.[1] ?? 0)
  if (status === 401) return { text: 'GitHub refused the key of the App, code 401', action: 'Check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY on the service.', raw }
  if (status === 403) return { text: 'GitHub refuses the access of the App, code 403', action: 'Check the permissions of the App on GitHub, then reload the page.', raw }
  if (status === 404) return { text: 'GitHub does not find the installation of the App, code 404', action: 'Install the App on the organization again, then reload the page.', raw }
  if (status >= 500) return { text: `GitHub is unavailable, code ${status}`, action: 'Reload the page in a few minutes.', raw }
  return { text: 'GitHub does not answer about the App', action: 'Reload the page in a few minutes.', raw }
}

/** The reason as one sentence: « Text. Action. » */
export function reasonSentence(reason: Reason): string {
  let text = `${reason.text.charAt(0).toUpperCase()}${reason.text.slice(1)}.`
  return reason.action ? `${text} ${reason.action}` : text
}

/** The text of the service, folded under « Technical details ». Nothing when there is none. */
export function TechDetails(handle: Handle<{ raw: string | null }>) {
  return () =>
    handle.props.raw ? (
      <details class="tech-details">
        <summary>Technical details</summary>
        <code class="mono">{handle.props.raw}</code>
      </details>
    ) : null
}
