import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { hydrated, signIn } from './helpers.ts'

// KNT-171. No screen breaks its own content security policy: no inline style, no inline script
// but the import map with its nonce. Under WebKit too (the project `webkit` of playwright.config.ts
// runs this file only), where the policy once looked broken on /settings and /findings: that was a
// fault of an old WebKit build, which refused the shadow tree of every native <select> (one refusal
// per select, on a bare page as well); the WebKit of this Playwright does not.
// The page listens to `securitypolicyviolation`, which the browser fires for every refusal; the
// console of WebKit also says "Refused to apply…", and that is checked too.

/** Findings on orchard, so that Findings shows its filters (its selects). */
async function seed() {
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
  try {
    let [org] = await sql<{ id: string }[]>`select org_id as id from installations where github_installation_id = ${FAKE_ORG.installationId}`
    await sql`
      insert into repos (org_id, installation_id, github_repo_id, full_name)
      values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 7001, 'sakuga-software/orchard')
      on conflict (github_repo_id) do nothing`
    await sql`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, first_seen_sha, last_seen_sha)
      select id, 1, 'knt-171', 'knt-171', 'a.ts', 1, 'A finding for KNT-171', 'minor', 'bug', 80, 'open', ${'a'.repeat(40)}, ${'a'.repeat(40)}
      from repos where github_repo_id = 7001 on conflict do nothing`
  } finally {
    await sql.end()
  }
}

async function unseed() {
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
  try {
    await sql`delete from findings where fingerprint = 'knt-171'`
  } finally {
    await sql.end()
  }
}

/**
 * Every refusal of the policy: the page keeps the `securitypolicyviolation` events in a list, which
 * `collect()` reads before the test leaves the page (Kentō #0413d5: no call out of the page that a
 * navigation could cut), and the console lines of the browser are the backstop.
 */
async function watchPolicy(page: Page) {
  let refusals: string[] = []
  await page.addInitScript(() => {
    let found: string[] = []
    ;(window as unknown as { cspRefusals: string[] }).cspRefusals = found
    document.addEventListener('securitypolicyviolation', (event) => {
      found.push(`${location.pathname} ${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`)
    })
  })
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to (apply|execute|load)/.test(message.text())) refusals.push(`console: ${message.text()}`)
  })
  /**
   * Adds the refusals of the page in view, once the events of its last actions are out. Kentō
   * #109d70: the page must still be the one of `path`, with its list: a page left or a list that
   * the init script did not make fails the test, instead of losing its refusals.
   */
  let collect = async (path: string) => {
    let { at, found } = await page.evaluate(
      () =>
        new Promise<{ at: string; found: string[] | undefined }>((resolve) =>
          requestAnimationFrame(() =>
            setTimeout(() => resolve({ at: location.pathname + location.search, found: (window as unknown as { cspRefusals?: string[] }).cspRefusals }), 0),
          ),
        ),
    )
    expect(at, 'the page in view').toBe(path)
    expect(Array.isArray(found), `the list of refusals of ${path}`).toBe(true)
    refusals.push(...found!)
  }
  return { refusals, collect }
}

test.describe('the content security policy holds on every screen (KNT-171)', () => {
  test.afterEach(unseed)

  test('no refusal on /settings, /findings and the other screens, with their selects opened', async ({ page }) => {
    let { refusals, collect } = await watchPolicy(page)
    await signIn(page, 'octocat')
    await seed()
    for (let path of ['/settings', '/findings', '/findings?view=precision', '/repos', '/', '/users/octocat', '/feedback', '/runners', '/settings/members']) {
      await page.goto(path)
      await page.waitForLoadState('load')
      if (path === '/settings' || path === '/findings') {
        await hydrated(page)
        // The selects of the screen: each one draws its list, a popover placed by script.
        let selects = page.locator('button[aria-haspopup="listbox"]:not([disabled])')
        expect(await selects.count(), path).toBeGreaterThan(0)
        for (let select of await selects.all()) {
          if (!(await select.isVisible())) continue
          await select.click()
          // The list takes the focus once it is open; Escape goes to it.
          await expect(page.locator('.select-popover:popover-open [role="listbox"]')).toBeFocused()
          await page.keyboard.press('Escape')
          await expect(page.locator('.select-popover:popover-open')).toHaveCount(0)
        }
      }
      await collect(path)
    }
    expect(refusals).toEqual([])
  })
})
