import { expect, test } from '@playwright/test'

import { expectNoAxeViolations, watchConsole } from './helpers.ts'

const SCREENS = [
  { path: '/', title: 'Tableau de bord' },
  { path: '/repos', title: 'Repos' },
  { path: '/findings', title: 'Findings' },
  { path: '/runners', title: 'Runners' },
  { path: '/settings', title: 'Réglages' },
]

test.describe('the frame of the screens', () => {
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
    let nav = page.getByRole('navigation', {
      name: testInfo.project.name === 'mobile' ? 'Navigation principale, mobile' : 'Navigation principale',
      exact: true,
    })
    await expect(nav).toBeVisible()
    await nav.getByRole('link', { name: 'Runners' }).click()
    await expect(page).toHaveURL(/\/runners$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Runners' })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Runners' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByText(/Kentō \d+\.\d+\.\d+ · par Sakuga/)).toBeVisible()
  })

  test('the theme applies at once, with no save, and stays on the next page', async ({ page }) => {
    await page.goto('/repos')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'system')
    let paper = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)

    let theme = page.getByRole('group', { name: 'Thème' }).locator('visible=true')
    await theme.getByText('Sumi', { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sumi')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(paper)
    // No « Appliquer » button with JavaScript: the click was enough.
    await expect(theme.getByRole('button', { name: 'Appliquer' })).toBeHidden()

    await page.goto('/findings')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sumi')
    await expect(page.getByRole('group', { name: 'Thème' }).locator('visible=true').getByRole('radio', { name: 'Sumi' })).toBeChecked()
  })

  test('« Appareil » follows the theme of the device', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    let theme = page.getByRole('group', { name: 'Thème' }).locator('visible=true')
    await theme.getByText('Papier', { exact: true }).click()
    let light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await theme.getByText('Appareil', { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'system')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(23, 22, 20)')
    expect(light).toBe('rgb(245, 240, 230)')
  })

  test('the mobile frame has a tab bar and no sidebar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'mobile only')
    await page.goto('/')
    await expect(page.locator('.sidebar')).toBeHidden()
    await expect(page.getByRole('navigation', { name: 'Navigation principale, mobile' })).toBeVisible()
    // Nothing is wider than the screen.
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false })

  test('the theme form applies the choice with « Appliquer »', async ({ page }) => {
    await page.goto('/runners')
    let theme = page.getByRole('group', { name: 'Thème' }).locator('visible=true')
    await theme.getByText('Sumi', { exact: true }).click()
    await theme.getByRole('button', { name: 'Appliquer' }).click()
    await expect(page).toHaveURL(/\/runners$/)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sumi')
  })
})
