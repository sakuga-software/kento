import { expect, test, type Locator, type Page } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { hydrated, signIn } from './helpers.ts'

// KNT-186. The lists of the selects, the menus "…", the confirmations and the menu of the orgs open
// (140 ms) and close (80 ms) with a fade, none under prefers-reduced-motion. Each one is at least as
// wide as the box that opens it, and stays inside the screen. A menu of the orgs that closes is out
// of reach at once.

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** A finding on orchard, so that Findings shows its filters. */
async function withFinding(run: () => Promise<void>) {
  let sql = database()
  try {
    let [org] = await sql<{ id: string }[]>`select org_id as id from installations where github_installation_id = ${FAKE_ORG.installationId}`
    await sql`
      insert into repos (org_id, installation_id, github_repo_id, full_name)
      values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 7001, 'sakuga-software/orchard')
      on conflict (github_repo_id) do nothing`
    await sql`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status, first_seen_sha, last_seen_sha)
      select id, 1, 'knt-186', 'knt-186', 'a.ts', 1, 'A finding for KNT-186', 'minor', 'bug', 80, 'open', ${'a'.repeat(40)}, ${'a'.repeat(40)}
      from repos where github_repo_id = 7001 on conflict do nothing`
    await run()
  } finally {
    await sql`delete from findings where fingerprint = 'knt-186'`
    await sql.end()
  }
}

/**
 * The transitions that start on the page: a `transitionrun` listener armed before the action, so
 * that a slow round trip of the test cannot miss them. Each entry: the class of the panel,
 * the property, the duration in ms.
 */
async function watchTransitions(page: Page) {
  await page.evaluate(() => {
    let runs: string[] = []
    ;(window as unknown as { transitionRuns: string[] }).transitionRuns = runs
    document.addEventListener(
      'transitionrun',
      (event) => {
        let element = event.target as Element
        let duration = Math.round(parseFloat(getComputedStyle(element).transitionDuration.split(',')[0]!) * 1000)
        let name = ['select-popover', 'row-menu-popover', 'confirm-popover', 'org-menu-panel'].find((known) => element.classList.contains(known)) ?? element.classList[0]
        runs.push(`${name} ${event.propertyName} ${duration}`)
      },
      true,
    )
  })
  /** Runs `action`, then the transitions that it started, once they are in. */
  return async (action: () => Promise<unknown>, expected: string[]) => {
    await page.evaluate(() => ((window as unknown as { transitionRuns: string[] }).transitionRuns.length = 0))
    await action()
    if (expected.length === 0) {
      await page.waitForTimeout(200)
      expect(await page.evaluate(() => (window as unknown as { transitionRuns: string[] }).transitionRuns)).toEqual([])
      return
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as { transitionRuns: string[] }).transitionRuns)).toEqual(expect.arrayContaining(expected))
  }
}

/** The box of an element, rounded. */
async function boxOf(locator: Locator) {
  let box = (await locator.boundingBox())!
  return { left: Math.round(box.x), right: Math.round(box.x + box.width), width: Math.round(box.width) }
}

async function viewportWidth(page: Page) {
  return page.evaluate(() => document.documentElement.clientWidth)
}

