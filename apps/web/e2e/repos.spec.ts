import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { LONG_REPO_NAME } from './fake-github.ts'
import { expectNoAxeViolations, signIn, watchConsole } from './helpers.ts'

// The Repos screen (REV-9) in a browser, against the server, Postgres and the fake GitHub: the check
// of the installation, enable, disable with its confirmation, the switch counter, and the member who
// reads only.

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** Every repository disabled, with no job: each test starts from the same screen. */
async function reset() {
  let sql = database()
  try {
    await sql`delete from jobs where repo_id in (select id from repos where full_name like 'sakuga-software/%')`
    await sql`update repos set enabled = false`
  } finally {
    await sql.end()
  }
}

/** Reads GitHub at once, as an admin, and waits for the list. */
async function checkNow(page: Page) {
  await page.goto('/repos')
  await page.getByRole('button', { name: 'Read GitHub again' }).click()
  await expect(page.getByText('List up to date.')).toBeVisible()
}

function rowOf(page: Page, name: string) {
  return page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${name}`) }) })
}

test.describe('the Repos screen', () => {
  test.beforeEach(async () => {
    await reset()
  })

  for (let theme of ['paper', 'sumi'] as const) {
    test(`an admin enables orchard, then disables it after a confirmation (${theme})`, async ({ page, context, baseURL }) => {
      let errors = watchConsole(page)
      await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])
      await signIn(page, 'alex')
      await checkNow(page)

      let orchard = rowOf(page, 'orchard')
      await expect(orchard.getByText('review.yml@stable')).toBeVisible()
      await expect(rowOf(page, 'fruitback').getByText('copy of review.yml')).toBeVisible()
      await expect(rowOf(page, 'infra-repo').getByText('none', { exact: true })).toBeVisible()
      // REV-91: the notes on the switch are folded under the table.
      await page.getByText('How the switch from review.yml to Kentō works').click()
      await expect(page.getByRole('heading', { name: 'Switch criterion' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Fallback during the switch' })).toBeVisible()
      await expect(page.getByRole('link', { name: /Manage the installation/ })).toHaveAttribute(
        'href',
        /\/organizations\/sakuga-software\/settings\/installations\/4242$/,
      )
      await expectNoAxeViolations(page)

      await orchard.getByRole('button', { name: 'Enable orchard' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'orchard is enabled.' })).toBeVisible()
      await expect(rowOf(page, 'orchard').getByText('Kentō + review.yml')).toBeVisible()
      await expect(rowOf(page, 'orchard').getByText('review.yml@stable')).toBeVisible()
      await expect(rowOf(page, 'orchard').getByText('0/20')).toBeVisible()
      await expectNoAxeViolations(page)

      // REV-33: the confirmation opens in the row, at the keyboard; Escape and « Cancel » close it and
      // give the focus back to its trigger.
      let row = rowOf(page, 'orchard')
      // REV-91: « Disable Kentō… » sits in the menu « … » of the row.
      await row.locator('.row-menu > summary').click()
      let trigger = row.locator('summary', { hasText: 'Disable' })
      let act = row.getByRole('button', { name: 'Disable orchard' })
      await trigger.focus()
      await page.keyboard.press('Enter')
      await expect(row).toContainText('The published reviews and the counter stay')
      await expect(act).toBeVisible()
      // The table clips what goes past its bottom: it makes room for the open menu and its confirmation.
      let inside = () =>
        act.evaluate((button) => {
          let wrap = button.closest('.table-wrap')!.getBoundingClientRect()
          let box = button.getBoundingClientRect()
          return box.top >= wrap.top && box.bottom <= wrap.bottom
        })
      expect(await inside()).toBe(true)
      await expectNoAxeViolations(page)
      await page.keyboard.press('Tab')
      await expect(act).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(act).toBeHidden()
      await expect(trigger).toBeFocused()

      await page.keyboard.press('Enter')
      await row.getByRole('button', { name: 'Cancel' }).click()
      await expect(act).toBeHidden()
      // REV-91: « Cancel » also closes the menu « … », and gives the focus back to it.
      await expect(row.locator('.row-menu')).not.toHaveAttribute('open', '')
      await expect(row.locator('.row-menu > summary')).toBeFocused()
      // The room under the table goes with the menu.
      expect(await page.locator('.table-wrap').evaluate((wrap) => wrap.style.paddingBottom)).toBe('')
      await row.locator('.row-menu > summary').click()

      // The destructive buttons have their own colour; no button of a row has the primary style (REV-36).
      let colors = await page.evaluate(() => {
        let primary = document.querySelector('.button-primary')
        let danger = document.querySelector('.button-danger')
        return [primary && getComputedStyle(primary).backgroundColor, danger && getComputedStyle(danger).color]
      })
      expect(colors[0]).not.toEqual(colors[1])
      await expect(page.locator('.row-action .button-primary')).toHaveCount(0)

      await trigger.click()
      await act.click()
      await expect(page.getByRole('status').filter({ hasText: 'orchard is disabled.' })).toBeVisible()
      await expect(rowOf(page, 'orchard').getByText('review.yml@stable')).toBeVisible()

      let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(0)
      expect(errors).toEqual([])
    })
  }

  test('the counter: 20 published reviews offer « Remove review.yml »; a failed job brings it back to 0/20', async ({ page }) => {
    await signIn(page, 'alex')
    await checkNow(page)
    let sql = database()
    try {
      let [repo] = await sql<{ id: string }[]>`update repos set enabled = true where full_name = 'sakuga-software/orchard' returning id`
      for (let n = 1; n <= 20; n++) {
        let [job] = await sql<{ id: string }[]>`
          insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, finished_at)
          values (${repo!.id}, 'lite', 'done', ${n}, ${n.toString(16).padStart(40, '0')}, 'main', now() - ${`${60 - n} minutes`}::interval)
          returning id`
        await sql`
          insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result, github_review_id, published_at)
          values (${job!.id}, ${repo!.id}, ${n}, ${n.toString(16).padStart(40, '0')}, 4, 'anthropic/claude-haiku-5.5', '{}'::jsonb, ${n}, now() - ${`${60 - n} minutes`}::interval)`
      }
      await page.goto('/repos')
      let orchard = rowOf(page, 'orchard')
      await expect(orchard.getByText('20/20')).toBeVisible()
      await expect(orchard.getByRole('link', { name: /Remove review\.yml/ })).toHaveAttribute(
        'href',
        /\/sakuga-software\/orchard\/delete\/main\/\.github\/workflows\/sakuga-review\.yml$/,
      )
      await expect(orchard.getByRole('link', { name: '#20 · 4/5' })).toBeVisible()
      await expectNoAxeViolations(page)

      await sql`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, failure_reason, finished_at)
        values (${repo!.id}, 'lite', 'failed', 21, ${'f'.repeat(40)}, 'main', 'lease expired 2 times', now())`
      await page.reload()
      await expect(orchard.getByText('0/20')).toBeVisible()
      await expect(orchard.getByText('set back to zero after a failure on')).toBeVisible()
      await expect(orchard.getByRole('link', { name: '#21', exact: true })).toHaveAttribute('href', /\/sakuga-software\/orchard\/pull\/21$/)
      await expect(orchard.getByRole('link', { name: /Remove review\.yml/ })).toHaveCount(0)
    } finally {
      await sql.end()
    }
  })

  test('a repository name of 80 characters: the page does not scroll sideways, and « Disable » stays in view (REV-25)', async ({ page }) => {
    await signIn(page, 'alex')
    await checkNow(page)
    let sql = database()
    try {
      let [repo] = await sql<{ id: string }[]>`
        update repos set enabled = true where full_name = ${`sakuga-software/${LONG_REPO_NAME}`} returning id`
      let [job] = await sql<{ id: string }[]>`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, finished_at)
        values (${repo!.id}, 'heavy', 'done', 7, ${'7'.repeat(40)}, 'main', now()) returning id`
      await sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result, github_review_id, published_at)
        values (${job!.id}, ${repo!.id}, 7, ${'7'.repeat(40)}, 4, 'anthropic/claude-sonnet-4-5', '{}'::jsonb, 7, now())`
    } finally {
      await sql.end()
    }

    let width = page.viewportSize()!.width
    for (let viewport of width > 760 ? [width, 1024] : [width]) {
      await page.setViewportSize({ width: viewport, height: 900 })
      await page.goto('/repos')
      let row = rowOf(page, LONG_REPO_NAME)
      await expect(row.getByRole('link', { name: LONG_REPO_NAME, exact: true })).toHaveAttribute('title', `sakuga-software/${LONG_REPO_NAME}`)
      await expect(row.getByText('claude-sonnet-4-5')).toBeVisible()

      let layout = await page.evaluate(() => {
        let wrap = document.querySelector('.table-wrap')!
        let box = wrap.getBoundingClientRect()
        // REV-91: a row shows « Enable » and the menu « … »; « Disable Kentō… » is in the menu.
        let actions = [...document.querySelectorAll('.row-action > .button, .row-action > .row-menu > summary')].map((button) => {
          let r = button.getBoundingClientRect()
          return r.left >= box.left - 0.5 && r.right <= Math.min(box.right, window.innerWidth) + 0.5
        })
        // A tag or a model id on two lines is at least two lines high.
        let broken = [...document.querySelectorAll('.table .tag, .table td .mono')]
          .filter((el) => {
            let style = getComputedStyle(el)
            let line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5
            return el.getBoundingClientRect().height >= 1.8 * line
          })
          .map((el) => el.textContent)
        return {
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          tableOverflow: wrap.scrollWidth - wrap.clientWidth,
          actions,
          broken,
        }
      })
      expect(layout.pageOverflow, `page at ${viewport} px`).toBeLessThanOrEqual(0)
      if (viewport >= 1440) expect(layout.tableOverflow, `table at ${viewport} px`).toBeLessThanOrEqual(0)
      // Other specs can leave more repositories in the database: every row counts, at least the 4 of the fake.
      expect(layout.actions.length, `rows at ${viewport} px`).toBeGreaterThanOrEqual(4)
      expect(layout.actions, `actions at ${viewport} px`).not.toContain(false)
      expect(layout.broken, `tags and model ids at ${viewport} px`).toEqual([])

      await row.locator('.row-menu > summary').click()
      let disable = row.locator('summary', { hasText: 'Disable' })
      await disable.scrollIntoViewIfNeeded()
      await expect(disable).toBeInViewport({ ratio: 1 })
      let right = await disable.evaluate((el) => el.getBoundingClientRect().right - window.innerWidth)
      expect(right, `« Disable » at ${viewport} px`).toBeLessThanOrEqual(0)
      // The open menu covers the row under it: closed again for axe.
      await row.locator('.row-menu > summary').click()
    }
    await expectNoAxeViolations(page)
  })

  test('a click inside the inner confirmation does not close the menu, and « Cancel » gives the focus back to the summary (Kentō #d30d83)', async ({ page }) => {
    await signIn(page, 'alex')
    await checkNow(page)
    let row = rowOf(page, 'orchard')
    let enable = row.getByRole('button', { name: 'Enable orchard' })
    if (await enable.count()) {
      await enable.click()
      await expect(page.getByRole('status').filter({ hasText: 'orchard is enabled.' })).toBeVisible()
      row = rowOf(page, 'orchard')
    }
    let menu = row.locator('.row-menu')
    let summary = menu.locator('> summary')
    let confirm = menu.locator('details[data-confirm]')
    await summary.click()
    // The trigger of the confirmation, then its text: both are clicks inside the menu.
    await confirm.locator('> summary').click()
    await expect(confirm).toHaveAttribute('open', '')
    await confirm.getByText('The published reviews and the counter stay').click()
    await expect(menu).toHaveAttribute('open', '')
    await expect(confirm).toHaveAttribute('open', '')
    // « Cancel »: confirm.js closes the confirmation, then row-menu.js the menu, focus on its summary.
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).not.toHaveAttribute('open', '')
    await expect(menu).not.toHaveAttribute('open', '')
    await expect(summary).toBeFocused()

    // Back from the next page (bfcache), the page comes back as it was left: the menu closes.
    await summary.click()
    await expect(menu).toHaveAttribute('open', '')
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await expect(menu).not.toHaveAttribute('open', '')
    await expect(row.locator('.row-action')).not.toHaveClass(/row-action-open/)
  })

  test('a menu « … » closes on Escape and on a click outside, one open at a time; « Search » shows at the keyboard (REV-91)', async ({ page }) => {
    await signIn(page, 'alex')
    await checkNow(page)
    let orchard = rowOf(page, 'orchard').locator('.row-menu')
    let fruitback = rowOf(page, 'fruitback').locator('.row-menu')
    await orchard.locator('summary').first().click()
    await expect(orchard).toHaveAttribute('open', '')
    // An admin's card has no label on its actions either, under 760 px as above.
    expect(await rowOf(page, 'orchard').locator('.row-action').evaluate((cell) => getComputedStyle(cell, '::before').content)).toBe('none')
    // The open cell is marked by row-menu.js, not only by :has(): it sits above the rows under it.
    await expect(rowOf(page, 'orchard').locator('.row-action')).toHaveClass(/row-action-open/)
    await fruitback.locator('summary').first().click()
    await expect(fruitback).toHaveAttribute('open', '')
    await expect(orchard).not.toHaveAttribute('open', '')
    await expect(rowOf(page, 'orchard').locator('.row-action')).not.toHaveClass(/row-action-open/)
    await expect(rowOf(page, 'fruitback').locator('.row-action')).toHaveClass(/row-action-open/)
    await page.keyboard.press('Escape')
    await expect(fruitback).not.toHaveAttribute('open', '')
    await expect(fruitback.locator('summary').first()).toBeFocused()
    await fruitback.locator('summary').first().click()
    await page.getByRole('heading', { level: 1, name: 'Repos' }).click()
    await expect(fruitback).not.toHaveAttribute('open', '')

    let search = page.getByRole('searchbox', { name: 'Search a repo by its name' })
    let submit = page.getByRole('button', { name: 'Search', exact: true })
    expect((await submit.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1)
    await search.focus()
    await page.keyboard.press('Tab')
    await expect(submit).toBeFocused()
    expect((await submit.boundingBox())!.width).toBeGreaterThan(40)
    await expectNoAxeViolations(page)
  })

  test('on a screen of 280 px, the menu « … » and its confirmation stay inside the screen (REV-91)', async ({ page }) => {
    await signIn(page, 'alex')
    await checkNow(page)
    let row = rowOf(page, 'orchard')
    let enable = row.getByRole('button', { name: 'Enable orchard' })
    if (await enable.count()) {
      await enable.click()
      await expect(page.getByRole('status').filter({ hasText: 'orchard is enabled.' })).toBeVisible()
      row = rowOf(page, 'orchard')
    }
    await page.setViewportSize({ width: 280, height: 800 })
    await row.locator('.row-menu > summary').click()
    await row.locator('summary', { hasText: 'Disable' }).click()
    let panel = row.locator('.row-menu > div')
    let edges = await panel.evaluate((el) => {
      let box = el.getBoundingClientRect()
      return { left: box.left, right: box.right, width: window.innerWidth }
    })
    expect(edges.left).toBeGreaterThanOrEqual(0)
    expect(edges.right).toBeLessThanOrEqual(edges.width)
  })

  test('a long list: 50 rows a page, the enabled ones first, a search and the filters (REV-36)', async ({ page }) => {
    await signIn(page, 'alex')
    await checkNow(page)
    let sql = database()
    try {
      await sql`
        insert into repos (org_id, github_repo_id, full_name, enabled, workflow)
        select org_id, 880000 + g, 'sakuga-software/bulk-' || lpad(g::text, 2, '0'), false, 'none'
        from repos, generate_series(1, 60) g where full_name = 'sakuga-software/orchard'`
      await sql`update repos set enabled = true where full_name = 'sakuga-software/orchard'`

      await page.goto('/repos')
      let rows = page.locator('tbody tr')
      await expect(rows).toHaveCount(50)
      await expect(rows.first().getByRole('rowheader')).toHaveText(/^orchard/)
      let total = Number(await page.getByRole('link', { name: /^All/ }).locator('.list-filter-count').textContent())
      await expect(page.locator('.pager-range')).toHaveText(`1 to 50 of ${total}`)
      await page.getByRole('link', { name: 'Next' }).click()
      await expect(page.locator('.pager-range')).toHaveText(`51 to ${total} of ${total}`)
      await page.getByRole('link', { name: 'Previous' }).click()
      await expect(page.locator('.pager-range')).toHaveText(`1 to 50 of ${total}`)

      // REV-91: Enter sends the search, with no visible button.
      await page.getByRole('searchbox', { name: 'Search a repo by its name' }).fill('BULK-0')
      await page.getByRole('searchbox', { name: 'Search a repo by its name' }).press('Enter')
      await expect(rows).toHaveCount(9)
      await expect(page.locator('.pager')).toHaveCount(0)

      await page.getByRole('link', { name: /^Enabled/ }).click()
      await expect(page.getByText('No repo matches')).toBeVisible()
      await page.getByRole('searchbox', { name: 'Search a repo by its name' }).fill('')
      await page.getByRole('searchbox', { name: 'Search a repo by its name' }).press('Enter')
      await expect(page).toHaveURL(/[?&]filter=enabled(&|$)/)
      await expect(rows).toHaveCount(1)

      // Enabled from page 2 of a search in « Not enabled », a repository comes back to that page.
      await page.goto('/repos?filter=disabled&q=bulk')
      await page.getByRole('link', { name: 'Next' }).click()
      let url = page.url()
      await page.getByRole('row').filter({ hasText: 'bulk-60' }).getByRole('button', { name: 'Enable bulk-60' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'bulk-60 is enabled.' })).toBeVisible()
      expect(page.url().split('#')[0]).toContain(new URL(url).search)
      await expectNoAxeViolations(page)
    } finally {
      await sql`delete from repos where github_repo_id between 880001 and 880060`
      await sql.end()
    }
  })

  test('a member reads the list under « Read only », with no action', async ({ page }) => {
    await signIn(page, 'camille')
    await page.goto('/repos')
    await expect(page.getByText('Read only', { exact: true })).toBeVisible()
    await expect(page.getByRole('table')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Enable/ })).toHaveCount(0)
    await expect(page.locator('summary', { hasText: 'Disable' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Read GitHub again' })).toHaveCount(0)
    // REV-91: a member keeps the menu « … » with the config and the findings; its cell has no label.
    let row = rowOf(page, 'orchard')
    expect(await row.locator('.row-action').evaluate((cell) => getComputedStyle(cell, '::before').content)).toBe('none')
    // Under 760 px each other cell keeps its label, « Precision 30 d » included for a repo without Kentō.
    if (page.viewportSize()!.width <= 760) {
      let gh = rowOf(page, 'infra-repo')
      expect(await gh.locator('td').nth(5).evaluate((cell) => getComputedStyle(cell, '::before').content)).toBe('"Precision 30 d"')
      await expect(gh.locator('td').nth(5)).toContainText('Kentō not enabled')
    }
    await row.locator('.row-menu > summary').click()
    for (let name of ['Open the config', 'See the findings']) {
      await row.getByRole('link', { name }).scrollIntoViewIfNeeded()
      await expect(row.getByRole('link', { name })).toBeInViewport({ ratio: 1 })
    }
    await expectNoAxeViolations(page)
  })
})

test.describe('the Repos screen without JavaScript', () => {
  test.use({ javaScriptEnabled: false })

  test('the menu « … » of the last row opens upwards, inside the table (REV-91)', async ({ page, browser, baseURL }) => {
    // The list comes from GitHub: read once in a browser with JavaScript, which waits for it.
    let reader = await browser.newContext({ baseURL, javaScriptEnabled: true })
    let readerPage = await reader.newPage()
    await signIn(readerPage, 'alex')
    await checkNow(readerPage)
    await reader.close()

    await signIn(page, 'alex')
    await page.goto('/repos')
    await expect(page.locator('html')).not.toHaveClass(/\bjs\b/)
    let last = page.locator('.repos-table tbody tr').last()
    await last.locator('.row-menu > summary').click()
    let fits = await last.locator('.row-menu > div').evaluate((menu) => {
      let wrap = menu.closest('.table-wrap')!
      let box = menu.getBoundingClientRect()
      let frame = wrap.getBoundingClientRect()
      // Under 760 px the table does not clip: the menu may go past it, in the page.
      return getComputedStyle(wrap).overflowX === 'visible' || (box.top >= frame.top && box.bottom <= frame.bottom)
    })
    expect(fits).toBe(true)
  })
})
