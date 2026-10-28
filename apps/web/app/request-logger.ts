import type { Middleware } from 'remix/router'

import { errorMessage, log } from './log.ts'

/**
 * Logs one JSON line per request: method, path, status and duration. A successful `/healthz` is
 * not logged, because the container health check calls it every 30 seconds.
 */
export function requestLogger(): Middleware {
  return async (context, next) => {
    let start = performance.now()
    let { pathname } = new URL(context.request.url)
    try {
      let response = await next()
      if (!(pathname === '/healthz' && response.ok)) {
        log(response.status >= 500 ? 'error' : 'info', 'http.request', {
          method: context.request.method,
          path: pathname,
          status: response.status,
          durationMs: Math.round(performance.now() - start),
        })
      }
      return response
    } catch (error) {
      log('error', 'http.request', {
        method: context.request.method,
        path: pathname,
        status: 500,
        durationMs: Math.round(performance.now() - start),
        error: errorMessage(error),
      })
      throw error
    }
  }
}
