import type { ApplyWebhook, WebhookResult } from '../db/webhook-store.ts'
import { errorMessage, log } from '../log.ts'
import { commandFor, type EventPolicy } from './events.ts'
import { BodyTooLargeError, readBodyLimited } from './read-body.ts'
import { verifySignature } from './signature.ts'

/**
 * The largest body that the route reads. GitHub caps a payload at 25 MB, but the events of this route
 * stay far below: a pull request body has at most 65,536 characters, and the list of repositories of
 * an installation of 1,000 repositories weighs about 200 KB.
 */
export const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024

export interface WebhookDependencies extends EventPolicy {
  /** Null when `GITHUB_WEBHOOK_SECRET` is not set: the route then answers 503. */
  secret: string | null
  apply: ApplyWebhook
}

// GitHub sends a GUID. The check keeps a hostile value out of the logs and of the database.
const DELIVERY_ID = /^[0-9A-Za-z-]{1,64}$/
const EVENT_NAME = /^[a-z_]{1,64}$/

/**
 * `POST /webhooks/github`. In this order, and nothing else before the signature passes:
 *
 * 1. 503 without a secret, 400 without a valid `X-GitHub-Event` or `X-GitHub-Delivery`.
 * 2. 413 when the body is over the limit: the reader stops at the limit.
 * 3. 401 when `X-Hub-Signature-256` is missing or does not match the raw bytes of the body.
 * 4. Then only: JSON parse (400), the command, and the database.
 */
export async function handleGithubWebhook(request: Request, deps: WebhookDependencies): Promise<Response> {
  if (deps.secret === null) return text(503, 'webhook secret is not configured')

  let event = request.headers.get('X-GitHub-Event')
  let deliveryId = request.headers.get('X-GitHub-Delivery')
  if (event === null || !EVENT_NAME.test(event) || deliveryId === null || !DELIVERY_ID.test(deliveryId)) {
    return text(400, 'missing or invalid X-GitHub-Event or X-GitHub-Delivery')
  }

  let body: Uint8Array
  try {
    body = await readBodyLimited(request, MAX_WEBHOOK_BODY_BYTES)
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      log('warn', 'webhook.too_large', { githubEvent: event, deliveryId })
      return text(413, 'payload too large')
    }
    throw error
  }

  if (!verifySignature(deps.secret, body, request.headers.get('X-Hub-Signature-256'))) {
    log('warn', 'webhook.bad_signature', { githubEvent: event, deliveryId })
    return text(401, 'invalid signature')
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    log('warn', 'webhook.invalid', { githubEvent: event, deliveryId, reason: 'body is not JSON' })
    return text(400, 'body is not JSON')
  }

  let command = commandFor(event, payload, deps)
  // A signed body can still be `null` or an array: read `action` without trusting its shape.
  let action = typeof payload === 'object' && payload !== null ? (payload as { action?: unknown }).action : undefined
  let context = { githubEvent: event, action: typeof action === 'string' ? action.slice(0, 64) : null, deliveryId }

  if (command.type === 'invalid') {
    log('warn', 'webhook.invalid', { ...context, reason: command.reason })
    return Response.json({ outcome: 'invalid', reason: command.reason }, { status: 400 })
  }
  if (command.type === 'ping') {
    log('info', 'webhook.ping', context)
    return Response.json({ outcome: 'pong' })
  }
  if (command.type === 'ignore') {
    log('info', 'webhook.ignored', { ...context, reason: command.reason })
    return Response.json({ outcome: 'ignored', reason: command.reason }, { status: 202 })
  }

  let result: WebhookResult
  try {
    result = await deps.apply(command, deliveryId)
  } catch (error) {
    // 500: GitHub marks the delivery as failed, and « Redeliver » sends it again.
    log('error', 'webhook.failed', { ...context, command: command.type, error: errorMessage(error) })
    return text(500, 'webhook could not be applied')
  }
  log('info', 'webhook.applied', { ...context, command: command.type, ...result })
  return Response.json(result, { status: 202 })
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
