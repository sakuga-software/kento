import { expect, test, type Locator, type Page } from '@playwright/test'

import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { expectNoAxeViolations, signIn, watchConsole } from './helpers.ts'

const SCREENS = [
  { path: '/', title: 'Dashboard' },
  { path: '/repos', title: 'Repos' },
  { path: '/findings', title: 'Findings' },
  { path: '/feedback', title: 'Feedback' },
  { path: '/runners', title: 'Runners' },
  { path: '/settings', title: 'Settings' },
]

test.describe('the frame of the screens', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'octocat')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  })

  for (let theme of ['paper', 'sumi'] as const) {
    test(`every screen passes axe in the theme ${theme}`, async ({ page, context, baseURL }) => {
      let errors = watchConsole(page)
      await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])
      for (let screen of SCREENS) {
        await page.goto(screen.path)
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        await expect(page.getByRole('heading', { level: 1, name: screen.title })).toBeVisible()
        await expectNoAxeViolations(page)
      }
      expect(errors).toEqual([])
    })
  }

  test('the navigation leads to each screen and marks it', async ({ page }, testInfo) => {
    await page.goto('/')
    let nav = page.getByRole('navigation', { name: 'Main navigation', exact: true })
    await expect(nav).toBeVisible()
    // REV-91: under 760 px, "Menu" opens the list of the screens.
    if (testInfo.project.name === 'mobile') await nav.getByRole('button', { name: 'Menu' }).click()
    await nav.getByRole('link', { name: 'Runners' }).click()
    await expect(page).toHaveURL(/\/runners$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Runners' })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Runners', includeHidden: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByText(/Kentō \d+\.\d+\.\d+ · by Sakuga/)).toBeVisible()
  })

  // REV-91: the tiles of the screen of a user keep their grid after the redesign of the dashboard.
  test('the screen of a user lays its tiles out as a grid', async ({ page }) => {
    await page.goto('/users/octocat')
    let tiles = page.locator('.dash-tiles').first()
    await expect(tiles).toBeVisible()
    expect(await tiles.evaluate((el) => getComputedStyle(el).display)).toBe('grid')
    expect(await page.locator('.dash-tile').first().evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid')
  })

  // KNT-142: the theme is on the screen of the user, reached from the avatar of the bar, and no longer in the foot.
  test('the theme applies at once from the screen of the user, with no save, and stays on the next page', async ({ page }) => {
    await page.goto('/repos')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'system')
    await expect(page.locator('footer').getByRole('group', { name: 'Theme' })).toHaveCount(0)
    let paper = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)

    await page.getByRole('link', { name: 'octocat, your preferences' }).click()
    await expect(page).toHaveURL(/\/users\/octocat$/)
    let section = page.getByRole('region', { name: 'Theme' })
    let theme = section.getByRole('group', { name: 'Theme of this browser' })
    await theme.getByText('Sumi', { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sumi')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(paper)
    // No "Apply" button with JavaScript: the click was enough.
    await expect(section.getByRole('button', { name: 'Apply' })).toBeHidden()

    await page.goto('/findings')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sumi')
    await page.goto('/users/octocat')
    await expect(page.getByRole('group', { name: 'Theme of this browser' }).getByRole('radio', { name: 'Sumi' })).toBeChecked()
  })

  test('"Device" follows the theme of the device', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/users/octocat')
    let theme = page.getByRole('group', { name: 'Theme of this browser' })
    await theme.getByText('Paper', { exact: true }).click()
    let light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await theme.getByText('Device', { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'system')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(21, 20, 19)')
    expect(light).toBe('rgb(243, 242, 238)')
  })

  test('the mobile frame folds the screens under "Menu", which Escape closes', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile only')
    await page.goto('/')
    let nav = page.getByRole('navigation', { name: 'Main navigation', exact: true })
    let menu = nav.getByRole('button', { name: 'Menu' })
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
    await expect(nav.getByRole('link', { name: 'Repos', exact: true })).toBeHidden()
    await menu.click()
    await expect(menu).toHaveAttribute('aria-expanded', 'true')
    await expect(nav.getByRole('link', { name: 'Repos', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
    await expect(menu).toBeFocused()
    // A click on the icon of the button opens it; a click outside of the bar closes it.
    await menu.locator('svg').click()
    await expect(menu).toHaveAttribute('aria-expanded', 'true')
    // The open list covers the top of the page: the click lands lower, on the page itself.
    await page.mouse.click(195, 800)
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
    await expect(nav.getByRole('link', { name: 'Repos', exact: true })).toBeHidden()
    // Nothing is wider than the screen.
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

// KNT-172. The page transition of KNT-145 must not eat a tap: during it, every press lands on <html>
// (the browser draws the pages over it), and transition.js gives the tap to the element under it. The
// test makes the transition last 2 s, so that the tap lands inside it for sure, and taps a fixed point
// with a real pointer: the click of a locator would retry until the transition ends, and hide the defect.
test.describe('a tap during the page transition (KNT-172)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      let state = window as unknown as { transition: 'none' | 'running' | 'done' }
      state.transition = 'none'
      window.addEventListener('pagereveal', (event) => {
        let transition = (event as Event & { viewTransition: ViewTransition | null }).viewTransition
        if (!transition) return
        state.transition = 'running'
        void transition.finished.finally(() => (state.transition = 'done'))
      })
    })
    // The transition lasts 2 s here, not 150 ms, so that a tap lands inside it for sure. The rule
    // rides on kento.css itself: an element added by a script at the start of the document could come
    // too late, and leave the test racing 150 ms (KNT-172, red on CI once).
    await page.route(/\/assets\/kento\.css/, async (route) => {
      let response = await route.fetch()
      await route.fulfill({ response, body: `${await response.text()}\n::view-transition-group(root) { animation-duration: 2s !important }\n` })
    })
    await signIn(page, 'octocat')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  })

  /** One finding, so that Findings shows its filters, its search field and a row with a checkbox. */
  async function withFinding(run: () => Promise<void>) {
    let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
    try {
      let [org] = await sql<{ id: string }[]>`select org_id as id from installations where github_installation_id = ${FAKE_ORG.installationId}`
      await sql`
        insert into repos (org_id, installation_id, github_repo_id, full_name)
        values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 7001, 'sakuga-software/orchard')
        on conflict (github_repo_id) do nothing`
      await sql`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, first_seen_sha, last_seen_sha)
        select id, 1, 'knt-172', 'knt-172', 'a.ts', 1, 'A finding for KNT-172', 'minor', 'bug', 80, 'open', ${'a'.repeat(40)}, ${'a'.repeat(40)}
        from repos where github_repo_id = 7001 on conflict do nothing`
      await run()
    } finally {
      await sql`delete from findings where fingerprint = 'knt-172'`
      await sql.end()
    }
  }

  /** A navigation from a script, as from a link: the browser runs the transition (an entry in the address bar would not). */
  async function goDuringTransition(page: Page, path: string) {
    await page.evaluate((to) => (location.href = to), path)
    await page.waitForFunction(() => (window as unknown as { transition: string }).transition === 'running')
    // The slow rule applies: the fade of the page lasts 2 s.
    expect(await page.evaluate(() => Math.max(...document.getAnimations().map((animation) => Number(animation.effect?.getTiming().duration) || 0)))).toBe(2000)
  }

  /**
   * Presses the middle of the element while the transition runs: a touch on mobile, else the mouse
   * with a real gap between press and release. A fixed point, not a locator click, which would retry.
   */
  async function tapDuringTransition(page: Page, locator: Locator, mobile: boolean) {
    let box = (await locator.boundingBox())!
    let x = box.x + box.width / 2
    let y = box.y + box.height / 2
    expect(await page.evaluate(() => (window as unknown as { transition: string }).transition)).toBe('running')
    // The defect: the browser sends the press to <html>, not to the element.
    expect(await page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.tagName, [x, y])).toBe('HTML')
    if (mobile) return page.touchscreen.tap(x, y)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.waitForTimeout(100)
    await page.mouse.up()
  }

  test('a tap right after a navigation reaches its target, while the transition still runs', async ({ page }, testInfo) => {
    await goDuringTransition(page, '/findings')
    await tapDuringTransition(page, page.getByRole('link', { name: 'Precision', exact: true }), testInfo.project.name === 'mobile')
    await expect(page).toHaveURL(/view=precision/)
  })

  test('a tap on the logo, an SVG in its link, leads home', async ({ page }, testInfo) => {
    await goDuringTransition(page, '/findings')
    await tapDuringTransition(page, page.getByRole('link', { name: 'Kentō, dashboard' }), testInfo.project.name === 'mobile')
    await expect(page).toHaveURL(/\/$/)
  })

  test('a tap on a field during the transition gives it the focus', async ({ page }, testInfo) => {
    await withFinding(async () => {
      await goDuringTransition(page, '/findings')
      let search = page.locator('#findings-q')
      await tapDuringTransition(page, search, testInfo.project.name === 'mobile')
      await expect(search).toBeFocused()
      // The tap ends the transition at once.
      await expect.poll(() => page.evaluate(() => (window as unknown as { transition: string }).transition)).toBe('done')
    })
  })

  test('a tap on a checkbox checks it once: no second click undoes it', async ({ page }, testInfo) => {
    await withFinding(async () => {
      await goDuringTransition(page, '/findings')
      let check = page.getByRole('checkbox', { name: 'Select "A finding for KNT-172"' })
      await tapDuringTransition(page, check, testInfo.project.name === 'mobile')
      await expect(check).toBeChecked()
      await page.waitForTimeout(300)
      await expect(check).toBeChecked()
    })
  })

  test('a Ctrl or Cmd click during the transition opens the link in a new tab, and the page stays', async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'a mouse with a modifier key')
    await goDuringTransition(page, '/findings')
    let opened = context.waitForEvent('page')
    await page.keyboard.down('ControlOrMeta')
    await tapDuringTransition(page, page.getByRole('link', { name: 'Precision', exact: true }), false)
    await page.keyboard.up('ControlOrMeta')
    let tab = await opened
    await tab.waitForLoadState()
    expect(tab.url()).toMatch(/view=precision/)
    expect(new URL(page.url()).search).toBe('')
    await tab.close()
  })

  test('the page still has its transition, and none under reduced motion', async ({ page }) => {
    await page.evaluate(() => (location.href = '/findings'))
    await expect(page.getByRole('heading', { level: 1, name: 'Findings' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as unknown as { transition: string }).transition)).not.toBe('none')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(() => (location.href = '/repos'))
    await expect(page.getByRole('heading', { level: 1, name: 'Repos' })).toBeVisible()
    await page.waitForLoadState('load')
    expect(await page.evaluate(() => (window as unknown as { transition: string }).transition)).toBe('none')
  })
})

