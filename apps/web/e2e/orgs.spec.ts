import { expect, test } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG, SECOND_ORG } from './fake-github.ts'
import { expectNoAxeViolations, signIn, watchConsole } from './helpers.ts'

// KNT-150: the menu of the orgs in the header. Octocat is a member of a second org, Globex, from an
// invitation (GitHub is never asked about it); Camille is a member of the org of the fake GitHub only.

const GLOBEX = { ...SECOND_ORG, repoId: 915001 }

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** Globex, its installation and one repository, and the membership of octocat in it. Once. */
async function seedGlobex() {
  let sql = database()
  try {
    let [known] = await sql<{ orgId: string }[]>`select org_id as "orgId" from installations where github_installation_id = ${GLOBEX.installationId}`
    let orgId = known?.orgId
    if (!orgId) {
      let [row] = await sql<{ orgId: string; installationId: string }[]>`
        with org as (insert into orgs (name, slug) values ('Globex', 'globex') returning id)
        insert into installations (org_id, github_installation_id, github_account_id, account_login)
        select id, ${GLOBEX.installationId}, ${GLOBEX.accountId}, ${GLOBEX.login} from org
        returning org_id as "orgId", id as "installationId"`
      orgId = row!.orgId
      await sql`
        insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
        values (${orgId}, ${row!.installationId}, ${GLOBEX.repoId}, 'globex/rocket', true)`
    }
    let [user] = await sql<{ id: string }[]>`select id from users where login = 'octocat'`
    await sql`
      insert into memberships (user_id, org_id, role, source) values (${user!.id}, ${orgId}, 'member', 'invitation')
      on conflict (user_id, org_id) do nothing`
    let [repo] = await sql<{ id: string }[]>`select id from repos where github_repo_id = ${GLOBEX.repoId}`
    return { orgId, repoId: repo!.id }
  } finally {
    await sql.end()
  }
}

test.describe('the menu of the orgs (KNT-150)', () => {
  test('a person in two orgs switches from one to the other, with their role in each', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'octocat')
    await seedGlobex()
    await page.goto('/repos')

    let menu = page.locator('details.org-menu')
    await expect(menu.locator('.org-menu-name')).toHaveText(FAKE_ORG.login)
    await menu.locator('summary').click()
    let panel = menu.locator('.org-menu-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[aria-current="true"]')).toContainText(`${FAKE_ORG.login}Owner`)
    await expect(panel.getByRole('button', { name: /Globex/ })).toContainText('Member')
    await expect(panel.getByRole('link', { name: 'Organization settings' })).toHaveAttribute('href', '/settings')
    await expectNoAxeViolations(page)

    await panel.getByRole('button', { name: /Globex/ }).click()
    await expect(page).toHaveURL(/\/repos$/)
    await expect(menu.locator('.org-menu-name')).toHaveText('Globex')
    await expect(page.getByRole('status')).toContainText('Read only You are a member of Globex')
    await expect(page.getByRole('link', { name: 'rocket' })).toBeVisible()
    await expect(page.getByText('orchard')).toHaveCount(0)

    // Back to the first org, where octocat is the owner.
    await menu.locator('summary').click()
    await panel.getByRole('button', { name: new RegExp(FAKE_ORG.login) }).click()
    await expect(menu.locator('.org-menu-name')).toHaveText(FAKE_ORG.login)
    await expect(page.getByText('Read only', { exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('a member of one org reaches nothing of another org: not by the menu, not by a URL', async ({ page }) => {
    let { orgId, repoId } = await seedGlobex()
    await signIn(page, 'camille')
    await page.goto('/')
    let menu = page.locator('details.org-menu')
    await menu.locator('summary').click()
    await expect(menu.locator('.org-menu-panel')).not.toContainText('Globex')

    // The form of the switch with the id of Globex changes nothing.
    let csrf = await page.locator('input[name="_csrf"]').first().getAttribute('value')
    let switched = await page.request.post('/preferences/org', { form: { _csrf: csrf!, orgId, returnTo: '/repos' }, maxRedirects: 0 })
    expect(switched.status()).toBe(303)
    await page.goto('/repos')
    await expect(menu.locator('.org-menu-name')).toHaveText(FAKE_ORG.login)
    await expect(page.getByText('rocket')).toHaveCount(0)

    // The config of a repository of Globex, by its id: not found.
    let config = await page.goto(`/repos/${repoId}/config`)
    expect(config!.status()).toBe(404)
  })
})
