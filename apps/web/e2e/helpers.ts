import AxeBuilder from '@axe-core/playwright'
import { expect, type Locator, type Page } from '@playwright/test'
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

/** KNT-163: waits until the components of the page have hydrated (app/ui/public/runtime.ts). */
export async function hydrated(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', '')
}

/**
 * KNT-165: chooses an option of a select of the screens, the select of @remix-run/ui once it
 * hydrated (`selectOption` of Playwright is for the native one, which hydration hides). `option`:
 * its value, or `{ label }`.
 */
export async function chooseOption(scope: Page | Locator, label: string, option: string | { label: string }) {
  let page = 'page' in scope ? scope.page() : scope
  // Before hydration the label names the native select: this waits for the button.
  let trigger = scope.getByLabel(label, { exact: true }).and(page.locator('button[aria-haspopup="listbox"]'))
  await trigger.click()
  let list = page.locator('.select-popover:popover-open')
  let choice =
    typeof option === 'string'
      ? list.locator(`[role="option"][data-value="${option}"]`)
      : list.getByRole('option', { name: option.label, exact: true })
  await choice.click()
  await expect(list).toHaveCount(0)
}

/** KNT-165: the value of a select of the screens, from the hidden input that the form posts. */
export function selectValue(scope: Page | Locator, name: string) {
  return scope.locator(`input[type="hidden"][data-select][name="${name}"]`)
}

/** REV-91: on the Repos screen, opens the menu "…" of a repository and its item "Open the config". */
export async function openRepoConfig(page: Page, repo: string) {
  await page.getByRole('button', { name: `Actions of ${repo}`, exact: true }).click()
  await page.getByRole('menu', { name: `Actions of ${repo}` }).getByRole('menuitem', { name: 'Open the config' }).click()
}

/**
 * KNT-164: serves kento.css with another line height for the labels of the fields (18 px for
 * example), from the first page. The content security policy refuses an inline style, and a style
 * added after the load comes too late for the scroll to a field in error.
 */
export async function withLabelLineHeight(page: Page, lineHeight: string) {
  await page.route('**/assets/kento.css*', async (route) => {
    let response = await route.fetch()
    await route.fulfill({ response, body: `${await response.text()}\n.label { line-height: ${lineHeight}; }\n` })
  })
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
