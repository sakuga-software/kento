import { expect, test } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { expectNoAxeViolations, hydrated, signIn, watchConsole } from './helpers.ts'

// KNT-191. The precision by repo of the dashboard: a chart of Chart.js above the list, over 30 days
// or 7 (`?precision=7`), that stays when the dashboard reads itself again; the list without JavaScript.

const REPO = { id: 7191, fullName: 'sakuga-software/precision-e2e' }

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** 12 findings fixed and 3 dismissed 2 days ago, and 5 fixed 20 days ago: 30 days and 7 days differ. */
async function seed() {
  let sql = database()
  try {
    let [org] = await sql<{ id: string }[]>`select org_id as id from installations where github_installation_id = ${FAKE_ORG.installationId}`
    await sql`delete from repos where github_repo_id = ${REPO.id}`
    let [repo] = await sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
      values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), ${REPO.id}, ${REPO.fullName}, true)
      returning id`
    let closings: [string, number][] = [
      ...Array.from({ length: 12 }, () => ['fixed', 2] as [string, number]),
      ...Array.from({ length: 3 }, () => ['dismissed', 2] as [string, number]),
      ...Array.from({ length: 5 }, () => ['fixed', 20] as [string, number]),
    ]
    for (let [i, [status, days]] of closings.entries()) {
      let [finding] = await sql<{ id: string }[]>`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence,
          status, status_reason, first_seen_sha, last_seen_sha, created_at)
        values (${repo!.id}, 1, ${`e2e-${i}`}, ${`e2e-${i}`}, 'a.ts', ${i + 1}, 't', 'major', 'bug', 80, ${status},
          ${status === 'dismissed' ? 'Off topic' : null}, ${'1'.repeat(40)}, ${'1'.repeat(40)}, now() - interval '30 days')
        returning id`
      await sql`insert into finding_events (finding_id, type, actor, created_at) values (${finding!.id}, 'opened', 'kento', now() - interval '30 days')`
      await sql`insert into finding_events (finding_id, type, actor, created_at) values (${finding!.id}, ${status}, 'kento', now() - ${`${days} days`}::interval)`
    }
  } finally {
    await sql.end()
  }
}

async function cleanUp() {
  let sql = database()
  try {
    await sql`delete from repos where github_repo_id = ${REPO.id}`
  } finally {
    await sql.end()
  }
}

test.describe('the precision by repo of the dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'octocat')
    await seed()
  })
  test.afterEach(cleanUp)

  test('draws a chart above the list, keeps it when the page reads itself again, and switches to 7 days', async ({ page }) => {
    let errors = watchConsole(page)
    await page.goto('/')
    await hydrated(page)
    let block = page.locator('#precision-block')
    await expect(block.locator('canvas[role="img"]')).toBeVisible()
    await expect(block.getByRole('listitem').filter({ hasText: 'precision-e2e' })).toContainText('85%')

    // dashboard.js reads the page again (at once on visibilitychange): the same numbers keep the same chart.
    await block.evaluate((node) => ((node as HTMLElement).dataset.marker = 'kept'))
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(page.getByText(/Updated [0-2] s ago/)).toBeVisible()
    await expect(page.locator('#precision-block')).toHaveAttribute('data-marker', 'kept')
    await expect(page.locator('#precision-block canvas')).toHaveCount(1)

    await page.getByRole('navigation', { name: 'Window of the precision' }).getByRole('link', { name: '7 days' }).click()
    await expect(page).toHaveURL(/\/\?precision=7#precision-title$/)
    await hydrated(page)
    await expect(page.locator('#precision-block canvas')).toHaveCount(1)
    await expect(page.locator('#precision-block').getByRole('listitem').filter({ hasText: 'precision-e2e' })).toContainText('80%')
    await expect(page.getByText('Precision · 7 d')).toBeVisible()
    await expectNoAxeViolations(page)
    expect(errors).toEqual([])
  })
})

test.describe('the precision by repo without JavaScript', () => {
  test.use({ javaScriptEnabled: false })
  test.afterEach(cleanUp)

  test('shows the list, and no chart', async ({ page }) => {
    await signIn(page, 'octocat')
    await seed()
    await page.goto('/?precision=7')
    await expect(page.locator('#precision-block .chart-box')).toBeHidden()
    await expect(page.locator('#precision-block').getByRole('listitem').filter({ hasText: 'precision-e2e' })).toContainText('80%')
  })
})
