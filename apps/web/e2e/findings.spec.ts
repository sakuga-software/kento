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
    let [org] = await sql<{ id: string }[]>`select id from orgs where github_installation_id = ${FAKE_ORG.installationId}`
    await sql`
      insert into repos (org_id, github_repo_id, full_name)
      values (${org!.id}, 7001, 'sakuga-software/orchard'), (${org!.id}, 7002, 'sakuga-software/fruitback')
      on conflict (github_repo_id) do nothing`
    await sql`delete from findings`
    await sql`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
        first_seen_sha, last_seen_sha, github_comment_id, created_at)
      select repos.id, 40 + g % 4, md5('e2e' || g), md5('k' || g), 'src/vault/file_' || g || '.ts', g,
        'Constat ' || lpad(g::text, 2, '0') || ' : la clé est lue sans vérifier son expiration',
        (array['critical', 'major', 'minor'])[1 + g % 3], (array['bug', 'security'])[1 + g % 2], 60 + g % 40, 'open',
        ${HEAD}, case when g % 5 = 0 then ${'b'.repeat(40)} else ${HEAD} end, 900000 + g, now() - g * interval '1 hour'
      from repos, generate_series(1, 60) g where repos.full_name = 'sakuga-software/orchard'`
    await sql`
      insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
        status_reason, first_seen_sha, last_seen_sha, created_at)
      select repos.id, 7, md5('d' || g), md5('dk' || g), 'app/widget.ts', g, 'Écarté ' || g, 'minor', 'test', 55, 'dismissed',
        'Hors sujet', ${HEAD}, ${HEAD}, now() - g * interval '1 day'
      from repos, generate_series(1, 3) g where repos.full_name = 'sakuga-software/fruitback'`
    // REV-18: the dismissal of each of them, in the window of the precision.
    await sql`
      insert into finding_events (finding_id, type, actor, reason, created_at)
      select id, 'dismissed', 'alex', status_reason, created_at + interval '1 hour' from findings where status = 'dismissed'`
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
      let tabs = page.getByRole('navigation', { name: 'Statut des findings' })
      await expect(tabs.getByRole('link', { name: /open\s*60/ })).toHaveAttribute('aria-current', 'page')
      await expect(tabs.getByRole('link', { name: /clos\s*3/ })).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(50)
      await expect(page.getByText('1 à 50 sur 60 findings')).toBeVisible()
      await expect(page.getByRole('rowheader').first()).toContainText('Constat 01')
      await expectNoAxeViolations(page)

      await page.getByRole('link', { name: 'Suivants' }).click()
      await expect(page.getByText('51 à 60 sur 60 findings')).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(10)
      await page.getByRole('link', { name: 'Précédents' }).click()
      await expect(page.getByText('1 à 50 sur 60 findings')).toBeVisible()

      // P0 only: one in three.
      // REV-91: a filter applies on change, with no « Filtrer » button.
      await expect(page.getByRole('button', { name: 'Filtrer' })).toBeHidden()
      await page.getByLabel('Priorité').selectOption({ label: 'P0 · critique' })
      await expect(page).toHaveURL(/priority=critical/)
      await expect(page.getByRole('rowheader')).toHaveCount(20)

      // fruitback has no open finding: the empty state leads to its closed ones.
      await page.getByRole('link', { name: 'Effacer les filtres' }).first().click()
      await page.getByLabel('Repo').selectOption({ label: 'fruitback' })
      await expect(page).toHaveURL(/repo=/)
      await expect(page.getByRole('heading', { name: 'Aucun finding open pour ces filtres' })).toBeVisible()
      await expectNoAxeViolations(page)
      await page.getByRole('link', { name: 'Voir les 3 findings clos' }).click()
      await expect(page.getByRole('rowheader')).toHaveCount(3)
      await expect(page.getByText('Hors sujet').first()).toBeVisible()
      await expectNoAxeViolations(page)

      // REV-18: 3 dismissed and no fixed finding in 30 days: under 10, no share yet; the reason leads to its findings.
      // REV-91: the precision has its own tab.
      await page.goto('/findings')
      await page.getByRole('navigation', { name: 'Vues des findings' }).getByRole('link', { name: 'Précision' }).click()
      await expect(page).toHaveURL(/vue=precision/)
      let precision = page.getByRole('region', { name: 'Précision · 30 derniers jours' })
      await expect(precision.getByText('n = 3 sur 10').first()).toBeVisible()
      await precision.getByRole('link', { name: 'Hors sujet' }).click()
      await expect(page).toHaveURL(/status=dismissed&reason=Hors\+sujet/)
      await expect(page.getByText('Motif « Hors sujet »')).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(3)
      expect(errors).toEqual([])
    })
  }

  // REV-91: CSS decides the bar from the first paint, before findings.js (here never loaded) runs.
  test('the bar of actions shows once a finding is checked, with no wait for findings.js', async ({ page }) => {
    await signIn(page, 'alex')
    await seed()
    await page.route('**/assets/findings.js*', (route) => route.abort())
    await page.goto('/findings')
    let bar = page.getByRole('group', { name: 'Actions sur les findings cochés' })
    await expect(bar).toBeHidden()
    await page.getByRole('checkbox', { name: /Constat 01/ }).check()
    await expect(bar).toBeVisible()
    await page.getByRole('checkbox', { name: /Constat 01/ }).uncheck()
    await expect(bar).toBeHidden()
  })

  test('an admin dismisses two findings « Hors sujet »: both threads get the reply, and the reason counts two more', async ({ page }) => {
    let errors = watchConsole(page)
    await signIn(page, 'alex')
    await seed()
    let replies = async () =>
      (await (await fetch(`http://127.0.0.1:${process.env.E2E_GITHUB_PORT ?? 3499}/_test/replies`)).json()) as { commentId: number; body: string }[]
    let before = (await replies()).length

    let reasons = page.getByRole('region', { name: 'Précision · 30 derniers jours' })
    await page.goto('/findings?vue=precision')
    await expect(reasons.getByRole('link', { name: 'Hors sujet' }).locator('xpath=..')).toContainText('3')
    await page.goto('/findings')
    // REV-91: the bar of the actions shows once a finding is checked, and « Désélectionner » empties it.
    let bar = page.getByRole('group', { name: 'Actions sur les findings cochés' })
    await expect(bar).toBeHidden()
    await page.getByRole('checkbox', { name: /Constat 01/ }).check()
    await expect(bar).toBeVisible()
    await bar.getByRole('button', { name: 'Désélectionner' }).click()
    await expect(bar).toBeHidden()
    await expect(page.getByRole('checkbox', { name: /Constat 01/ })).not.toBeChecked()
    await page.getByRole('checkbox', { name: /Constat 01/ }).check()
    await page.getByRole('checkbox', { name: /Constat 02/ }).check()
    await expect(page.getByText('2 findings cochés')).toBeVisible()
    await page.getByText('Marquer dismissed…').click()
    await page.getByRole('radio', { name: 'Hors sujet' }).check()
    await expectNoAxeViolations(page)
    await page.getByRole('button', { name: 'Marquer dismissed', exact: true }).click()

    await expect(page.getByText('2 findings marqués dismissed.')).toBeVisible()
    await expect(page.getByText('2 réponses postées dans les fils GitHub.')).toBeVisible()
    await expect(page.getByRole('link', { name: /open\s*58/ })).toBeVisible()
    await page.goto('/findings?vue=precision')
    await expect(reasons.getByRole('link', { name: 'Hors sujet' }).locator('xpath=..')).toContainText('5')
    let posted = (await replies()).slice(before)
    expect(posted.map((r) => r.commentId).sort()).toEqual([900001, 900002])
    expect(posted[0]!.body).toContain('par @alex sur Kentō. Motif : « Hors sujet »')
    await expectNoAxeViolations(page)
    expect(errors).toEqual([])
  })
})
