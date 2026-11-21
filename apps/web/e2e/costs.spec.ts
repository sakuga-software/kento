import { expect, test } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { expectNoAxeViolations, hydrated, signIn, watchConsole } from './helpers.ts'

// KNT-188. The Costs screen: the charts of Chart.js drawn from the tables of the server, the period
// in the URL, the tables without JavaScript, and the tile "Cost of the month" of the dashboard.

const REPO = { id: 7188, fullName: 'sakuga-software/costs-e2e' }

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** One repo of the test org with three reviews of yesterday, at a known cost. */
async function seed() {
  let sql = database()
  try {
    let [org] = await sql<{ id: string }[]>`select org_id as id from installations where github_installation_id = ${FAKE_ORG.installationId}`
    await sql`delete from repos where github_repo_id = ${REPO.id}`
    let [repo] = await sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
      values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), ${REPO.id}, ${REPO.fullName}, true)
      returning id`
    for (let [i, level] of (['lite', 'balanced', 'heavy'] as const).entries()) {
      let head = String(i + 1).repeat(40)
      let [job] = await sql<{ id: string }[]>`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, attempts)
        values (${repo!.id}, ${level}, 'done', ${60 + i}, ${head}, 'main', 1) returning id`
      await sql`
        insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, created_at)
        values (${job!.id}, ${repo!.id}, ${60 + i}, ${head}, 4, ${`model-${level}`}, ${[0.004, 0.15, 0.4][i]!},
          ${JSON.stringify({ verdict: 'COMMENT', findings: [], costSource: 'provider' })}::text::jsonb,
          date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '1 day' + interval '12 hours')`
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

test.describe('the Costs screen', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'octocat')
    await seed()
  })
  test.afterEach(cleanUp)

  test('draws a chart from each table, folds the tables, and keeps the period in the URL', async ({ page }) => {
    let errors = watchConsole(page)
    await page.goto('/costs?period=30d')
    await hydrated(page)
    let charts = page.locator('.chart-box canvas[role="img"]')
    await expect(charts).toHaveCount(4)
    await expect(page.locator('details.chart-data[open]')).toHaveCount(0)
    await expect(page.getByRole('link', { name: '30 days' })).toHaveAttribute('aria-current', 'page')
    // The numbers of the chart are the ones of its table.
    let byLevel = page.getByRole('region', { name: 'By level' })
    await byLevel.getByText('Show the data').click()
    await expect(byLevel.getByRole('row', { name: /heavy \$0\.40/ })).toBeVisible()
    // The most expensive run links to its pull request.
    await expect(page.getByRole('link', { name: `${REPO.fullName}#62` })).toHaveAttribute('href', /\/repos\/[0-9a-f-]+\/pulls\/62$/)
    await page.getByRole('link', { name: '90 days' }).click()
    await expect(page).toHaveURL(/\/costs\?period=90d$/)
    await page.getByRole('link', { name: 'This month' }).click()
    await expect(page).toHaveURL(/\/costs$/)
    await expectNoAxeViolations(page)
    expect(errors).toEqual([])
  })

  test('opens from the tile "Cost of the month" of the dashboard, whose "no cap" keeps its own link (KNT-190)', async ({ page }) => {
    await page.goto('/')
    let tile = page.locator('.kpi-linked')
    // The link inside the tile sits above the stretched one: a click on it goes to the caps.
    await tile.getByRole('link', { name: /^no cap/ }).click()
    await expect(page).toHaveURL(/\/settings#cap$/)
    await page.goBack()
    // The focus ring goes round the whole tile (Fable P3).
    await page.getByRole('link', { name: /^Cost of the month\s*: see the costs$/ }).focus()
    await expect(tile).toHaveCSS('outline-style', 'solid')
    await page.getByRole('link', { name: /^Cost of the month\s*: see the costs$/ }).click()
    await expect(page).toHaveURL(/\/costs$/)
    await expect(page.getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible()
  })
})

test.describe('the Costs screen without JavaScript', () => {
  test.use({ javaScriptEnabled: false })
  test.afterEach(cleanUp)

  test('shows every number in its table, and no chart', async ({ page }) => {
    await signIn(page, 'octocat')
    await seed()
    await page.goto('/costs?period=30d')
    await expect(page.locator('.chart-box')).toHaveCount(4)
    await expect(page.locator('.chart-box').first()).toBeHidden()
    await expect(page.locator('details.chart-data[open]')).toHaveCount(4)
    await expect(page.getByRole('region', { name: 'By model' }).getByRole('row', { name: /model-heavy \$0\.40/ })).toBeVisible()
    await expect(page.getByRole('region', { name: 'By repo' }).getByRole('link', { name: REPO.fullName })).toBeVisible()
  })
})
