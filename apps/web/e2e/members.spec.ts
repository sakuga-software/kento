import { expect, test } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { chooseOption, expectNoAxeViolations, expectReadableButtons, hydrated, signIn, watchConsole } from './helpers.ts'

// KNT-150: the members of an org and its invitations. Visitor is an account that GitHub counts in no
// org of the App: an invitation is their only way in.

/** Visitor has no membership and no invitation: each run starts from there. */
async function forgetVisitor() {
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
  try {
    await sql`delete from invitations where github_login = 'visitor'`
    await sql`delete from memberships where user_id in (select id from users where login = 'visitor')`
  } finally {
    await sql.end()
  }
}

test.describe('the members and the invitations (KNT-150)', () => {
  test('an owner invites a GitHub login; the person signs in, sees only the invitation, and accepts it', async ({ browser, page }) => {
    let errors = watchConsole(page)
    await forgetVisitor()
    await signIn(page, 'octocat')
    await page.goto('/repos')
    let menu = page.locator('details.org-menu')
    await menu.locator('summary').click()
    await menu.getByRole('link', { name: 'Members' }).click()
    await expect(page).toHaveURL(/\/settings\/members$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible()
    // The only owner has no form to change their own role.
    let self = page.locator('.member', { hasText: 'octocat' })
    await expect(self.getByText('Owner', { exact: true })).toBeVisible()
    // KNT-165: a role is a select of @remix-run/ui once hydrated (a button with a listbox).
    await hydrated(page)
    await expect(self.locator('select, [aria-haspopup="listbox"]')).toHaveCount(0)
    await expectNoAxeViolations(page)
    await expectReadableButtons(page)

    await page.getByLabel('GitHub login').fill('visitor')
    await chooseOption(page, 'Role', 'member')
    await page.getByRole('button', { name: 'Invite', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Invitation sent.' })).toBeVisible()
    let invitations = page.locator('section', { has: page.getByRole('heading', { name: /Invitations/ }) })
    await expect(invitations.locator('.member', { hasText: 'visitor' })).toContainText('By octocat')

    // Visitor, in another browser: the invitation is the only page.
    let other = await browser.newContext()
    let visitor = await other.newPage()
    let visitorErrors = watchConsole(visitor)
    await signIn(visitor, 'visitor')
    await expect(visitor).toHaveURL(/\/invitations$/)
    await expect(visitor.getByRole('heading', { level: 1, name: 'Invitations' })).toBeVisible()
    await expect(visitor.locator('.invitation')).toContainText(FAKE_ORG.login)
    await expectNoAxeViolations(visitor)
    await visitor.goto('/repos')
    await expect(visitor).toHaveURL(/\/invitations$/)
    await visitor.getByRole('button', { name: `Accept and open ${FAKE_ORG.login}` }).click()
    await expect(visitor).toHaveURL(/\/$/)
    await expect(visitor.locator('.org-menu-name')).toHaveText(FAKE_ORG.login)
    await expect(visitor.getByText('Read only', { exact: true })).toBeVisible()
    await other.close()

    // The owner sees visitor as a member from an invitation, and removes them.
    await page.goto('/settings/members')
    let row = page.locator('.member', { hasText: 'visitor' })
    await expect(row).toContainText('Invited')
    await row.getByText('Remove…').click()
    await row.getByRole('button', { name: 'Remove visitor' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Member removed.' })).toBeVisible()
    await expect(page.locator('.member', { hasText: 'visitor' })).toHaveCount(0)
    expect(errors).toEqual([])
    expect(visitorErrors).toEqual([])
  })

  test('a member reads the members, with no form', async ({ page }) => {
    await signIn(page, 'camille')
    await page.goto('/settings/members')
    await expect(page.locator('.member', { hasText: 'octocat' })).toContainText('Owner')
    await expect(page.getByLabel('GitHub login')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Change the role' })).toHaveCount(0)
    await expect(page.getByText('Read only', { exact: true })).toBeVisible()
  })
})
