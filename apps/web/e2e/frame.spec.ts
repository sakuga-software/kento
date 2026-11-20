import { expect, test } from '@playwright/test'

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
