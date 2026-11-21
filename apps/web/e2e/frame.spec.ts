import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { chooseOption, expectNoAxeViolations, hydrated, signIn, watchConsole } from './helpers.ts'

const SCREENS = [
  { path: '/', title: 'Dashboard' },
  { path: '/repos', title: 'Repos' },
  { path: '/findings', title: 'Findings' },
  { path: '/feedback', title: 'Feedback' },
  { path: '/runners', title: 'Runners' },
  { path: '/settings', title: 'Settings' },
]

// KNT-165: a person of two orgs gets the switch of org in the bar. Its own installation, so that the
// org is a real one; deleted after the test (the membership goes with the org).
const SECOND_ORG = 'e2e-second-org'

async function addSecondOrg() {
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
  try {
    let [user] = await sql<{ id: string }[]>`select id from users where login = 'octocat'`
    let [org] = await sql<{ id: string }[]>`
      insert into orgs (name, slug) values (${SECOND_ORG}, ${SECOND_ORG})
      on conflict (slug) do update set name = excluded.name returning id`
    await sql`
      insert into installations (org_id, github_installation_id, github_account_id, account_login)
      values (${org!.id}, 777101, 777102, ${SECOND_ORG}) on conflict (github_installation_id) do nothing`
    await sql`
      insert into memberships (user_id, org_id, role, checked_at) values (${user!.id}, ${org!.id}, 'admin', now())
      on conflict (user_id, org_id) do update set checked_at = now()`
  } finally {
    await sql.end()
  }
}

async function removeSecondOrg() {
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
  try {
    await sql`delete from installations where org_id in (select id from orgs where slug = ${SECOND_ORG})`
    await sql`delete from orgs where slug = ${SECOND_ORG}`
  } finally {
    await sql.end()
  }
}

/** The paths of the POST requests of the page, from now on. */
function posts(page: Page): string[] {
  let paths: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST') paths.push(new URL(request.url()).pathname)
  })
  return paths
}

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

test.describe('the switch of org (KNT-165)', () => {
  test.afterEach(removeSecondOrg)

  test('a person of two orgs switches org from the bar: one post, and the bar names the other org', async ({ page }, testInfo) => {
    let errors = watchConsole(page)
    await signIn(page, 'octocat')
    await addSecondOrg()
    await page.goto('/repos')
    await hydrated(page)
    let trigger = page.getByRole('button', { name: 'Organization sakuga-software', exact: true })
    await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    // With JavaScript a choice applies at once: no "Switch" button.
    await expect(page.locator('form[data-org-switch]').getByRole('button', { name: 'Switch' })).toBeHidden()
    if (testInfo.project.name === 'mobile') {
      // Escape in the list of orgs closes the list only, not the menu of the bar around it.
      let menu = page.getByRole('button', { name: 'Menu' })
      await menu.click()
      await expect(menu).toHaveAttribute('aria-expanded', 'true')
      await trigger.click()
      let list = page.getByRole('listbox', { name: 'Organization' })
      await expect(list).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(list).toBeHidden()
      await expect(trigger).toBeFocused()
      await expect(menu).toHaveAttribute('aria-expanded', 'true')
      await page.keyboard.press('Escape')
      await expect(menu).toHaveAttribute('aria-expanded', 'false')
    }
    await trigger.click()
    await expect(page.getByRole('listbox', { name: 'Organization' })).toBeFocused()
    await expectNoAxeViolations(page)
    await page.keyboard.press('Escape')
    let sent = posts(page)
    await chooseOption(page, 'Organization', { label: SECOND_ORG })
    await expect(page.getByRole('button', { name: `Organization ${SECOND_ORG}`, exact: true })).toBeVisible()
    await expect(page).toHaveURL(/\/repos$/)
    expect(sent).toEqual(['/preferences/org'])
    expect(errors).toEqual([])
  })

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false })

    test('the switch is the native select, and "Switch" posts it', async ({ page }) => {
      await signIn(page, 'octocat')
      await addSecondOrg()
      await page.goto('/repos')
      let form = page.locator('form[data-org-switch]')
      await expect(page.getByRole('combobox', { name: 'Organization' })).toHaveValue(/.+/)
      await page.getByRole('combobox', { name: 'Organization' }).selectOption({ label: SECOND_ORG })
      let sent = posts(page)
      await form.getByRole('button', { name: 'Switch' }).click()
      await expect(page).toHaveURL(/\/repos$/)
      await expect(page.getByRole('combobox', { name: 'Organization' }).locator('option:checked')).toHaveText(SECOND_ORG)
      expect(sent).toEqual(['/preferences/org'])
    })
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
