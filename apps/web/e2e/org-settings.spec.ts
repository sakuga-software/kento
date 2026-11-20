import { createHmac } from 'node:crypto'

import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { E2E_WEBHOOK_SECRET, FAKE_ORG } from './fake-github.ts'
import { expectNoAxeViolations, goToSettingsLink, signIn, watchConsole } from './helpers.ts'

// The settings of the org (REV-13) in a browser, against the server, Postgres and the fake GitHub,
// with the tests of the ticket: a limit of 0,01 $ stops the next push, with its reason on the pull
// request, and 8 $ lets the jobs go again; renovate[bot] in the trusted bots gets its pull request
// reviewed; the last event shown is the last push.

const ORCHARD = { id: 7001, full_name: 'sakuga-software/orchard', owner: { id: FAKE_ORG.accountId, login: FAKE_ORG.login } }
const GITHUB = `http://127.0.0.1:${process.env.E2E_GITHUB_PORT ?? 3499}`

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** orchard enabled with one review that cost 0,02 $ today; the org at the values of a new org. */
async function reset(page: Page) {
  await page.goto('/repos')
  await page.getByRole('button', { name: 'Read GitHub again' }).click()
  await expect(page.getByText('List up to date.')).toBeVisible()
  let sql = database()
  try {
    await sql`delete from jobs where repo_id in (select id from repos where full_name = ${ORCHARD.full_name})`
    await sql`update repos set enabled = true, config = '{}', config_version = 0, default_level = 'lite' where full_name = ${ORCHARD.full_name}`
    await sql`update orgs set config = '{}', daily_cap_usd = null, monthly_cap_usd = null, cap_alert_pct = 80,
      trusted_bots = '{sakuga-agent[bot]}', settings_version = 0, settings_updated_by = null, settings_updated_at = null`
    let [job] = await sql<{ id: string; repo_id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, base_ref, state)
      select id, 'lite', 30, ${'e'.repeat(40)}, 'main', 'done' from repos where full_name = ${ORCHARD.full_name}
      returning id, repo_id`
    await sql`insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result)
      values (${job!.id}, ${job!.repo_id}, 30, ${'e'.repeat(40)}, 4, 'claude-haiku-5-5', 0.02, '{}')`
  } finally {
    await sql.end()
  }
}

let delivery = 0

/** A `pull_request` event of orchard, signed as GitHub signs it. */
async function pullRequest(page: Page, options: { head: string; author?: { login: string; type: string } }) {
  let author = options.author ?? { login: 'octocat', type: 'User' }
  let body = JSON.stringify({
    action: 'synchronize',
    number: 32,
    pull_request: {
      number: 32,
      draft: false,
      user: author,
      head: { sha: options.head, ref: 'feature', repo: { id: ORCHARD.id } },
      base: { sha: 'f'.repeat(40), ref: 'main', repo: { id: ORCHARD.id } },
    },
    repository: ORCHARD,
    sender: author,
    installation: { id: FAKE_ORG.installationId },
  })
  delivery++
  let response = await page.request.post('/webhooks/github', {
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': `e2e-org-${Date.now()}-${delivery}`,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', E2E_WEBHOOK_SECRET).update(body).digest('hex')}`,
    },
    data: body,
  })
  expect(response.status()).toBe(202)
  return (await response.json()) as { outcome: string; reason?: string; period?: string }
}

async function checkRunsOf(page: Page, headSha: string) {
  let response = await page.request.get(`${GITHUB}/_test/check-runs`)
  let runs = (await response.json()) as { name: string; head_sha: string; conclusion: string; output: { title: string; summary: string } }[]
  return runs.filter((run) => run.head_sha === headSha)
}

const head = (n: number) => (0x5e0000 + n).toString(16).padStart(40, '0')