// REV-40. A 404 keeps the frame of Kentō, in French, with a way out.
test.describe('a page that does not exist', () => {
  for (let theme of ['paper', 'sumi'] as const) {
    test(`an unknown repository and an unknown page answer 404 in the frame, and pass axe (${theme})`, async ({ page, context, baseURL }) => {
      await signIn(page, 'octocat')
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
      let errors = watchConsole(page)
      await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])

      let config = await page.goto('/repos/00000000-0000-0000-0000-000000000000/config')
      expect(config?.status()).toBe(404)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.getByRole('heading', { level: 1, name: 'This repo is no longer in the installation' })).toBeVisible()
      await expectNoAxeViolations(page)
      await page.getByRole('main').getByRole('link', { name: 'See the repos' }).click()
      await expect(page).toHaveURL(/\/repos$/)
      await expect(page.getByRole('heading', { level: 1, name: 'Repos' })).toBeVisible()

      let unknown = await page.goto('/nope')
      expect(unknown?.status()).toBe(404)
      await expect(page.getByRole('heading', { level: 1, name: 'This page does not exist' })).toBeVisible()
      await expectNoAxeViolations(page)
      await page.getByRole('main').getByRole('link', { name: 'Back to the dashboard' }).click()
      await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()

      // The two 404 are on purpose; nothing else may fail.
      expect(errors.filter((e) => !e.includes('status of 404'))).toEqual([])
    })
  }

  test('a person who is not signed in gets the 404 too, with the sign-in as the way out', async ({ page }) => {
    let response = await page.goto('/nope')
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { level: 1, name: 'This page does not exist' })).toBeVisible()
    await expectNoAxeViolations(page)
    await page.getByRole('link', { name: 'Sign in to Kentō' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Kentō' })).toBeVisible()
  })
})

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false })

  test('the theme form of the screen of the user applies the choice with "Apply" (KNT-142)', async ({ page }) => {
    await signIn(page, 'octocat')
    await page.goto('/users/octocat')
    let section = page.getByRole('region', { name: 'Theme' })
    // "Apply" stands next to the choices, not under them by the hint.
    let apply = (await section.getByRole('button', { name: 'Apply' }).boundingBox())!
    let choices = (await section.locator('.segmented').boundingBox())!
    expect(Math.abs(apply.y + apply.height / 2 - (choices.y + choices.height / 2))).toBeLessThan(2)
    await section.getByText('Sumi', { exact: true }).click()
    await section.getByRole('button', { name: 'Apply' }).click()
    await expect(page).toHaveURL(/\/users\/octocat$/)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sumi')
    await page.goto('/runners')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sumi')
  })
})
