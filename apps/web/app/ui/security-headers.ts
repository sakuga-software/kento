import { csp } from 'remix/middleware/csp'
import type { Middleware } from 'remix/router'

/**
 * The content security policy of the screens. Everything comes from the app itself: no inline
 * style, no third-party origin except the avatars of GitHub.
 *
 * KNT-163: one inline script, the import map of the components that hydrate, with the nonce of the
 * request (a new random value for each response, 128 bits). The modules come from `'self'`. No
 * other inline script runs: a nonce in the HTML of an attacker would have to guess it.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data: https://avatars.githubusercontent.com",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ')
}

/**
 * Makes the nonce of the request (`getCspNonce(context)`, which `render()` puts on the import map)
 * and sends the policy on every response of the screens, a redirect included.
 */
const policy = csp({ policy: ({ nonce }) => contentSecurityPolicy(nonce), filter: () => true })

/** Adds the security headers of an HTML screen to its response, and keeps it out of shared caches. */
export function securityHeaders(): Middleware {
  return (context, next) =>
    policy(context, async () => {
      let response = await next()
      let headers = new Headers(response.headers)
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('X-Frame-Options', 'DENY')
      headers.set('Referrer-Policy', 'same-origin')
      headers.set('Cross-Origin-Opener-Policy', 'same-origin')
      headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
      // A nonce must not be read by another person from a shared cache: never `public`.
      if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-store')
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    })
}
