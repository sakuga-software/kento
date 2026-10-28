import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

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
