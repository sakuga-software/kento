import { expect, test } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { expectNoAxeViolations, expectReadableButtons, signIn, watchConsole } from './helpers.ts'

// KNT-150: the name and the installations of the org. The name goes back at the end: the other
// specs read it.

async function restoreName() {
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
  try {
    await sql`update orgs set name = ${FAKE_ORG.login} where slug = ${FAKE_ORG.login}`
  } finally {
    await sql.end()
  }
}

test.describe('the name and the installations of the org (KNT-150)', () => {
  test.afterEach(restoreName)

  test('an owner renames the org from the menu, and sees the form that moves an installation', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'octocat')
    await page.goto('/repos')
    let menu = page.locator('details.org-menu')
    await menu.locator('summary').click()
    await menu.getByRole('link', { name: 'Name and installations' }).click()
    await expect(page).toHaveURL(/\/settings\/organization$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Organization' })).toBeVisible()
    let installation = page.locator('.installation', { hasText: FAKE_ORG.login })
    await installation.getByText('Move…').click()
    // The last installation of the org: the move says what goes with the org, and asks for its name.
    await expect(installation.getByText(`It is the last installation: ${FAKE_ORG.login} is deleted with the move`, { exact: false })).toBeVisible()
    await expect(installation.getByText('Its members from GitHub leave it:', { exact: false })).toBeVisible()
    await expect(installation.getByLabel(`Type ${FAKE_ORG.login} to confirm.`)).toBeVisible()
    await expectNoAxeViolations(page)
    await expectReadableButtons(page)

    await page.getByLabel('Name of the organization').fill('Sakuga Software')
    await page.getByRole('button', { name: 'Save the name' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Name saved.' })).toBeVisible()
    await expect(page.locator('.org-menu-name')).toHaveText('Sakuga Software')
    expect(errors).toEqual([])
  })

  test('a member reads the name and the installations, with no form', async ({ page }) => {
    await signIn(page, 'camille')
    await page.goto('/settings/organization')
    await expect(page.locator('.installation', { hasText: FAKE_ORG.login })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save the name' })).toHaveCount(0)
    await expect(page.getByText('Move…')).toHaveCount(0)
  })
})
