import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'
import postgres from 'postgres'

import { seedFakeOrg } from './pull-seed.ts'

/** Fails on any WCAG 2.2 A or AA violation that axe finds on the page. */
export async function expectNoAxeViolations(page: Page) {
  let results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  let summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(summary, 'axe violations').toEqual([])
}

/**
 * KNT-143. The text of every visible button-like link or summary contrasts with its background, or
 * with the first opaque background behind a transparent one (4.5:1 at least). axe reports a link with `background-color` on itself as "incomplete", not as a
 * violation: an ink-on-ink primary link passed it.
 */
export async function expectReadableButtons(page: Page) {
  let bad = await page.evaluate(() => {
    let rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number)
    let luminance = ([r, g, b]: number[]) => {
      let [R, G, B] = [r!, g!, b!].map((c) => {
        let s = c / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!
    }
    let out: string[] = []
    for (let el of document.querySelectorAll<HTMLElement>('a.button, summary.button')) {
      if (el.offsetParent === null) continue
      let style = getComputedStyle(el)
      // A ghost or outline link is transparent: its text sits on the first opaque background behind it.
      let behind: Element | null = el
      let background = 'rgb(255, 255, 255)'
      while (behind) {
        let value = getComputedStyle(behind).backgroundColor
        let parts = rgb(value)
        if (parts.length === 3 || (parts.length === 4 && parts[3]! > 0)) {
          background = value
          break
        }
        behind = behind.parentElement
      }
      let [a, b] = [luminance(rgb(style.color)), luminance(rgb(background))].sort((x, y) => y - x)
      let ratio = (a! + 0.05) / (b! + 0.05)
      if (ratio < 4.5) out.push(`${el.textContent?.trim()}: ${style.color} on ${background} (${ratio.toFixed(2)}:1)`)
    }
    return out
  })
  expect(bad, 'button-like links with unreadable text').toEqual([])
}

/** Collects the errors of the console (a CSP violation is one), for a check at the end of a test. */
export function watchConsole(page: Page): string[] {
  let errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

/** REV-91: on the Repos screen, opens the menu "…" of a repository and its link "Open the config". */
export async function openRepoConfig(page: Page, repo: string) {
  await page.locator(`summary[aria-label="Actions of ${repo}"]`).click()
  await page.locator(`summary[aria-label="Actions of ${repo}"] + div`).getByRole('link', { name: 'Open the config' }).click()
}

/**
 * KNT-149: follows a link of the sidebar of the settings. Under 900 px the list is folded under
 * "Section …": the helper opens it first, and the link folds it again.
 */
export async function goToSettingsLink(page: Page, name: string) {
  let nav = page.getByRole('navigation', { name: 'Sections of the settings' })
  let toggle = nav.locator('[data-settings-nav-toggle]')
  if (await toggle.isVisible()) {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  }
  await nav.getByRole('link', { name, exact: true }).click()
}

/**
 * Signs in through the sign-in page and the fake GitHub, as one of its accounts
 * (e2e/fake-github.ts), and puts the org of the fake in the database first.
 */
export async function signIn(page: Page, login: 'octocat' | 'camille' | 'stranger') {
  await seedOrg()
  await page.goto('/login')
  await page.getByRole('link', { name: 'Continue with GitHub' }).click()
  await page.getByRole('link', { name: `Authorize as ${login}` }).click()
}

let seeded = false

async function seedOrg() {
  if (seeded) return
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
  try {
    await seedFakeOrg(sql)
    seeded = true
  } finally {
    await sql.end()
  }
}
