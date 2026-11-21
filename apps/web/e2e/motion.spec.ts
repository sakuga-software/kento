import { expect, test, type Locator, type Page } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { hydrated, signIn } from './helpers.ts'

// KNT-186. The lists of the selects, the menus and the menu of the orgs open and close with a short
// fade (140 ms), none under prefers-reduced-motion; each one is at least as wide as the box that
// opens it, and stays inside the screen.

/** A finding on orchard, so that Findings shows its filters. */
async function withFinding(run: () => Promise<void>) {
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
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

/** The transitions that run on `locator` now: their property and their duration in ms. */
function transitionsOf(locator: Locator) {
  return locator.evaluate((element) =>
    element
      .getAnimations()
      .filter((animation): animation is CSSTransition => animation instanceof CSSTransition)
      .map((animation) => `${animation.transitionProperty} ${Number(animation.effect?.getTiming().duration)}`)
      .sort(),
  )
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
      let screen = await viewportWidth(page)
      let selects = page.locator('button[aria-haspopup="listbox"]:not([disabled])')
      expect(await selects.count()).toBeGreaterThan(1)
      for (let select of await selects.all()) {
        await select.click()
        let list = page.locator('.select-popover:popover-open')
        // Opening: the fade runs, 140 ms.
        expect(await transitionsOf(list)).toEqual(expect.arrayContaining(['opacity 140', 'translate 140']))
        await expect(list.getByRole('listbox')).toBeFocused()
        await expect.poll(() => transitionsOf(list)).toEqual([])
        let trigger = await boxOf(select)
        let box = await boxOf(list)
        expect(box.width, 'at least as wide as its box').toBeGreaterThanOrEqual(trigger.width - 1)
        expect(box.left).toBeGreaterThanOrEqual(0)
        expect(box.right).toBeLessThanOrEqual(screen)
        // Closing: the list is no longer open, but fades out before it hides.
        let id = await list.getAttribute('id').then(() => list.evaluate((element) => element.querySelector('[role="listbox"]')!.id))
        await page.keyboard.press('Escape')
        let closing = page.locator('.select-popover', { has: page.locator(`[id="${id}"]`) })
        expect(await transitionsOf(closing)).toEqual(expect.arrayContaining(['opacity 140', 'translate 140']))
        await expect(closing).toBeHidden()
        await expect(select).toBeFocused()
      }
    })
  })

  test('the menu of the orgs fades in, starts at the right edge of its box, and stays inside the screen', async ({ page }, testInfo) => {
    await signIn(page, 'octocat')
    await page.goto('/repos')
    let summary = page.locator('details.org-menu > summary')
    let panel = page.locator('.org-menu-panel')
    await summary.click()
    expect(await transitionsOf(panel)).toEqual(['opacity 140', 'translate 140'])
    await expect.poll(() => transitionsOf(panel)).toEqual([])
    let screen = await viewportWidth(page)
    let box = await boxOf(summary)
    let menu = await boxOf(panel)
    expect(menu.left).toBeGreaterThanOrEqual(0)
    expect(menu.right).toBeLessThanOrEqual(screen)
    expect(menu.width).toBeGreaterThanOrEqual(box.width)
    if (testInfo.project.name === 'desktop') {
      // Under the box, its right edge on the right edge of the box.
      expect(Math.abs(menu.right - box.right)).toBeLessThanOrEqual(1)
    } else {
      // On a phone, the width of the screen less its gutters (16 px each side).
      expect(menu.left).toBe(16)
      expect(menu.right).toBe(screen - 16)
    }
    // Closing: it fades out too, then the content of the <details> hides. Kentō #907a06: only where
    // the browser has ::details-content (Chromium 131 and later, Safari 18.4); elsewhere it closes at once.
    await summary.click()
    if (await page.evaluate(() => CSS.supports('selector(::details-content)'))) {
      expect(await transitionsOf(panel)).toEqual(['opacity 140', 'translate 140'])
    }
    await expect(panel).toBeHidden()
  })

  test('nothing moves under prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await signIn(page, 'octocat')
    await withFinding(async () => {
      await page.goto('/findings')
      await hydrated(page)
      await page.locator('button[aria-haspopup="listbox"]:not([disabled])').first().click()
      let list = page.locator('.select-popover:popover-open')
      await expect(list).toHaveCount(1)
      expect(await transitionsOf(list)).toEqual([])
      expect(await list.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
      await page.keyboard.press('Escape')
      // Hidden at once: no list is drawn any more.
      expect(await page.locator('.select-popover:visible').count()).toBe(0)
    })
    await page.goto('/repos')
    await page.locator('details.org-menu > summary').click()
    let panel = page.locator('.org-menu-panel')
    expect(await transitionsOf(panel)).toEqual([])
    expect(await panel.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  })
})
