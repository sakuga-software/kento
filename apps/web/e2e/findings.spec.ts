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
      await expect(tabs.getByRole('link', { name: /Open\s*60/ })).toHaveAttribute('aria-current', 'page')
      await expect(tabs.getByRole('link', { name: /Clos\s*3/ })).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(50)
      await expect(page.getByText('1–50 sur 60 findings')).toBeVisible()
      await expect(page.getByRole('rowheader').first()).toContainText('Constat 01')
      await expectNoAxeViolations(page)

      await page.getByRole('link', { name: 'Suivants' }).click()
      await expect(page.getByText('51–60 sur 60 findings')).toBeVisible()
      await expect(page.getByRole('rowheader')).toHaveCount(10)
      await page.getByRole('link', { name: 'Précédents' }).click()
      await expect(page.getByText('1–50 sur 60 findings')).toBeVisible()

      // P0 only: one in three.
      await page.getByLabel('Priorité').selectOption({ label: 'P0 · critique' })
      await page.getByRole('button', { name: 'Filtrer' }).click()
      await expect(page).toHaveURL(/priority=critical/)
      await expect(page.getByRole('rowheader')).toHaveCount(20)

      // fruitback has no open finding: the empty state leads to its closed ones.
      await page.getByRole('link', { name: 'Effacer les filtres' }).first().click()
      await page.getByLabel('Repo').selectOption({ label: 'fruitback' })
      await page.getByRole('button', { name: 'Filtrer' }).click()
      await expect(page.getByRole('heading', { name: 'Aucun finding open pour ces filtres' })).toBeVisible()
      await expectNoAxeViolations(page)
      await page.getByRole('link', { name: 'Voir les 3 findings clos' }).click()
      await expect(page.getByRole('rowheader')).toHaveCount(3)
      await expect(page.getByText('Hors sujet').first()).toBeVisible()
      await expectNoAxeViolations(page)
      expect(errors).toEqual([])
    })
  }
})
