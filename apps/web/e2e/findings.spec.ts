import { expect, test } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { expectNoAxeViolations, signIn, watchConsole } from './helpers.ts'

// The Findings screen (REV-18) in a browser, against the server and Postgres: the pages of the list,
// the filters, and the empty state of a filter with its link to the closed findings.

const HEAD = 'a'.repeat(40)

/** 60 open findings on orchard, 3 dismissed on fruitback: each test starts from the same screen. */
async function seed() {
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
  try {
    let [org] = await sql<{ id: string }[]>`select org_id as id from installations where github_installation_id = ${FAKE_ORG.installationId}`
    await sql`
      insert into repos (org_id, installation_id, github_repo_id, full_name)
      values (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 7001, 'sakuga-software/orchard'), (${org!.id}, (select id from installations where org_id = ${org!.id} order by created_at limit 1), 7002, 'sakuga-software/fruitback')
      on conflict (github_repo_id) do nothing`
    await sql`delete from findings`
    await sql`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
        first_seen_sha, last_seen_sha, github_comment_id, created_at)
      select repos.id, 40 + g % 4, md5('e2e' || g), md5('k' || g), 'src/vault/file_' || g || '.ts', g,
        'Finding ' || lpad(g::text, 2, '0') || ': the key is read without a check of its expiry',
        (array['critical', 'major', 'minor'])[1 + g % 3], (array['bug', 'security'])[1 + g % 2], 60 + g % 40, 'open',
        ${HEAD}, case when g % 5 = 0 then ${'b'.repeat(40)} else ${HEAD} end, 900000 + g, now() - g * interval '1 hour'
      from repos, generate_series(1, 60) g where repos.full_name = 'sakuga-software/orchard'`
    await sql`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
        status_reason, first_seen_sha, last_seen_sha, created_at)
      select repos.id, 7, md5('d' || g), md5('dk' || g), 'app/widget.ts', g, 'Dismissed ' || g, 'minor', 'test', 55, 'dismissed',
        'Off topic', ${HEAD}, ${HEAD}, now() - g * interval '1 day'
      from repos, generate_series(1, 3) g where repos.full_name = 'sakuga-software/fruitback'`
    // REV-18: the dismissal of each of them, in the window of the precision.
    await sql`
      insert into finding_events (finding_id, type, actor, reason, created_at)
      select id, 'dismissed', 'octocat', status_reason, created_at + interval '1 hour' from findings where status = 'dismissed'`
  } finally {
    await sql.end()
  }
}

