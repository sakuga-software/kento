// Fixtures for the tests of the webhook. The secret is a test value, never a real one.
import type { ApplyWebhook, StoreCommand, WebhookResult } from '../db/webhook-store.ts'
import { sign } from './signature.ts'
import type { WebhookDependencies } from './webhook.ts'

export const TEST_SECRET = 'test-webhook-secret-0123456789abcdef0123456789'

export const REPO = { id: 3001, full_name: 'sakuga-software/sakuga-review', owner: { id: 2001, login: 'sakuga-software' } }

/** The router of a test that does not call the webhook. */
export const disabledWebhook: WebhookDependencies = {
  secret: null,
  trustedBots: new Set(),
  apply: () => Promise.reject(new Error('the webhook is disabled in this test')),
}

/** A store that records its calls and answers `result`. */
export function spyStore(result: WebhookResult = { outcome: 'queued', jobId: 'job-1', cancelled: 0 }) {
  let calls: { command: StoreCommand; deliveryId: string }[] = []
  let apply: ApplyWebhook = async (command, deliveryId) => {
    calls.push({ command, deliveryId })
    return result
  }
  return { calls, apply }
}

export function webhookDeps(apply: ApplyWebhook, overrides: Partial<WebhookDependencies> = {}): WebhookDependencies {
  return {
    secret: TEST_SECRET,
    trustedBots: new Set(['sakuga-agent[bot]']),
    apply,
    ...overrides,
  }
}

export function headSha(n: number): string {
  return n.toString(16).padStart(40, '0')
}

/** The payload of a `pull_request` event, as GitHub sends it to an App, with the fields we read. */
export function pullRequestPayload(
  options: {
    action?: string
    number?: number
    head?: string
    draft?: boolean
    sender?: { login: string; type: string }
    author?: { login: string; type: string }
    headRepoId?: number | null
    repo?: typeof REPO
  } = {},
) {
  let repo = options.repo ?? REPO
  let headRepoId = options.headRepoId === undefined ? repo.id : options.headRepoId
  return {
    action: options.action ?? 'synchronize',
    number: options.number ?? 24,
    pull_request: {
      number: options.number ?? 24,
      draft: options.draft ?? false,
      user: options.author ?? { login: 'alex', type: 'User' },
      head: { sha: options.head ?? headSha(1), ref: 'feature', repo: headRepoId === null ? null : { id: headRepoId } },
      base: { sha: headSha(999), ref: 'main', repo: { id: repo.id } },
    },
    repository: repo,
    sender: options.sender ?? { login: 'alex', type: 'User' },
    installation: { id: 1001, node_id: 'MDIz' },
  }
}

export interface SignedRequestOptions {
  event?: string
  deliveryId?: string | null
  secret?: string
  signature?: string | null
  body?: string
}

/** A request as GitHub sends it: JSON body, event, delivery id, and the signature of the body. */
export function signedRequest(payload: unknown, options: SignedRequestOptions = {}): Request {
  let body = options.body ?? JSON.stringify(payload)
  let headers = new Headers({ 'Content-Type': 'application/json', 'X-GitHub-Event': options.event ?? 'pull_request' })
  let deliveryId = options.deliveryId === undefined ? 'd0000000-0000-0000-0000-000000000001' : options.deliveryId
  if (deliveryId !== null) headers.set('X-GitHub-Delivery', deliveryId)
  let signature = options.signature === undefined ? sign(options.secret ?? TEST_SECRET, body) : options.signature
  if (signature !== null) headers.set('X-Hub-Signature-256', signature)
  return new Request('http://localhost/webhooks/github', { method: 'POST', headers, body })
}

/** The payload of an `issue_comment` event on a pull request, with the fields we read. */
export function issueCommentPayload(
  options: {
    action?: string
    body?: string
    number?: number
    commentId?: number
    user?: { login: string; type: string }
    sender?: { login: string; type: string }
    state?: string
    onPullRequest?: boolean
    repo?: typeof REPO
  } = {},
) {
  let user = options.user ?? { login: 'alex', type: 'User' }
  return {
    action: options.action ?? 'created',
    issue: {
      number: options.number ?? 28,
      state: options.state ?? 'open',
      ...(options.onPullRequest === false ? {} : { pull_request: { url: 'https://api.github.com/repos/x/y/pulls/28' } }),
    },
    comment: { id: options.commentId ?? 9001, body: options.body ?? '@kento review heavy', user },
    repository: options.repo ?? REPO,
    sender: options.sender ?? user,
    installation: { id: 1001, node_id: 'MDIz' },
  }
}