test.describe('the motion and the width of the lists and menus (KNT-186)', () => {
  test('a select list fades in and out, as wide as its box at least, inside the screen', async ({ page }) => {
    await signIn(page, 'octocat')
    await withFinding(async () => {
      await page.goto('/findings')
      await hydrated(page)
      let fades = await watchTransitions(page)
      let screen = await viewportWidth(page)
      let selects = page.locator('button[aria-haspopup="listbox"]:not([disabled])')
      expect(await selects.count()).toBeGreaterThan(1)
      for (let select of await selects.all()) {
        await fades(() => select.click(), ['select-popover opacity 140', 'select-popover translate 140'])
        let list = page.locator('.select-popover:popover-open')
        await expect(list.getByRole('listbox')).toBeFocused()
        let trigger = await boxOf(select)
        let box = await boxOf(list)
        expect(box.width, 'at least as wide as its box').toBeGreaterThanOrEqual(trigger.width - 1)
        expect(box.left).toBeGreaterThanOrEqual(0)
        expect(box.right).toBeLessThanOrEqual(screen)
        await fades(() => page.keyboard.press('Escape'), ['select-popover opacity 80', 'select-popover translate 80'])
        await expect(page.locator('.select-popover:popover-open')).toHaveCount(0)
        await expect(select).toBeFocused()
      }
    })
  })

  test('a menu "…" and its confirmation fade in and out', async ({ page }) => {
    await signIn(page, 'octocat')
    await page.goto('/repos')
    await page.getByRole('button', { name: 'Read GitHub again' }).click()
    await expect(page.getByText('List up to date.')).toBeVisible()
    let enable = page.getByRole('button', { name: 'Enable orchard' })
    if (await enable.count()) {
      await enable.click()
      await expect(page.getByRole('status').filter({ hasText: 'orchard is enabled.' })).toBeVisible()
    }
    await hydrated(page)
    let fades = await watchTransitions(page)
    let trigger = page.getByRole('button', { name: 'Actions of orchard', exact: true })
    let menu = page.getByRole('menu', { name: 'Actions of orchard' })
    await fades(() => trigger.click(), ['row-menu-popover opacity 140', 'row-menu-popover translate 140'])
    await expect(menu).toBeVisible()
    let dialog = page.getByRole('dialog', { name: 'Disable orchard Kentō…' })
    // The menu fades out, then the confirmation fades in.
    await fades(() => menu.getByRole('menuitem', { name: 'Disable orchard Kentō…' }).click(), [
      'row-menu-popover opacity 80',
      'confirm-popover opacity 140',
      'confirm-popover translate 140',
    ])
    await expect(dialog).toBeVisible()
    await fades(() => page.keyboard.press('Escape'), ['confirm-popover opacity 80', 'confirm-popover translate 80'])
    await expect(dialog).toBeHidden()
  })

  test('the menu of the orgs fades, starts at the right edge of its box, and stays inside the screen', async ({ page }, testInfo) => {
    await signIn(page, 'octocat')
    await page.goto('/repos')
    let fades = await watchTransitions(page)
    let summary = page.locator('details.org-menu > summary')
    let panel = page.locator('.org-menu-panel')
    await fades(() => summary.click(), ['org-menu-panel opacity 140', 'org-menu-panel translate 140'])
    await expect(panel).toBeVisible()
    let screen = await viewportWidth(page)
    let box = await boxOf(summary)
    let menu = await boxOf(panel)
    expect(menu.left).toBeGreaterThanOrEqual(0)
    expect(menu.right).toBeLessThanOrEqual(screen)
    expect(menu.width).toBeGreaterThanOrEqual(box.width)
    if (testInfo.project.name === 'desktop') {
      // Under the box, its right edge on the right edge of the box, and never narrower than the box.
      expect(Math.abs(menu.right - box.right)).toBeLessThanOrEqual(1)
      expect(await panel.evaluate((element) => getComputedStyle(element).minWidth)).toBe('100%')
    } else {
      // On a phone, the width of the screen less its gutters (16 px each side).
      expect(menu.left).toBe(16)
      expect(menu.right).toBe(screen - 16)
    }
    // Closing: it fades out in 80 ms where the browser has ::details-content (Kentō #907a06); else at once.
    let fadeOut = (await page.evaluate(() => CSS.supports('selector(::details-content)'))) ? ['org-menu-panel opacity 80'] : []
    await fades(() => summary.click(), fadeOut)
    await expect(panel).toBeHidden()
  })

  test('a menu of the orgs that closes is out of reach at once: no click, no focus (critique P2-1)', async ({ page }) => {
    await signIn(page, 'octocat')
    await page.goto('/repos')
    let summary = page.locator('details.org-menu > summary')
    let link = page.locator('.org-menu-link').first()
    // The mouse: one frame after the close, the point of the first link is the page, not the link.
    await summary.click()
    await expect(link).toBeVisible()
    let box = (await link.boundingBox())!
    await summary.click()
    let under = await page.evaluate(
      ([x, y]) => new Promise<string>((resolve) => requestAnimationFrame(() => resolve(document.elementFromPoint(x!, y!)?.className ?? ''))),
      [box.x + box.width / 2, box.y + box.height / 2],
    )
    expect(under).not.toContain('org-menu')
    // The keyboard: Enter opens, Enter closes, Tab at once goes past the menu, and stays on a control.
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(link).toBeVisible()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    let focused = () => page.evaluate(() => ({ tag: document.activeElement?.tagName, inMenu: !!document.activeElement?.closest('.org-menu-panel') }))
    expect(await focused()).toEqual(expect.objectContaining({ inMenu: false }))
    await page.waitForTimeout(200)
    let after = await focused()
    expect(after.inMenu).toBe(false)
    expect(after.tag).not.toBe('BODY')
  })

  for (let [width, height] of [[1440, 900], [360, 740]] as const) {
    test(`a long name of org is cut in its box and in the menu, with no sideways scroll, at ${width} px (critique P2-2)`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'one viewport per test')
      let long = 'an-extremely-long-organization-name-for-a-test-of-the-menu-width'
      let sql = database()
      let [org] = await sql<{ id: string; name: string }[]>`
        select orgs.id, orgs.name from orgs join installations on installations.org_id = orgs.id
        where installations.github_installation_id = ${FAKE_ORG.installationId}`
      try {
        await sql`update orgs set name = ${long} where id = ${org!.id}`
        await page.setViewportSize({ width, height })
        await signIn(page, 'octocat')
        await page.goto('/repos')
        let summary = page.locator('details.org-menu > summary')
        await expect(summary).toHaveAttribute('title', long)
        await summary.click()
        let panel = page.locator('.org-menu-panel')
        await expect(panel).toBeVisible()
        let item = panel.locator('.org-menu-item', { hasText: long.slice(0, 20) })
        await expect(item).toHaveAttribute('title', long)
        let menu = await boxOf(panel)
        let row = await boxOf(item)
        expect(row.right, 'the item inside the menu').toBeLessThanOrEqual(menu.right)
        expect(menu.right).toBeLessThanOrEqual(width)
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'no sideways scroll').toBeLessThanOrEqual(0)
      } finally {
        await sql`update orgs set name = ${org!.name} where id = ${org!.id}`
        await sql.end()
      }
    })
  }

  test('nothing moves under prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await signIn(page, 'octocat')
    await withFinding(async () => {
      await page.goto('/findings')
      await hydrated(page)
      let fades = await watchTransitions(page)
      await fades(() => page.locator('button[aria-haspopup="listbox"]:not([disabled])').first().click(), [])
      let list = page.locator('.select-popover:popover-open')
      await expect(list).toHaveCount(1)
      expect(await list.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
      await fades(() => page.keyboard.press('Escape'), [])
      expect(await page.locator('.select-popover:visible').count()).toBe(0)
    })
    await page.goto('/repos')
    let fades = await watchTransitions(page)
    await fades(() => page.locator('details.org-menu > summary').click(), [])
    expect(await page.locator('.org-menu-panel').evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  })
})
