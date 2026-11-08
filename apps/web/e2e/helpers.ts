import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'

/** Fails on any WCAG 2.2 A or AA violation that axe finds on the page. */
export async function expectNoAxeViolations(page: Page) {
  let results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  let summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(summary, 'axe violations').toEqual([])
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

/** REV-91: on the Repos screen, opens the menu « … » of a repository and its link « Ouvrir la config ». */
export async function openRepoConfig(page: Page, repo: string) {
  await page.locator(`summary[aria-label="Actions de ${repo}"]`).click()
  await page.locator(`summary[aria-label="Actions de ${repo}"] + div`).getByRole('link', { name: 'Ouvrir la config' }).click()
}

/**
 * Signs in through the sign-in page and the fake GitHub, as one of its accounts
 * (e2e/fake-github.ts), and puts the org of the fake in the database first.
 */
export async function signIn(page: Page, login: 'alex' | 'camille' | 'stranger') {
  await seedOrg()
  await page.goto('/login')
  await page.getByRole('link', { name: 'Continuer avec GitHub' }).click()
  await page.getByRole('link', { name: `Authorize as ${login}` }).click()
}

let seeded = false

async function seedOrg() {
  if (seeded) return
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
  try {
    await sql`
      insert into orgs (github_installation_id, github_account_id, login)
      values (${FAKE_ORG.installationId}, ${FAKE_ORG.accountId}, ${FAKE_ORG.login})
      on conflict (github_installation_id) do nothing
    `
    seeded = true
  } finally {
    await sql.end()
  }
}
