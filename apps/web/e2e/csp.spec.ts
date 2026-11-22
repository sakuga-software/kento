import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { SIGNED_IN_SCREENS, SIGNED_OUT_SCREENS } from './csp-screens.ts'
import { hydrated, signIn } from './helpers.ts'
import { PULL_NUMBER, seedPull } from './pull-seed.ts'

// KNT-171. No screen breaks its own content security policy: no inline style, no inline script
// but the import map with its nonce. Under WebKit too (the project `webkit` of playwright.config.ts
// runs this file only), where the policy once looked broken on /settings and /findings: that was a
// fault of an old WebKit build, which refused the shadow tree of every native <select> (one refusal
// per select, on a bare page as well); the WebKit of this Playwright does not.
// Every screen of the app is visited (e2e/csp-screens.ts; app/csp-screens.test.ts checks the list
// against the routes), signed in or not, after its components hydrated, with its selects and menus
// opened. The page keeps the `securitypolicyviolation` events in a list that the test reads before
// it leaves; the console lines of the browser are the backstop.

/** Every refusal of the policy on the pages of `page`. */
async function watchPolicy(page: Page) {
  let refusals: string[] = []
  await page.addInitScript(() => {
    let found: string[] = []
    ;(window as unknown as { cspRefusals: string[] }).cspRefusals = found
    document.addEventListener('securitypolicyviolation', (event) => {
      found.push(`${location.pathname}${location.search} ${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`)
    })
  })
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to (apply|execute|load)/.test(message.text())) refusals.push(`console: ${message.text()}`)
  })

  /**
   * Opens `path`, which must answer `status` with no redirect (a screen that starts to redirect, or
   * to fail, is not checked any more: it fails the test). Waits for its components to hydrate (a
   * style set by hydration must be read), opens its selects and its menus "…", then adds the
   * refusals of the page, once the events of its last actions are out.
   */
  let visit = async (path: string, status = 200) => {
    let response = await page.goto(path)
    expect(response?.status(), `the status of ${path}`).toBe(status)
    let arrived = new URL(page.url())
    expect(arrived.pathname + arrived.search, `${path} with no redirect`).toBe(path)
    if (await page.locator('#rmx-data, html[data-hydrated]').count()) await hydrated(page)
    for (let opener of await page.locator('button[aria-haspopup="listbox"]:not([disabled]), button.row-menu-trigger').all()) {
      if (!(await opener.isVisible())) continue
      await opener.click()
      // An open list or menu takes the focus; Escape goes to it and closes it.
      await expect(page.locator(':popover-open [role="listbox"], :popover-open [role="menu"]')).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.locator(':popover-open')).toHaveCount(0)
    }
    let { at, found } = await page.evaluate(
      () =>
        new Promise<{ at: string; found: string[] | undefined }>((resolve) =>
          requestAnimationFrame(() =>
            setTimeout(() => resolve({ at: location.pathname + location.search, found: (window as unknown as { cspRefusals?: string[] }).cspRefusals }), 0),
          ),
        ),
    )
    // Kentō #109d70: still the screen, with its list: a page left early fails rather than losing its refusals.
    expect(at, 'the page in view').toBe(path)
    expect(Array.isArray(found), `the list of refusals of ${path}`).toBe(true)
    refusals.push(...found!)
  }
  return { refusals, visit }
}

test.describe('the content security policy holds on every screen (KNT-171)', () => {
  test('no refusal on any screen, signed in or not, with its selects and menus opened', async ({ page, browser, baseURL }) => {
    let { refusals, visit } = await watchPolicy(page)
    await signIn(page, 'octocat')
    // The repository, the pull request and the findings of e2e/pull.spec.ts: every screen has content.
    let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
    let seeded = await seedPull(sql).finally(() => sql.end())
    let paths: Record<(typeof SIGNED_IN_SCREENS)[number], string> = {
      '/': '/',
      '/repos': '/repos',
      '/repos/:id/config': `/repos/${seeded.repoId}/config`,
      '/repos/:id/pulls/:number': `/repos/${seeded.repoId}/pulls/${PULL_NUMBER}`,
      '/findings': '/findings',
      '/findings/:id': `/findings/${seeded.findings.A}`,
      '/runners': '/runners',
      '/costs': '/costs',
      '/settings': '/settings',
      '/settings/members': '/settings/members',
      '/settings/organization': '/settings/organization',
      '/users/:login': '/users/octocat',
      '/feedback': '/feedback',
      '/invitations': '/invitations',
    }
    for (let screen of SIGNED_IN_SCREENS) await visit(paths[screen])
    // The tab "Precision" of Findings is a screen of its own.
    await visit('/findings?view=precision')

    // With no session: the sign-in page, the documentation, and the page "not found".
    let context = await browser.newContext({ baseURL })
    let guest = await watchPolicy(await context.newPage())
    let guestPaths: Record<(typeof SIGNED_OUT_SCREENS)[number], [string, number]> = {
      '/login': ['/login', 200],
      '/docs/commands': ['/docs/commands', 200],
      '/*path': ['/no-such-screen', 404],
    }
    for (let screen of SIGNED_OUT_SCREENS) await guest.visit(...guestPaths[screen])
    await context.close()

    expect([...refusals, ...guest.refusals]).toEqual([])
  })
})