test.describe('the Findings screen', () => {
  for (let theme of ['paper', 'sumi'] as const) {
    test(`a member pages the open findings, filters them, and finds the closed ones from an empty filter (${theme})`, async ({
      page,
      context,
      baseURL,
    }) => {
      let errors = watchConsole(page)
      await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])
      await signIn(page, 'camille')
      await seed()

      await page.goto('/findings')
      await expect(page.getByRole('heading', { level: 1, name: 'Findings' })).toBeVisible()
      let tabs = page.getByRole('navigation', { name: 'Status of the findings' })
      await expect(tabs.getByRole('link', { name: /open\s*60/ })).toHaveAttribute('aria-current', 'page')
      await expect(tabs.getByRole('link', { name: /closed\s*3/ })).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(25)
      await expect(page.getByText('1 to 25 of 60 findings')).toBeVisible()
      await expect(page.getByRole('rowheader').first()).toContainText('Finding 01')
      await expectNoAxeViolations(page)

      // KNT-148: numbered pages, `?page=n`.
      let pager = page.getByRole('navigation', { name: 'Pages of the list' })
      await expect(pager.getByRole('link', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page')
      await pager.getByRole('link', { name: 'Next' }).click()
      await expect(page.getByText('26 to 50 of 60 findings')).toBeVisible()
      await expect(page).toHaveURL(/[?&]page=2(&|$)/)
      await pager.getByRole('link', { name: 'Page 3' }).click()
      await expect(page.getByText('51 to 60 of 60 findings')).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(10)
      await expect(pager.getByRole('link', { name: 'Page 3' })).toHaveAttribute('aria-current', 'page')
      await pager.getByRole('link', { name: 'Page 1' }).click()
      await expect(page.getByText('1 to 25 of 60 findings')).toBeVisible()

      // P0 only: one in three.
      // REV-91: a filter applies on change, with no "Filter" button.
      await expect(page.getByRole('button', { name: 'Filter' })).toBeHidden()
      await page.getByLabel('Priority').selectOption({ label: 'P0 · critical' })
      await expect(page).toHaveURL(/priority=critical/)
      await expect(page.getByRole('rowheader')).toHaveCount(20)

      // fruitback has no open finding: the empty state leads to its closed ones.
      await page.getByRole('link', { name: 'Clear the filters' }).first().click()
      await page.getByLabel('Repo').selectOption({ label: 'fruitback' })
      await expect(page).toHaveURL(/repo=/)
      await expect(page.getByRole('heading', { name: 'No open finding for these filters' })).toBeVisible()
      await expectNoAxeViolations(page)
      await page.getByRole('link', { name: 'See the 3 closed findings' }).click()
      await expect(page.getByRole('rowheader')).toHaveCount(3)
      await expect(page.getByText('Off topic').first()).toBeVisible()
      await expectNoAxeViolations(page)

      // REV-18: 3 dismissed and no fixed finding in 30 days: under 10, no share yet; the reason leads to its findings.
      // REV-91: the precision has its own tab.
      await page.goto('/findings')
      await page.getByRole('navigation', { name: 'Views of the findings' }).getByRole('link', { name: 'Precision' }).click()
      await expect(page).toHaveURL(/view=precision/)
      let precision = page.getByRole('region', { name: 'Precision · last 30 days' })
      await expect(precision.getByText('n = 3 of 10').first()).toBeVisible()
      await precision.getByRole('link', { name: 'Off topic' }).click()
      await expect(page).toHaveURL(/status=dismissed&reason=Off\+topic/)
      await expect(page.getByText('Reason "Off topic"')).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(3)
      expect(errors).toEqual([])
    })
  }

  // REV-91: CSS decides the bar from the first paint, before findings.js (here never loaded) runs.
  test('the bar of actions shows once a finding is checked, with no wait for findings.js', async ({ page }) => {
    await signIn(page, 'octocat')
    await seed()
    await page.route('**/assets/findings.js*', (route) => route.abort())
    await page.goto('/findings')
    let bar = page.getByRole('group', { name: 'Actions on the checked findings' })
    await expect(bar).toBeHidden()
    await page.getByRole('checkbox', { name: /Finding 01/ }).check()
    await expect(bar).toBeVisible()
    await page.getByRole('checkbox', { name: /Finding 01/ }).uncheck()
    await expect(bar).toBeHidden()
  })

  test('an admin dismisses two findings "Off topic": both threads get the reply, and the reason counts two more', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'octocat')
    await seed()
    let replies = async () =>
      (await (await fetch(`http://127.0.0.1:${process.env.E2E_GITHUB_PORT ?? 3499}/_test/replies`)).json()) as { commentId: number; body: string }[]
    let before = (await replies()).length

    let reasons = page.getByRole('region', { name: 'Precision · last 30 days' })
    await page.goto('/findings?view=precision')
    await expect(reasons.getByRole('link', { name: 'Off topic' }).locator('xpath=..')).toContainText('3')
    await page.goto('/findings')
    // REV-91: the bar of the actions shows once a finding is checked, and "Deselect" empties it.
    let bar = page.getByRole('group', { name: 'Actions on the checked findings' })
    await expect(bar).toBeHidden()
    await page.getByRole('checkbox', { name: /Finding 01/ }).check()
    await expect(bar).toBeVisible()
    await bar.getByRole('button', { name: 'Deselect' }).click()
    await expect(bar).toBeHidden()
    await expect(page.getByRole('checkbox', { name: /Finding 01/ })).not.toBeChecked()
    await page.getByRole('checkbox', { name: /Finding 01/ }).check()
    await page.getByRole('checkbox', { name: /Finding 02/ }).check()
    await expect(page.getByText('2 findings checked')).toBeVisible()
    await page.getByText('Mark dismissed…').click()
    await page.getByRole('radio', { name: 'Off topic' }).check()
    await expectNoAxeViolations(page)
    await page.getByRole('button', { name: 'Mark dismissed', exact: true }).click()

    await expect(page.getByText('2 findings marked dismissed.')).toBeVisible()
    await expect(page.getByText('2 replies posted in the GitHub threads.')).toBeVisible()
    await expect(page.getByRole('link', { name: /open\s*58/ })).toBeVisible()
    await page.goto('/findings?view=precision')
    await expect(reasons.getByRole('link', { name: 'Off topic' }).locator('xpath=..')).toContainText('5')
    let posted = (await replies()).slice(before)
    expect(posted.map((r) => r.commentId).sort()).toEqual([900001, 900002])
    expect(posted[0]!.body).toContain('by @octocat on Kentō. Reason: "Off topic"')
    await expectNoAxeViolations(page)
    expect(errors).toEqual([])
  })
})