test.describe('the settings of the org', () => {
  test('an admin sets the limit to 0,01 $: the next push gets no review and the reason; 8 $ lets the jobs go again', async ({ page }, info) => {
    let errors = watchConsole(page)
    let run = info.project.name === 'mobile' ? 100 : 0
    await signIn(page, 'octocat')
    await reset(page)

    await page.goto('/settings')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    let cap = page.getByRole('region', { name: 'Cost cap' })
    await expect(cap.getByText('$0.02', { exact: false }).first()).toBeVisible()
    await expect(page.getByText('settings v0, the values of Kentō')).toBeVisible()
    await expectNoAxeViolations(page)

    await cap.getByLabel('Daily cap ($)').fill('0,01')
    await cap.getByRole('button', { name: 'Save the cap' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved (v1)' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: 'Daily cap reached' })).toBeVisible()
    await expectNoAxeViolations(page)

    let stopped = await pullRequest(page, { head: head(run + 1) })
    expect(stopped.outcome).toBe('capped')
    expect(stopped.period).toBe('day')
    let [check] = await checkRunsOf(page, head(run + 1))
    expect(check!.name).toBe('Kentō · cap')
    expect(check!.conclusion).toBe('neutral')
    expect(check!.output.summary).toMatch(/the organization reached its daily cost cap/)

    await page.reload()
    await page.getByRole('region', { name: 'Cost cap' }).getByLabel('Daily cap ($)').fill('8')
    await page.getByRole('region', { name: 'Cost cap' }).getByRole('button', { name: 'Save the cap' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved (v2)' })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: 'Daily cap reached' })).toHaveCount(0)
    expect((await pullRequest(page, { head: head(run + 2) })).outcome).toBe('queued')
    expect(await checkRunsOf(page, head(run + 2))).toEqual([])

    // The last event shown is the last push.
    await page.reload()
    let app = page.getByRole('region', { name: 'GitHub App' })
    await expect(app.getByText('Everything is in place')).toBeVisible()
    await expect(app.getByText('pull_request.synchronize · 202 queued').first()).toBeVisible()
    await expect(app.getByRole('link', { name: 'Redeliver from the page of the App' })).toHaveAttribute(
      'href',
      /\/organizations\/sakuga-software\/settings\/apps\/kento-review\/advanced$/,
    )
    await expectNoAxeViolations(page)
    expect(errors).toEqual([])
  })

  test('renovate[bot] in the trusted bots: its pull request on orchard gets a review', async ({ page }, info) => {
    let run = info.project.name === 'mobile' ? 100 : 0
    await signIn(page, 'octocat')
    await reset(page)
    let renovate = { login: 'renovate[bot]', type: 'Bot' }
    let ignored = await pullRequest(page, { head: head(run + 10), author: renovate })
    expect(ignored.outcome).toBe('ignored')

    await page.goto('/settings#bots')
    let bots = page.getByRole('region', { name: /Trusted bots/ })
    await bots.getByLabel('One login per line').fill('sakuga-agent[bot]\nrenovate')
    await bots.getByRole('button', { name: 'Save the bots' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved (v1)' })).toBeVisible()
    await expect(page.getByRole('region', { name: /Trusted bots/ }).getByRole('listitem').filter({ hasText: 'renovate[bot]' })).toBeVisible()
    expect((await pullRequest(page, { head: head(run + 11), author: renovate })).outcome).toBe('queued')

    // A person is not a bot: the form refuses it and keeps what was typed.
    await page.getByRole('region', { name: /Trusted bots/ }).getByLabel('One login per line').fill('github.com/renovate')
    await page.getByRole('region', { name: /Trusted bots/ }).getByRole('button', { name: 'Save the bots' }).click()
    await expect(page.getByText(/is not the login of a bot/)).toBeVisible()
    await expectNoAxeViolations(page)
  })

  test('the defaults of the org: the level of a push that orchard inherits', async ({ page }, info) => {
    let run = info.project.name === 'mobile' ? 100 : 0
    await signIn(page, 'octocat')
    await reset(page)
    await page.goto('/settings#defaults')
    let defaults = page.getByRole('region', { name: 'Default values' })
    await defaults.getByRole('radio', { name: /balanced/ }).check()
    await defaults.getByRole('button', { name: 'Save the level' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Settings saved (v1)' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Default values' }).getByText('set for the org')).toBeVisible()
    await expectNoAxeViolations(page)
    expect((await pullRequest(page, { head: head(run + 20) })).outcome).toBe('queued')
    let sql = database()
    try {
      let [job] = await sql<{ level: string }[]>`select level from jobs where head_sha = ${head(run + 20)}`
      expect(job!.level).toBe('balanced')
    } finally {
      await sql.end()
    }
  })

  // REV-29, KNT-149. Every section and every part of a section is one click away in the sidebar, has
  // a URL, and the page stays under one primary button per section.
  test('the sidebar leads to each section and to its parts, and marks the one on screen', async ({ page }, info) => {
    let errors = watchConsole(page)
    await signIn(page, 'octocat')
    await page.goto('/settings')
    let nav = page.getByRole('navigation', { name: 'Sections of the settings' })
    let mobile = info.project.name === 'mobile'
    // Under 900 px the list is folded under "Sections"; on a desktop it stays in view on the left.
    await expect(nav.locator('[data-settings-nav-toggle]')).toBeVisible({ visible: mobile })
    await expect(nav.getByRole('link', { name: 'Costs and cap' })).toBeVisible({ visible: !mobile })
    for (let [name, id] of [
      ['GitHub App', 'app'],
      ['Trusted bots', 'bots'],
      ['Levels and models', 'defaults'],
      ['balanced', 'org-balanced'],
      ['Webhook', 'app-webhook'],
      ['Providers and keys', 'providers'],
      ['Costs and cap', 'cap'],
    ] as const) {
      await goToSettingsLink(page, name)
      await expect(page).toHaveURL(new RegExp(`/settings#${id}$`))
      await expect(page.locator(`#${id}`)).toBeInViewport()
      if (!mobile) await expect(nav).toBeInViewport()
    }
    if (!mobile) {
      // The wheel over the sidebar scrolls the page: the sidebar does not hold it.
      let box = (await nav.boundingBox())!
      await page.mouse.move(box.x + 20, box.y + 20)
      let before = await page.evaluate(() => window.scrollY)
      await page.mouse.wheel(0, 600)
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before)
      await page.evaluate(() => window.scrollTo(0, 0))
    }
    // The sidebar marks the section on screen, and the part on screen under it. On a phone, the list
    // marks the section and the part chosen in it (KNT-168).
    await expect(nav.getByRole('link', { name: 'Costs and cap', includeHidden: true })).toHaveAttribute('aria-current', 'location')
    await expect(nav.locator('[aria-current="location"]')).toHaveCount(1)
    await goToSettingsLink(page, 'heavy')
    await expect(nav.getByRole('link', { name: 'Levels and models', includeHidden: true })).toHaveAttribute('aria-current', 'location')
    await expect(nav.getByRole('link', { name: 'heavy', exact: true, includeHidden: true })).toHaveAttribute('aria-current', 'true')
    await expect(nav.getByRole('link', { name: 'Costs and cap', includeHidden: true })).not.toHaveAttribute('aria-current', /.*/)
    if (mobile) {
      // The list is folded again after a link. KNT-168: the button names no section.
      let toggle = nav.locator('[data-settings-nav-toggle]')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(toggle).toHaveText('Sections')
      // KNT-164. Tab past the last link: the list stays open (a disclosure in the page), and the
      // field that gets the focus is on screen.
      await toggle.click()
      await nav.locator('.settings-nav-list a').last().focus()
      await page.keyboard.press('Tab')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(page.locator(':focus')).toBeInViewport()
    }
    for (let section of await page.locator('.settings-content section').all()) {
      expect(await section.locator('.button--primary:visible').count()).toBeLessThanOrEqual(1)
    }
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await expectNoAxeViolations(page)
    expect(errors).toEqual([])
  })

  // KNT-164. On a phone the open list is part of the page, as a disclosure: it folds only on a link
  // or on Escape. If it folded when the focus left it, the field just under it would jump off the
  // screen at the tap, and the tap would miss it.
  test('on a phone, a tap on the field under the open list keeps the field on screen', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'the list folds under 900 px only')
    await signIn(page, 'octocat')
    await page.goto('/settings')
    let nav = page.getByRole('navigation', { name: 'Sections of the settings' })
    let toggle = nav.locator('[data-settings-nav-toggle]')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // The bottom of the list near the top of the screen, the first field of the cap under it.
    let list = (await nav.locator('.settings-nav-list').boundingBox())!
    await page.evaluate((y) => window.scrollBy(0, y), list.y + list.height - 150)
    let field = page.locator('#cap-day')
    await expect(field).toBeInViewport({ ratio: 1 })
    await field.tap()
    await expect(field).toBeFocused()
    await expect(field).toBeInViewport({ ratio: 1 })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    // Escape folds it, and gives the focus back to the button.
    await toggle.focus()
    await page.keyboard.press('Escape')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  // KNT-168. On a phone the bar is at the top of the page. Each section ends with "Sections": the
  // link leads back to the bar, opens the list on that section, and gives the focus to the button.
  test('on a phone, "Sections" at the end of a section opens the list on that section', async ({ page }, info) => {
    let errors = watchConsole(page)
    let mobile = info.project.name === 'mobile'
    await signIn(page, 'octocat')
    await page.goto('/settings#app')
    let back = page.locator('a[data-settings-back="app"]')
    // A desktop has its sidebar in view: no link back.
    await expect(back).toBeVisible({ visible: mobile })
    test.skip(!mobile, 'the links back exist under 900 px only')
    await back.scrollIntoViewIfNeeded()
    await back.click()
    let nav = page.getByRole('navigation', { name: 'Sections of the settings' })
    let toggle = nav.locator('[data-settings-nav-toggle]')
    await expect(page).toHaveURL(/\/settings#settings-nav$/)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toBeFocused()
    await expect(toggle).toBeInViewport()
    await expect(nav.getByRole('link', { name: 'GitHub App' })).toHaveAttribute('aria-current', 'location')
    await expect(nav.locator('[aria-current]')).toHaveCount(1)
    // Tab goes on into the list; a choice leads to the section, and the list marks it.
    await page.keyboard.press('Tab')
    await expect(nav.getByRole('link', { name: 'Costs and cap' })).toBeFocused()
    await nav.getByRole('link', { name: 'Trusted bots' }).click()
    await expect(page).toHaveURL(/\/settings#bots$/)
    await expect(page.locator('#bots')).toBeInViewport()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(nav.getByRole('link', { name: 'Trusted bots', includeHidden: true })).toHaveAttribute('aria-current', 'location')
    // The scroll does not move the mark of a phone: the list is never next to the section.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(200)
    await expect(nav.getByRole('link', { name: 'Trusted bots', includeHidden: true })).toHaveAttribute('aria-current', 'location')
    // The last section, at the bottom of a long page, leads back too.
    await page.locator('a[data-settings-back="providers"]').click()
    await expect(toggle).toBeInViewport()
    await expect(nav.getByRole('link', { name: 'Providers and keys' })).toHaveAttribute('aria-current', 'location')
    await expectNoAxeViolations(page)
    expect(errors).toEqual([])
  })

  test('without settings.js, a phone still has the list of the sections in the page', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'the bar folds the list under 900 px only')
    await page.route('**/assets/settings.js*', (route) => route.abort())
    await signIn(page, 'octocat')
    await page.goto('/settings')
    let nav = page.getByRole('navigation', { name: 'Sections of the settings' })
    await expect(nav.locator('[data-settings-nav-toggle]')).toBeHidden()
    await expect(nav.getByRole('link', { name: 'Trusted bots' })).toBeVisible()
    await nav.getByRole('link', { name: 'Trusted bots' }).click()
    await expect(page.locator('#bots')).toBeInViewport()
  })

  test('an old anchor of the settings leads to its section under the new anchor', async ({ page }) => {
    await signIn(page, 'octocat')
    await page.goto('/settings#plafond')
    await expect(page).toHaveURL(/\/settings#cap$/)
    await expect(page.locator('#cap')).toBeInViewport()
  })

  test('a member reads everything, and has no form', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'camille')
    await page.goto('/settings')
    await expect(page.getByRole('region', { name: 'Cost cap' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'GitHub App' }).getByText('Everything is in place')).toBeVisible()
    await expect(page.getByText('sakuga-agent[bot]').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0)
    await expect(page.getByRole('textbox')).toHaveCount(0)
    await expectNoAxeViolations(page)
    let refused = await page.request.post('/settings/org', { form: { version: '0', field: 'caps', dailyCapUsd: '1000', alertPct: '80' } })
    expect(refused.status()).toBe(403)
    expect(errors).toEqual([])
  })
})
