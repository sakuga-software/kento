// KNT-171. The screens that e2e/csp.spec.ts visits, by the pattern of their route in app/routes.ts.
// app/csp-screens.test.ts compares this list with the GET routes of the app: a new screen that is
// not here, nor in NOT_SCREENS, fails it.

/** Screens visited by a member of the org (octocat, an owner). */
export const SIGNED_IN_SCREENS = [
  '/',
  '/repos',
  '/repos/:id/config',
  '/repos/:id/pulls/:number',
  '/findings',
  '/findings/:id',
  '/runners',
  '/costs',
  '/settings',
  '/settings/members',
  '/settings/organization',
  '/users/:login',
  '/feedback',
  '/invitations',
] as const

/** Screens visited with no session. `/*path` is the page "not found", which answers 404. */
export const SIGNED_OUT_SCREENS = ['/login', '/docs/commands', '/*path'] as const

/** The GET routes that render no screen of their own, and why. */
export const NOT_SCREENS: Record<string, string> = {
  '/healthz': 'the JSON of the health check',
  '/login/github': 'a redirect to GitHub',
  '/auth/github/callback': 'the return from GitHub, a redirect',
  '/docs/commandes': 'a permanent redirect to /docs/commands',
}
