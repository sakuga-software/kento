import { expect, test } from '@playwright/test'

import { expectNoAxeViolations, expectReadableButtons, signIn, watchConsole } from './helpers.ts'

// The end-to-end test of REV-8: an admin, a member, a person outside of the org, and the way out.

test('an admin of the org gets the full frame, with no "Read only"', async ({ page }) => {
  let errors = watchConsole(page)
  await signIn(page, 'octocat')

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  let who = page.locator('.who').locator('visible=true')
  await expect(who).toContainText('octocat')
  await expect(who).toContainText('Admin')
  await expect(page.getByText('Read only', { exact: true })).toHaveCount(0)
  await expect(page.locator('.bar-org-box')).toHaveText('sakuga-software')
  await expectNoAxeViolations(page)
  expect(errors).toEqual([])
})

test('a member sees "Read only" on every screen', async ({ page }) => {
  await signIn(page, 'camille')

  for (let path of ['/', '/repos', '/settings']) {
    await page.goto(path)
    await expect(page.getByRole('status')).toContainText('Read only You are a member of sakuga-software')
    await expect(page.locator('.page-actions')).toHaveCount(0)
  }
  await expect(page.locator('.who').locator('visible=true')).toContainText('Member')
  await expectNoAxeViolations(page)
})

test('a person outside of the org cannot sign in', async ({ page, context }) => {
  await signIn(page, 'stranger')

  await expect(page).toHaveURL(/\/login\?notice=not_member$/)
  await expect(page.getByRole('alert')).toContainText('Access refused.')
  // REV-32: the page names the account that GitHub gave, and offers two ways out.
  await expect(page.getByRole('alert')).toContainText('Signed in to GitHub as @stranger')
  await expect(page.getByRole('link', { name: 'Switch GitHub account' })).toHaveAttribute('href', '/login/github?switch=1')
  await expect(page.getByRole('link', { name: /Install Kentō on an organization/ })).toHaveAttribute('href', /\/apps\/kento-review\/installations\/new$/)
  // The pending sign-in is dropped: the session cookie is emptied.
  expect((await context.cookies()).filter((c) => c.name.includes('kento_session') && c.value !== '')).toEqual([])
  await page.goto('/repos')
  await expect(page).toHaveURL(/\/login\?returnTo=%2Frepos$/)
  await expectNoAxeViolations(page)
})

test('a screen asked before the sign-in opens after it', async ({ page }) => {
  await page.goto('/runners')
  await expect(page).toHaveURL(/\/login\?returnTo=%2Frunners$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Kentō' })).toBeVisible()
  await expectNoAxeViolations(page)
  await page.getByRole('link', { name: 'Continue with GitHub' }).click()
  await page.getByRole('link', { name: 'Authorize as octocat' }).click()
  await expect(page).toHaveURL(/\/runners$/)
})

test('sign out ends the session', async ({ page }) => {
  await signIn(page, 'octocat')
  await page.locator('.who').getByRole('button', { name: 'Sign out' }).click()

  await expect(page).toHaveURL(/\/login\?notice=signed_out$/)
  await expect(page.getByRole('alert')).toContainText('You are signed out.')
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
})

test('the sign-in page passes axe in Sumi', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'kento_theme', value: 'sumi', url: baseURL! }])
  await page.goto('/login?notice=not_member')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sumi')
  await expectNoAxeViolations(page)
})

// KNT-143: a link that looks like a primary button keeps the colour of its text, in both themes.
for (let theme of ['paper', 'sumi'] as const) {
  test(`the buttons that are links are readable on the sign-in page, the dashboard and a missing page (${theme})`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])
    await page.goto('/login')
    let start = page.getByRole('link', { name: 'Continue with GitHub' })
    await expect(start).toBeVisible()
    await expect(start).toHaveClass(/button--primary/)
    await expectReadableButtons(page)
    await signIn(page, 'octocat')
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    await expectReadableButtons(page)
    await page.goto('/no-such-page')
    await expect(page.getByRole('link', { name: 'Back to the dashboard' })).toHaveClass(/button--primary/)
    await expectReadableButtons(page)
  })
}

