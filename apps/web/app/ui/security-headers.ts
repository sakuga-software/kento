import type { Middleware } from 'remix/router'

/**
 * The content security policy of the screens. Everything comes from the app itself: no inline
 * script, no inline style, no third-party origin except the avatars of GitHub.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ')

/** Adds the security headers of an HTML screen to its response, and keeps it out of shared caches. */
export function securityHeaders(): Middleware {
  return async (_context, next) => {
    let response = await next()
    let headers = new Headers(response.headers)
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('X-Frame-Options', 'DENY')
    headers.set('Referrer-Policy', 'same-origin')
    headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-store')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}
