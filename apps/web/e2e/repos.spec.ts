import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { LONG_REPO_NAME } from './fake-github.ts'
import { expectNoAxeViolations, hydrated, signIn, watchConsole } from './helpers.ts'

// The Repos screen (REV-9) in a browser, against the server, Postgres and the fake GitHub: the check
// of the installation, enable, disable with its confirmation, "Remove review.yml" at the end of the
// switch, and the member who reads only.

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

/**
 * KNT-163: "…", then "Disable <name> Kentō…": the confirmation opens. Returns its button that acts.
 */
async function chooseDisable(page: Page, name: string) {
  let { trigger, menu } = menuOf(page, name)
  await trigger.click()
  await menu.getByRole('menuitem', { name: `Disable ${name} Kentō…` }).click()
  return page.getByRole('dialog', { name: `Disable ${name} Kentō…` }).getByRole('button', { name: `Disable ${name}` })
}

/** KNT-163: the button "…" of a row, once its menu hydrated, and the menu it opens. */
function menuOf(page: Page, name: string) {
  return {
    trigger: page.getByRole('button', { name: `Actions of ${name}`, exact: true }),
    menu: page.getByRole('menu', { name: `Actions of ${name}` }),
  }
}

test.describe('the Repos screen', () => {
  test.beforeEach(async () => {
    await reset()
  })

  for (let theme of ['paper', 'sumi'] as const) {
    test(`an admin enables orchard, then disables it after a confirmation (${theme})`, async ({ page, context, baseURL }) => {
      let errors = watchConsole(page)
      await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])
      await signIn(page, 'octocat')
      await checkNow(page)

      let orchard = rowOf(page, 'orchard')
      // KNT-179, KNT-181: no column "Reviews by" nor "Switch". KNT-194: no notes on the switch.
      await expect(page.getByRole('columnheader')).toHaveText(['Repo', 'Level', 'Model', 'Last review', 'Confidence 30 d', 'Precision 30 d', 'Actions'])
      await expect(page.getByText('How the switch from review.yml to Kentō works')).toHaveCount(0)
      // KNT-180: the visibility is the icon left of the name; a screen reader hears its word.
      await expect(orchard.getByRole('rowheader')).toHaveAccessibleName(/^orchard\s*, (private|public)$/)
      await expect(orchard.getByRole('rowheader').getByText(/^(private|public)$/)).toHaveCount(0)
      await expect(page.getByRole('link', { name: /Manage the installation/ })).toHaveAttribute(
        'href',
        /\/organizations\/sakuga-software\/settings\/installations\/4242$/,
      )
      await expectNoAxeViolations(page)

      await orchard.getByRole('button', { name: 'Enable orchard' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'orchard is enabled.' })).toBeVisible()
      await expect(rowOf(page, 'orchard').getByRole('button', { name: 'Enable orchard' })).toHaveCount(0)
      await expectNoAxeViolations(page)

      // REV-33, REV-91, KNT-163: "Disable Kentō…" sits in the menu "…" of the row, a menu of
      // @remix-run/ui: the arrows, Home and End move in it, Enter chooses. The confirmation opens in
      // a popover with "Cancel" in focus; Escape and "Cancel" close it and give the focus back to "…".
      await hydrated(page)
      let { trigger, menu } = menuOf(page, 'orchard')
      await trigger.focus()
      await page.keyboard.press('ArrowDown')
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: 'Open the config' })).toBeFocused()
      await page.keyboard.press('End')
      let disable = menu.getByRole('menuitem', { name: 'Disable orchard Kentō…' })
      await expect(disable).toBeFocused()
      await page.keyboard.press('Home')
      await expect(menu.getByRole('menuitem', { name: 'Open the config' })).toBeFocused()
      // Typeahead: "s" goes to "See the findings".
      await page.keyboard.press('s')
      await expect(menu.getByRole('menuitem', { name: 'See the findings' })).toBeFocused()
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      let dialog = page.getByRole('dialog', { name: 'Disable orchard Kentō…' })
      let act = dialog.getByRole('button', { name: 'Disable orchard' })
      await expect(dialog).toContainText('The published reviews stay')
      await expect(menu).toBeHidden()
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
      // The popover is in the top layer: no table clips it, and it stays in the window.
      await expect(act).toBeInViewport({ ratio: 1 })
      await expectNoAxeViolations(page)
      // The destructive buttons have their own colour; no button of a row has the primary style (REV-36).
      let colors = await page.evaluate(() => {
        let primary = document.querySelector('.button-primary')
        let danger = document.querySelector('.confirm-popover .button-danger-solid')
        return [primary && getComputedStyle(primary).backgroundColor, danger && getComputedStyle(danger).backgroundColor]
      })
      expect(colors[1]).not.toBeNull()
      expect(colors[0]).not.toEqual(colors[1])
      await expect(page.locator('.row-action .button-primary')).toHaveCount(0)
      await page.keyboard.press('Shift+Tab')
      await expect(act).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(trigger).toBeFocused()

      // With the pointer: "…", "Disable Kentō…", then "Cancel".
      await trigger.click()
      await disable.click()
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
      await expect(menu).toBeHidden()
      await expect(trigger).toBeFocused()

      await trigger.click()
      await disable.click()
      await act.click()
      await expect(page.getByRole('status').filter({ hasText: 'orchard is disabled.' })).toBeVisible()
      await expect(rowOf(page, 'orchard').getByRole('button', { name: 'Enable orchard' })).toBeVisible()

      let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(0)
      expect(errors).toEqual([])
    })
  }

  test('20 published reviews in a row offer "Remove review.yml" in the menu "…"; a failed job takes it away (KNT-179)', async ({ page }) => {
    await signIn(page, 'octocat')
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
      await expect(orchard.getByRole('link', { name: '#20 · 4/5' })).toBeVisible()
      // The row says it beside its "…" (critique P2-1).
      await expect(orchard.locator('.row-action').getByText('review.yml can go')).toBeVisible()
      // KNT-183: the average confidence of the 30 days, drawn with its marks, the count in its title.
      let confidence = orchard.locator('.score')
      await expect(confidence).toHaveAttribute('title', 'Average of 20 reviews over 30 days')
      await expect(confidence.locator('.score-value')).toHaveText('4.0/5')
      await expect(confidence).toHaveClass(/\bscore-high\b.*\bscore-n4\b/)
      await expect(confidence.locator('.score-marks')).toHaveAttribute('aria-hidden', 'true')
      await hydrated(page)
      let { trigger, menu } = menuOf(page, 'orchard')
      await trigger.click()
      let remove = menu.getByRole('menuitem', { name: 'Remove review.yml from orchard (GitHub, new tab)' })
      await expect(remove).toHaveAttribute('href', /\/sakuga-software\/orchard\/delete\/main\/\.github\/workflows\/sakuga-review\.yml$/)
      // Between "See the findings" and "Disable Kentō…".
      await expect(menu.getByRole('menuitem')).toHaveText(['Open the config', 'See the findings', /^Remove review\.yml/, /^Disable/])
      await expectNoAxeViolations(page)
      // It opens GitHub in a new tab, and the menu closes. GitHub is out of reach in the tests: a page stands in for it.
      await page.context().route(/\/delete\/main\//, (route) => route.fulfill({ contentType: 'text/html', body: '<title>GitHub</title>' }))
      let popup = page.waitForEvent('popup')
      await remove.click()
      await expect(await popup).toHaveURL(/\/sakuga-software\/orchard\/delete\/main\/\.github\/workflows\/sakuga-review\.yml$/)
      await expect(menu).toBeHidden()
      await expect(page).toHaveURL(/\/repos$/)
      await (await popup).close()

      await sql`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, failure_reason, finished_at)
        values (${repo!.id}, 'lite', 'failed', 21, ${'f'.repeat(40)}, 'main', 'lease expired 2 times', now())`
      await page.reload()
      await hydrated(page)
      await trigger.click()
      await expect(menu.getByRole('menuitem', { name: 'See the findings' })).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: /Remove review\.yml/ })).toHaveCount(0)
      await expect(orchard.getByText('review.yml can go')).toHaveCount(0)
    } finally {
      await sql.end()
    }
  })

  test('the last review stays on one line: whole in the table at 1280, 1024 and 800 px; on a card the link stays whole (KNT-182)', async ({ page }) => {
    await signIn(page, 'octocat')
    await checkNow(page)
    let sql = database()
    try {
      let [repo] = await sql<{ id: string }[]>`update repos set enabled = true where full_name = 'sakuga-software/garden' returning id`
      // A long PR number and a date over a day old: the longest text the cell can hold.
      let [job] = await sql<{ id: string }[]>`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, finished_at)
        values (${repo!.id}, 'lite', 'done', 123456, ${'a'.repeat(40)}, 'main', now() - interval '3 days') returning id`
      await sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result, github_review_id, published_at)
        values (${job!.id}, ${repo!.id}, 123456, ${'a'.repeat(40)}, 5, 'anthropic/claude-haiku-5.5', '{}'::jsonb, 123456, now() - interval '3 days')`
    } finally {
      await sql.end()
    }
    let width = page.viewportSize()!.width
    for (let viewport of width > 760 ? [1280, 1024, 800] : [width, 320]) {
      await page.setViewportSize({ width: viewport, height: 900 })
      await page.goto('/repos')
      let cell = rowOf(page, 'garden').locator('.repo-last-review')
      await expect(cell).toHaveAttribute('title', /^#123456 · 5\/5, published on \d+ \w+ at \d\d:\d\d$/)
      let box = await cell.evaluate((el) => {
        let link = el.querySelector('a')!
        let hint = el.querySelector('.hint') as HTMLElement
        let td = el.closest('td')!.getBoundingClientRect()
        let a = link.getBoundingClientRect()
        let h = hint.getBoundingClientRect()
        return {
          sameLine: Math.abs(a.top - h.top) < 4,
          linkWhole: a.right <= td.right + 0.5,
          hintWhole: hint.scrollWidth <= hint.clientWidth + 0.5 && h.right <= td.right + 0.5,
        }
      })
      expect(box.sameLine, `link and date on one line at ${viewport} px`).toBe(true)
      expect(box.linkWhole, `link whole at ${viewport} px`).toBe(true)
      // Critique P3-1: in the table nothing is cut, so the keyboard reads all of it; the longest
      // date fits a card of 320 px too.
      expect(box.hintWhole, `date whole at ${viewport} px`).toBe(true)
      let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow, `page at ${viewport} px`).toBeLessThanOrEqual(viewport < 390 ? 24 : 0)
    }
    if (width <= 760) {
      // A card narrower than the line: the date shrinks with an ellipsis, the link stays whole.
      let cut = await rowOf(page, 'garden').locator('.repo-last-review').evaluate((el) => {
        ;(el as HTMLElement).style.maxWidth = '150px'
        let link = el.querySelector('a')!
        let hint = el.querySelector('.hint') as HTMLElement
        return {
          linkWhole: link.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5,
          hintCut: hint.scrollWidth > hint.clientWidth,
          overflow: getComputedStyle(hint).textOverflow,
          sameLine: Math.abs(link.getBoundingClientRect().top - hint.getBoundingClientRect().top) < 4,
        }
      })
      expect(cut).toEqual({ linkWhole: true, hintCut: true, overflow: 'ellipsis', sameLine: true })
    }
  })

  test('"Read GitHub again" is a quiet icon button, busy while it posts; its result comes in a toast (KNT-184, KNT-185)', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'octocat')
    await page.goto('/repos?filter=enabled')
    let check = page.getByRole('button', { name: 'Read GitHub again' })
    await expect(check).toHaveAttribute('title', 'Read GitHub again')
    await expect(check).toHaveText('')
    let size = (await check.boundingBox())!
    expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(32)

    // The check takes its time: the button says it is busy, and its icon turns. Read in the page:
    // after a click that posts, a locator reads the next page. (A second press: progress-script.test.ts.)
    await page.route('**/repos/check?*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.continue()
    })
    let busy = new Promise<string>((resolve) => page.on('console', (message) => message.text().startsWith('busy ') && resolve(message.text())))
    await page.evaluate(() =>
      document.addEventListener('submit', () =>
        setTimeout(() => {
          let button = document.querySelector('[data-busy]')!
          console.log(`busy ${button.getAttribute('aria-busy')} ${getComputedStyle(button.querySelector('svg')!).animationName}`)
        }, 200),
      ),
    )
    await check.click()
    expect(await busy).toBe('busy true button-busy')
    // The toast: in the live region, in the bottom right corner of the window, over the page.
    let toast = page.getByRole('status').locator('.toast')
    await expect(toast).toContainText('List up to date.')
    // The message leaves the URL; the filter stays.
    await expect(page).toHaveURL(/\/repos\?filter=enabled$/)
    let box = (await toast.boundingBox())!
    let viewport = page.viewportSize()!
    expect(viewport.width - (box.x + box.width)).toBeLessThanOrEqual(32)
    expect(viewport.height - (box.y + box.height)).toBeLessThanOrEqual(32)
    expect(await toast.evaluate((el) => getComputedStyle(el.parentElement!).position)).toBe('fixed')
    // It goes by itself after 8 s.
    expect(await toast.evaluate((el) => getComputedStyle(el).animationName)).toBe('toast-in, toast-out')
    expect(await toast.evaluate((el) => getComputedStyle(el).animationDelay)).toBe('0s, 8s')
    await expectNoAxeViolations(page)
    // Its close link removes it, with no load.
    await page.evaluate(() => ((window as unknown as { kept: number }).kept = 1))
    await toast.getByRole('link', { name: 'Close the message' }).click()
    await expect(toast).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { kept?: number }).kept)).toBe(1)
    // A reload does not show it again.
    await page.reload()
    await expect(page.locator('.toast')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test('a repository name of 80 characters: the page does not scroll sideways, and "Disable" stays in view (REV-25)', async ({ page }) => {
    await signIn(page, 'octocat')
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
      await expect(row.getByRole('link', { name: LONG_REPO_NAME, exact: true })).toHaveAttribute('title', `sakuga-software/${LONG_REPO_NAME} (private)`)
      await expect(row.getByText('claude-sonnet-4-5')).toBeVisible()

      let layout = await page.evaluate(() => {
        let wrap = document.querySelector('.table-wrap')!
        let box = wrap.getBoundingClientRect()
        // REV-91: a row shows "Enable" and the menu "…"; "Disable Kentō…" is in the menu.
        let actions = [...document.querySelectorAll('.row-action > .button, .row-action > .row-menu-box > .row-menu-trigger')].map((button) => {
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

      let { trigger, menu } = menuOf(page, LONG_REPO_NAME)
      await trigger.click()
      let disable = menu.getByRole('menuitem', { name: /^Disable/ })
      await expect(disable).toBeInViewport({ ratio: 1 })
      let right = await disable.evaluate((el) => el.getBoundingClientRect().right - window.innerWidth)
      expect(right, `"Disable" at ${viewport} px`).toBeLessThanOrEqual(0)
      // The open menu covers the row under it: closed again for axe.
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
    }
    await expectNoAxeViolations(page)
  })

  test('a click inside the confirmation keeps it open; a link of the menu goes to its page at the keyboard (Kentō #d30d83, KNT-163)', async ({ page }) => {
    await signIn(page, 'octocat')
    await checkNow(page)
    let row = rowOf(page, 'orchard')
    let enable = row.getByRole('button', { name: 'Enable orchard' })
    if (await enable.count()) {
      await enable.click()
      await expect(page.getByRole('status').filter({ hasText: 'orchard is enabled.' })).toBeVisible()
    }
    await hydrated(page)
    let { trigger, menu } = menuOf(page, 'orchard')
    await trigger.click()
    await menu.getByRole('menuitem', { name: 'Disable orchard Kentō…' }).click()
    let dialog = page.getByRole('dialog', { name: 'Disable orchard Kentō…' })
    await dialog.getByText('The published reviews stay').click()
    await expect(dialog).toBeVisible()
    // A click outside closes it, and leaves the focus where it went.
    await page.getByRole('heading', { level: 1, name: 'Repos' }).click()
    await expect(dialog).toBeHidden()

    // Enter on "See the findings": the menu closes, then the page changes. Back, the menu is closed.
    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'See the findings' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/findings\?repo=[0-9a-f-]+$/)
    await page.goBack()
    await hydrated(page)
    await expect(menuOf(page, 'orchard').trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(menuOf(page, 'orchard').menu).toBeHidden()
  })

  test('a menu "…" closes on Escape and on a click outside, one open at a time; "Search" shows at the keyboard (REV-91)', async ({ page }) => {
    await signIn(page, 'octocat')
    await checkNow(page)
    await hydrated(page)
    let orchard = menuOf(page, 'orchard')
    let fruitback = menuOf(page, 'fruitback')
    await orchard.trigger.click()
    await expect(orchard.menu).toBeVisible()
    await expect(orchard.trigger).toHaveAttribute('aria-expanded', 'true')
    // An admin's card has no label on its actions either, under 760 px as above.
    expect(await rowOf(page, 'orchard').locator('.row-action').evaluate((cell) => getComputedStyle(cell, '::before').content)).toBe('none')
    // A click on another "…" closes the open menu and opens its own: one menu open at a time.
    await fruitback.trigger.click()
    await expect(fruitback.menu).toBeVisible()
    await expect(orchard.menu).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(fruitback.menu).toBeHidden()
    await expect(fruitback.trigger).toBeFocused()
    await fruitback.trigger.click()
    await page.getByRole('heading', { level: 1, name: 'Repos' }).click()
    await expect(fruitback.menu).toBeHidden()
    // A click outside gives the focus to what it clicked, not back to "…": a field keeps it.
    let search = page.getByRole('searchbox', { name: 'Search a repo by its name' })
    await fruitback.trigger.click()
    await expect(fruitback.menu).toBeVisible()
    await search.click()
    await expect(fruitback.menu).toBeHidden()
    // The menu would give the focus back to "…" a frame or two later: it does not.
    await page.waitForTimeout(300)
    await expect(search).toBeFocused()
    // A slow click (700 ms between press and release) too, on the row beside the menu: the menu
    // closes on the release, and "…" does not take the focus back then (Fable critique P2-2).
    await fruitback.trigger.click()
    await expect(fruitback.menu).toBeVisible()
    let cell = (await rowOf(page, 'fruitback').getByRole('rowheader').boundingBox())!
    await page.mouse.move(cell.x + 4, cell.y + cell.height - 4)
    await page.mouse.down()
    await page.waitForTimeout(700)
    await page.mouse.up()
    await expect(fruitback.menu).toBeHidden()
    await page.waitForTimeout(300)
    await expect(fruitback.trigger).not.toBeFocused()
    // A click on the "…" of another row: the focus goes to its open menu.
    await orchard.trigger.click()
    await fruitback.trigger.click()
    await expect(fruitback.menu).toBeVisible()
    await page.waitForTimeout(300)
    await expect(fruitback.menu).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(fruitback.menu).toBeHidden()
    // Escape gives the focus back to "…", once the menu has closed.
    await expect(fruitback.trigger).toBeFocused()

    let submit = page.getByRole('button', { name: 'Search', exact: true })
    expect((await submit.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1)
    await search.focus()
    await page.keyboard.press('Tab')
    await expect(submit).toBeFocused()
    expect((await submit.boundingBox())!.width).toBeGreaterThan(40)
    await expectNoAxeViolations(page)
  })

  test('on a screen of 280 px, the menu "…" and its confirmation stay inside the screen (REV-91)', async ({ page }) => {
    await signIn(page, 'octocat')
    await checkNow(page)
    let row = rowOf(page, 'orchard')
    let enable = row.getByRole('button', { name: 'Enable orchard' })
    if (await enable.count()) {
      await enable.click()
      await expect(page.getByRole('status').filter({ hasText: 'orchard is enabled.' })).toBeVisible()
      row = rowOf(page, 'orchard')
    }
    await page.setViewportSize({ width: 280, height: 800 })
    await hydrated(page)
    let { trigger, menu } = menuOf(page, 'orchard')
    await trigger.click()
    let inside = (el: Element) => {
      let box = el.getBoundingClientRect()
      return box.left >= 0 && box.right <= window.innerWidth
    }
    expect(await page.locator('.row-menu-popover:popover-open').evaluate(inside)).toBe(true)
    await menu.getByRole('menuitem', { name: 'Disable orchard Kentō…' }).click()
    expect(await page.getByRole('dialog', { name: 'Disable orchard Kentō…' }).evaluate(inside)).toBe(true)
  })

  test('a long list: 25 rows a page, numbered pages, the enabled ones first, a search and the filters (REV-36, KNT-146)', async ({ page }) => {
    await signIn(page, 'octocat')
    await checkNow(page)
    let sql = database()
    try {
      await sql`
        insert into repos (org_id, installation_id, github_repo_id, full_name, enabled, workflow)
        select org_id, installation_id, 880000 + g, 'sakuga-software/bulk-' || lpad(g::text, 2, '0'), false, 'none'
        from repos, generate_series(1, 60) g where full_name = 'sakuga-software/orchard'`
      await sql`update repos set enabled = true where full_name = 'sakuga-software/orchard'`

      await page.goto('/repos')
      let rows = page.locator('tbody tr')
      await expect(rows).toHaveCount(25)
      await expect(rows.first().getByRole('rowheader')).toHaveText(/^orchard/)
      let total = Number(await page.getByRole('link', { name: /^All/ }).locator('.list-filter-count').textContent())
      let pager = page.getByRole('navigation', { name: 'Pages of the list' })
      await expect(page.locator('.pager-range')).toHaveText(`1 to 25 of ${total}`)
      await expect(pager.getByRole('link', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page')
      await pager.getByRole('link', { name: 'Next' }).click()
      await expect(page).toHaveURL(/[?&]page=2(&|$)/)
      await expect(page.locator('.pager-range')).toHaveText(`26 to 50 of ${total}`)
      await expect(pager.getByRole('link', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page')
      await pager.getByRole('link', { name: 'Page 3' }).click()
      await expect(page.locator('.pager-range')).toHaveText(`51 to ${Math.min(75, total)} of ${total}`)
      await pager.getByRole('link', { name: 'Previous' }).click()
      await expect(page.locator('.pager-range')).toHaveText(`26 to 50 of ${total}`)
      await pager.getByRole('link', { name: 'Previous' }).click()
      await expect(page.locator('.pager-range')).toHaveText(`1 to 25 of ${total}`)
      await expect(page).not.toHaveURL(/[?&]page=/)

      // REV-91: Enter sends the search, with no visible button. KNT-146: from page 2, it starts at page 1.
      await page.goto('/repos?page=2')
      await page.getByRole('searchbox', { name: 'Search a repo by its name' }).fill('BULK-0')
      await page.getByRole('searchbox', { name: 'Search a repo by its name' }).press('Enter')
      await expect(rows).toHaveCount(9)
      await expect(page).not.toHaveURL(/[?&]page=/)
      await expect(page.locator('.pager')).toHaveCount(0)

      await page.getByRole('link', { name: /^Enabled/ }).click()
      await expect(page.getByText('No repo matches')).toBeVisible()
      await page.getByRole('searchbox', { name: 'Search a repo by its name' }).fill('')
      await page.getByRole('searchbox', { name: 'Search a repo by its name' }).press('Enter')
      await expect(page).toHaveURL(/[?&]filter=enabled(&|$)/)
      await expect(rows).toHaveCount(1)

      // Enabled from page 2 of a search in "Not enabled", a repository comes back to that page.
      await page.goto('/repos?filter=disabled&q=bulk')
      await page.getByRole('link', { name: 'Page 3' }).click()
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

  test('"Enable" and "Disable" change the row in place: no reload, no jump, the focus stays in the row, an error in the row (KNT-147)', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'octocat')
    await checkNow(page)
    let sql = database()
    try {
      await sql`
        insert into repos (org_id, installation_id, github_repo_id, full_name, enabled, workflow)
        select org_id, installation_id, 890000 + g, 'sakuga-software/zz-' || lpad(g::text, 2, '0'), false, 'none'
        from repos, generate_series(1, 20) g where full_name = 'sakuga-software/orchard'`
      // One page of 20 rows, whatever the other tests added to the org.
      await page.goto('/repos?q=zz-')
      // A row far down the page: the case of the ticket.
      let row = rowOf(page, 'zz-18')
      await row.getByRole('button', { name: 'Enable zz-18' }).scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200)
      // Where the row is on the screen: the notice above it can grow the page, and the browser then
      // scrolls by as much (scroll anchoring), so the row does not move on screen.
      let top = async () => Math.round((await rowOf(page, 'zz-18').boundingBox())!.y)
      let before = await top()
      // A mark on the window: a reload would lose it.
      await page.evaluate(() => ((window as unknown as { kept: number }).kept = 1))

      await row.getByRole('button', { name: 'Enable zz-18' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'zz-18 is enabled.' })).toBeAttached()
      row = rowOf(page, 'zz-18')
      // KNT-181: no tag "Kentō" any more; an enabled repository has no "Kentō not enabled" under its precision.
      await expect(row.locator('td').nth(4)).toHaveText('–')
      await expect(row.getByRole('button', { name: 'Enable zz-18' })).toHaveCount(0)
      expect(await page.evaluate(() => (window as unknown as { kept?: number }).kept)).toBe(1)
      // The row keeps its place until the next load, marked; the page does not scroll.
      await expect(row).toBeInViewport()
      await expect(row).toHaveClass(/\brow-changed\b/)
      // KNT-163: the menu "…" of the new row hydrates, and keeps the focus.
      await expect(menuOf(page, 'zz-18').trigger).toBeFocused()
      expect(Math.abs((await top()) - before)).toBeLessThan(4)
      // The counts of the screen follow.
      await expect(page.getByRole('link', { name: /^Enabled/ }).locator('.list-filter-count')).toHaveText('1')

      // In "Not enabled", the row leaves the filter: it stays on screen until the next load.
      await page.goto('/repos?filter=disabled&q=zz-')
      await rowOf(page, 'zz-05').getByRole('button', { name: 'Enable zz-05' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'zz-05 is enabled.' })).toBeAttached()
      await expect(rowOf(page, 'zz-05').locator('td').nth(4)).toHaveText('–')
      await expect(menuOf(page, 'zz-05').trigger).toBeFocused()

      // Saved, but its row cannot be read (the network goes after the change): no message of a
      // failure; the browser goes to the screen of the redirect (Kentō #e074d4).
      await page.route(/\/repos\?q=/, (route) => route.abort())
      await rowOf(page, 'zz-07').getByRole('button', { name: 'Enable zz-07' }).click()
      await page.waitForURL(/[?&]done=enabled&repo=[0-9a-f-]+#repo-/)
      await page.unroute(/\/repos\?q=/)
      await expect(page.getByRole('status').filter({ hasText: 'zz-07 is enabled.' })).toBeVisible()
      await expect(page.locator('.row-error')).toHaveCount(0)

      // A row at the top of the screen: the page does not move either.
      await page.goto('/repos?q=zz-')
      await page.evaluate(() => ((window as unknown as { kept: number }).kept = 1))
      let first = rowOf(page, 'zz-02')
      await first.getByRole('button', { name: 'Enable zz-02' }).scrollIntoViewIfNeeded()
      let still = Math.round((await first.boundingBox())!.y)
      await first.getByRole('button', { name: 'Enable zz-02' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'zz-02 is enabled.' })).toBeAttached()
      await expect(menuOf(page, 'zz-02').trigger).toBeFocused()
      expect(Math.abs(Math.round((await rowOf(page, 'zz-02').boundingBox())!.y) - still)).toBeLessThan(4)
      row = rowOf(page, 'zz-18')

      // Disable, in place too, from the menu of the row that was swapped: the row goes back to
      // "none", with its "Enable" focused. The popover closed before the row went: the page scrolls.
      await (await chooseDisable(page, 'zz-18')).click()
      await expect(page.getByRole('status').filter({ hasText: 'zz-18 is disabled.' })).toBeAttached()
      row = rowOf(page, 'zz-18')
      await expect(row.getByRole('button', { name: 'Enable zz-18' })).toBeFocused()
      await expect(page.locator(':popover-open')).toHaveCount(0)
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe('hidden')
      expect(await page.evaluate(() => (window as unknown as { kept?: number }).kept)).toBe(1)

      // The server refuses: the row says so, and stays as it was; a second try works.
      let refuse = true
      await page.route('**/repos/*/enable*', (route) => (refuse ? route.fulfill({ status: 500, body: 'no' }) : route.continue()))
      await row.getByRole('button', { name: 'Enable zz-18' }).click()
      await expect(row.getByRole('alert')).toHaveText('Kentō did not save this change. Reload the page, then try again.')
      await expect(row.getByRole('button', { name: 'Enable zz-18' })).toBeVisible()
      refuse = false
      await row.getByRole('button', { name: 'Enable zz-18' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'zz-18 is enabled.' })).toBeAttached()
      await expect(rowOf(page, 'zz-18').getByRole('alert')).toHaveCount(0)
      await page.unroute('**/repos/*/enable*')

      // A redirect to another screen that fails is a refusal, not a saved change (Kentō #7cf7a5):
      // the row says so, and the page stays.
      row = rowOf(page, 'zz-18')
      let act = await chooseDisable(page, 'zz-18')
      await page.route('**/repos/*/disable*', (route) =>
        route.fulfill({ status: 303, headers: { Location: '/no-such-screen?done=disabled' } }),
      )
      let here = page.url()
      await act.click()
      await expect(row.getByRole('alert')).toHaveText('Kentō did not save this change. Reload the page, then try again.')
      expect(page.url()).toBe(here)
      await page.unroute('**/repos/*/disable*')
      await page.goto('/repos?q=zz-')

      // A redirect back to this screen, but not the one of a saved change (no `done=`): a refusal
      // too (Kentō #807f15).
      row = rowOf(page, 'zz-18')
      act = await chooseDisable(page, 'zz-18')
      await page.route('**/repos/*/disable*', (route) => route.fulfill({ status: 303, headers: { Location: '/repos?q=zz-' } }))
      await act.click()
      await expect(row.getByRole('alert')).toHaveText('Kentō did not save this change. Reload the page, then try again.')
      await page.unroute('**/repos/*/disable*')
      await page.goto('/repos?q=zz-')

      // The network is gone: the row says so.
      row = rowOf(page, 'zz-18')
      act = await chooseDisable(page, 'zz-18')
      await page.route('**/repos/*/disable*', (route) => route.abort())
      await act.click()
      await expect(row.getByRole('alert')).toHaveText('Kentō could not be reached. Check the connection, then try again.')
      await page.unroute('**/repos/*/disable*')
      await expectNoAxeViolations(page)
      expect(errors.filter((error) => !/Failed to load resource|net::ERR_FAILED/.test(error))).toEqual([])
    } finally {
      await sql`delete from repos where github_repo_id between 890001 and 890020`
      await sql.end()
    }
  })

  test('after rows leave the list in place, the pager follows the server and a line offers to reload; the notice is read in the same live region (KNT-147)', async ({ page }) => {
    await signIn(page, 'octocat')
    await checkNow(page)
    let sql = database()
    try {
      await sql`
        insert into repos (org_id, installation_id, github_repo_id, full_name, enabled, workflow)
        select org_id, installation_id, 891000 + g, 'sakuga-software/pg-' || lpad(g::text, 2, '0'), false, 'none'
        from repos, generate_series(1, 30) g where full_name = 'sakuga-software/orchard'`
      await page.goto('/repos?filter=disabled&q=pg-')
      await expect(page.locator('.pager-range')).toHaveText('1 to 25 of 30')
      // The live region is on the page before any change, empty; the same node gets the notices.
      let slot = page.locator('.notice-slot[role="status"]')
      await expect(slot).toBeEmpty()
      await slot.evaluate((node) => ((window as unknown as { slot: Element }).slot = node))

      for (let n of ['01', '02', '03', '04', '05']) {
        await rowOf(page, `pg-${n}`).getByRole('button', { name: `Enable pg-${n}` }).click()
        await expect(slot).toContainText(`pg-${n} is enabled.`)
      }
      expect(await slot.evaluate((node) => node === (window as unknown as { slot: Element }).slot)).toBe(true)
      // Only the last changed row is marked.
      await expect(page.locator('tr.row-changed')).toHaveCount(1)
      // 25 left in "Not enabled": one page. The pager of the screen said 2; it follows the server now.
      await expect(page.locator('.pager')).toHaveCount(0)
      await expect(page.getByText('The list changed.')).toBeVisible()
      await expect(page.getByRole('link', { name: /^Not enabled/ }).locator('.list-filter-count')).toHaveText(/\d+/)
      await page.getByRole('link', { name: 'Reload' }).click()
      await expect(page.locator('tbody tr')).toHaveCount(25)
      await expect(rowOf(page, 'pg-30')).toBeVisible()
      await expect(rowOf(page, 'pg-01')).toHaveCount(0)
      await expect(page.getByText('The list changed.')).toHaveCount(0)
    } finally {
      await sql`delete from repos where github_repo_id between 891001 and 891030`
      await sql.end()
    }
  })

  test('a row that leaves the last page of a list: the pager of an earlier page is not copied (Kentō #fcb2e3)', async ({ page }) => {
    await signIn(page, 'octocat')
    await checkNow(page)
    let sql = database()
    try {
      await sql`
        insert into repos (org_id, installation_id, github_repo_id, full_name, enabled, workflow)
        select org_id, installation_id, 893000 + g, 'sakuga-software/pc-' || lpad(g::text, 2, '0'), false, 'none'
        from repos, generate_series(1, 51) g where full_name = 'sakuga-software/orchard'`
      await page.goto('/repos?filter=disabled&q=pc-&page=3')
      await expect(page.locator('.pager-range')).toHaveText('51 to 51 of 51')
      // 50 left: the server shows page 2 of 2, not the page 3 on screen.
      await rowOf(page, 'pc-51').getByRole('button', { name: 'Enable pc-51' }).click()
      await expect(page.locator('.notice-slot')).toContainText('pc-51 is enabled.')
      await expect(page.locator('.pager')).toHaveCount(0)
      await expect(page.getByText('The list changed.')).toBeVisible()
      await expect(rowOf(page, 'pc-51').locator('td').nth(4)).toHaveText('–')
    } finally {
      await sql`delete from repos where github_repo_id between 893001 and 893051`
      await sql.end()
    }
  })

  test('a row swapped 4 times in place leaves no listener behind on the document (Fable critique P3-3)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'the listeners are counted through the Chrome DevTools Protocol')
    await signIn(page, 'octocat')
    await checkNow(page)
    await page.goto('/repos')
    await hydrated(page)
    let cdp = await page.context().newCDPSession(page)
    let listeners = async () => {
      let { result } = await cdp.send('Runtime.evaluate', { expression: 'document' })
      let { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId! })
      return listeners.length
    }
    let before = await listeners()
    for (let round = 0; round < 2; round++) {
      await rowOf(page, 'garden').getByRole('button', { name: 'Enable garden' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'garden is enabled.' })).toBeAttached()
      await expect(menuOf(page, 'garden').trigger).toBeFocused()
      await (await chooseDisable(page, 'garden')).click()
      await expect(page.getByRole('status').filter({ hasText: 'garden is disabled.' })).toBeAttached()
      await expect(rowOf(page, 'garden').getByRole('button', { name: 'Enable garden' })).toBeFocused()
      await expect(menuOf(page, 'garden').trigger).toBeVisible()
    }
    expect(await listeners()).toBe(before)
  })

  test('a server that does not answer: the row says so after the timeout (KNT-147)', async ({ page }) => {
    await signIn(page, 'octocat')
    await checkNow(page)
    // 15 s of the script, made short: the clock of the page runs fast.
    await page.clock.install()
    await page.goto('/repos')
    await page.route('**/repos/*/enable*', () => {})
    await rowOf(page, 'garden').getByRole('button', { name: 'Enable garden' }).click()
    await page.clock.runFor(16_000)
    await expect(rowOf(page, 'garden').getByRole('alert')).toHaveText('Kentō could not be reached. Check the connection, then try again.')
    await expect(rowOf(page, 'garden')).not.toHaveAttribute('aria-busy', 'true')
  })

  test('a member reads the list under "Read only", with no action', async ({ page }) => {
    await signIn(page, 'camille')
    await page.goto('/repos')
    await expect(page.getByText('Read only', { exact: true })).toBeVisible()
    await expect(page.getByRole('table')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Enable/ })).toHaveCount(0)
    await expect(page.locator('summary', { hasText: 'Disable' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Read GitHub again' })).toHaveCount(0)
    await hydrated(page)
    await expect(page.getByRole('menuitem', { name: /^Disable/, includeHidden: true })).toHaveCount(0)
    // REV-91: a member keeps the menu "…" with the config and the findings; its cell has no label.
    let row = rowOf(page, 'orchard')
    expect(await row.locator('.row-action').evaluate((cell) => getComputedStyle(cell, '::before').content)).toBe('none')
    // Under 760 px each other cell keeps its label, "Precision 30 d" included for a repo without Kentō.
    if (page.viewportSize()!.width <= 760) {
      let gh = rowOf(page, 'garden')
      expect(await gh.locator('td').nth(3).evaluate((cell) => getComputedStyle(cell, '::before').content)).toBe('"Confidence 30 d"')
      expect(await gh.locator('td').nth(4).evaluate((cell) => getComputedStyle(cell, '::before').content)).toBe('"Precision 30 d"')
      await expect(gh.locator('td').nth(4)).toContainText('Kentō not enabled')
    }
    let { trigger, menu } = menuOf(page, 'orchard')
    await trigger.click()
    for (let name of ['Open the config', 'See the findings']) {
      await expect(menu.getByRole('menuitem', { name })).toBeInViewport({ ratio: 1 })
    }
    await expectNoAxeViolations(page)
  })
})

test.describe('the Repos screen without JavaScript', () => {
  test.use({ javaScriptEnabled: false })

  test('"Enable" posts the form and comes back to the row, with no script (KNT-147)', async ({ page, browser, baseURL }) => {
    await reset()
    let reader = await browser.newContext({ baseURL, javaScriptEnabled: true })
    let readerPage = await reader.newPage()
    await signIn(readerPage, 'octocat')
    await checkNow(readerPage)
    await reader.close()

    await signIn(page, 'octocat')
    await page.goto('/repos')
    await rowOf(page, 'orchard').getByRole('button', { name: 'Enable orchard' }).click()
    await expect(page).toHaveURL(/[?&]done=enabled&repo=[0-9a-f-]+#repo-[0-9a-f-]+$/)
    await expect(page.getByRole('status').filter({ hasText: 'orchard is enabled.' })).toBeVisible()
    await expect(rowOf(page, 'orchard').getByRole('button', { name: 'Enable orchard' })).toHaveCount(0)
  })

  test('the toast of a result shows without a script, and its close link loads the page without it (KNT-184)', async ({ page }) => {
    await signIn(page, 'octocat')
    await page.goto('/repos?q=or&done=checked')
    let toast = page.getByRole('status').locator('.toast')
    await expect(toast).toContainText('List up to date.')
    // No script to clean the URL: the close link does it.
    await expect(page).toHaveURL(/done=checked/)
    await toast.getByRole('link', { name: 'Close the message' }).click()
    await expect(page).toHaveURL(/\/repos\?q=or$/)
    await expect(page.locator('.toast')).toHaveCount(0)
  })

  test('the menu "…" of the last row opens upwards, inside the table (REV-91)', async ({ page, browser, baseURL }) => {
    // The list comes from GitHub: read once in a browser with JavaScript, which waits for it.
    let reader = await browser.newContext({ baseURL, javaScriptEnabled: true })
    let readerPage = await reader.newPage()
    await signIn(readerPage, 'octocat')
    await checkNow(readerPage)
    await reader.close()

    await signIn(page, 'octocat')
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

  test('KNT-163: the menu "…" and its confirmation work as a <details>: enable, then disable orchard', async ({ page }) => {
    await signIn(page, 'octocat')
    await page.goto('/repos')
    // No runtime: the page keeps the HTML of the server.
    await expect(page.locator('html')).not.toHaveAttribute('data-hydrated', '')
    let row = rowOf(page, 'orchard')
    let enable = row.getByRole('button', { name: 'Enable orchard' })
    if (await enable.count()) {
      await enable.click()
      await expect(page.getByRole('status').filter({ hasText: 'orchard is enabled.' })).toBeVisible()
      row = rowOf(page, 'orchard')
    }
    await row.locator('.row-menu > summary').click()
    await expect(row.getByRole('link', { name: 'Open the config' })).toBeVisible()
    await expect(row.getByRole('link', { name: 'See the findings' })).toHaveAttribute('href', /\/findings\?repo=[0-9a-f-]+$/)
    await row.locator('.row-menu .confirm > summary').click()
    await expect(row).toContainText('The published reviews stay')
    await row.getByRole('button', { name: 'Disable orchard' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'orchard is disabled.' })).toBeVisible()
  })
})
