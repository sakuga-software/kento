import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { expectNoAxeViolations, signIn, watchConsole } from './helpers.ts'

// The Repos screen (REV-9) in a browser, against the server, Postgres and the fake GitHub: the check
// of the installation, enable, disable with its confirmation, the switch counter, and the member who
// reads only.

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** Every repository disabled, with no job: each test starts from the same screen. */
async function reset() {
  let sql = database()
  try {
    await sql`delete from jobs where repo_id in (select id from repos where full_name like 'sakuga-software/%')`
    await sql`update repos set enabled = false`
  } finally {
    await sql.end()
  }
}

/** Reads GitHub at once, as an admin, and waits for the list. */
async function checkNow(page: Page) {
  await page.goto('/repos')
  await page.getByRole('button', { name: 'Actualiser' }).click()
  await expect(page.getByText('Liste à jour.')).toBeVisible()
}

function rowOf(page: Page, name: string) {
  return page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${name}`) }) })
}

test.describe('the Repos screen', () => {
  test.beforeEach(async () => {
    await reset()
  })

  for (let theme of ['paper', 'sumi'] as const) {
    test(`an admin enables orchard, then disables it after a confirmation (${theme})`, async ({ page, context, baseURL }) => {
      let errors = watchConsole(page)
      await context.addCookies([{ name: 'kento_theme', value: theme, url: baseURL! }])
      await signIn(page, 'alex')
      await checkNow(page)

      let orchard = rowOf(page, 'orchard')
      await expect(orchard.getByText('review.yml@stable')).toBeVisible()
      await expect(rowOf(page, 'fruitback').getByText('copie de review.yml')).toBeVisible()
      await expect(rowOf(page, 'infra-repo').getByText('installée sans job')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Critère de bascule' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Repli pendant la transition' })).toBeVisible()
      await expect(page.getByRole('link', { name: /Gérer l’installation/ })).toHaveAttribute(
        'href',
        /\/organizations\/sakuga-software\/settings\/installations\/4242$/,
      )
      await expectNoAxeViolations(page)

      await orchard.getByRole('button', { name: 'Activer orchard' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'orchard est activé.' })).toBeVisible()
      await expect(rowOf(page, 'orchard').getByText('App Kentō')).toBeVisible()
      await expect(rowOf(page, 'orchard').getByText('review.yml encore là')).toBeVisible()
      await expect(rowOf(page, 'orchard').getByText('0/20')).toBeVisible()
      await expectNoAxeViolations(page)

      await rowOf(page, 'orchard').getByRole('link', { name: 'Désactiver orchard' }).click()
      let confirm = page.getByRole('region', { name: 'Désactiver orchard ?' })
      await expect(confirm).toBeVisible()
      await expect(confirm).toContainText('Les reviews déjà publiées restent sur GitHub')
      await expectNoAxeViolations(page)
      await confirm.getByRole('button', { name: 'Désactiver orchard' }).click()
      await expect(page.getByRole('status').filter({ hasText: 'orchard est désactivé.' })).toBeVisible()
      await expect(rowOf(page, 'orchard').getByText('review.yml@stable')).toBeVisible()

      let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(0)
      expect(errors).toEqual([])
    })
  }

  test('the counter: 20 published reviews offer « Retirer review.yml »; a failed job brings it back to 0/20', async ({ page }) => {
    await signIn(page, 'alex')
    await checkNow(page)
    let sql = database()
    try {
      let [repo] = await sql<{ id: string }[]>`update repos set enabled = true where full_name = 'sakuga-software/orchard' returning id`
      for (let n = 1; n <= 20; n++) {
        let [job] = await sql<{ id: string }[]>`
          insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, finished_at)
          values (${repo!.id}, 'lite', 'done', ${n}, ${n.toString(16).padStart(40, '0')}, 'main', now() - ${`${60 - n} minutes`}::interval)
          returning id`
        await sql`
          insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, result, github_review_id, published_at)
          values (${job!.id}, ${repo!.id}, ${n}, ${n.toString(16).padStart(40, '0')}, 4, 'anthropic/claude-haiku-5.5', '{}'::jsonb, ${n}, now() - ${`${60 - n} minutes`}::interval)`
      }
      await page.goto('/repos')
      let orchard = rowOf(page, 'orchard')
      await expect(orchard.getByText('20/20')).toBeVisible()
      await expect(orchard.getByRole('link', { name: /Retirer review\.yml/ })).toHaveAttribute(
        'href',
        /\/sakuga-software\/orchard\/delete\/main\/\.github\/workflows\/sakuga-review\.yml$/,
      )
      await expect(orchard.getByRole('link', { name: '#20 · 4/5' })).toBeVisible()
      await expectNoAxeViolations(page)

      await sql`
        insert into jobs (repo_id, level, state, pr_number, head_sha, base_ref, failure_reason, finished_at)
        values (${repo!.id}, 'lite', 'failed', 21, ${'f'.repeat(40)}, 'main', 'lease expired 2 times', now())`
      await page.reload()
      await expect(orchard.getByText('0/20')).toBeVisible()
      await expect(orchard.getByText('remis à zéro après un échec')).toBeVisible()
      await expect(orchard.getByRole('link', { name: /Retirer review\.yml/ })).toHaveCount(0)
    } finally {
      await sql.end()
    }
  })

  test('a member reads the list under « Lecture seule », with no action', async ({ page }) => {
    await signIn(page, 'camille')
    await page.goto('/repos')
    await expect(page.getByText('Lecture seule.')).toBeVisible()
    await expect(page.getByRole('table')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Activer/ })).toHaveCount(0)
    await expect(page.getByRole('link', { name: /^Désactiver/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Actualiser' })).toHaveCount(0)
    await expectNoAxeViolations(page)
  })
})
