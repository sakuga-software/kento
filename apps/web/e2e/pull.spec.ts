import { expect, test } from '@playwright/test'
import postgres from 'postgres'

import { replyText } from '../app/findings/dismiss.ts'
import { PULL_NUMBER, PULL_REPO, seedPull } from './pull-seed.ts'
import { expectNoAxeViolations, signIn, watchConsole } from './helpers.ts'

// The end-to-end test of REV-17 on orchard #142 (e2e/pull-seed.ts): four reviews, a finding moved
// with no new comment, a fix, a dismissal and a wontfix.

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

let repoId = ''
let repoExisted = false

test.beforeAll(async () => {
  let sql = database()
  try {
    repoExisted = (await sql`select 1 from repos where github_repo_id = ${PULL_REPO.githubRepoId}`).length > 0
  } finally {
    await sql.end()
  }
})

test.afterAll(async () => {
  let sql = database()
  try {
    // The other specs read orchard as the check of the Repos screen leaves it.
    if (repoExisted) {
      await sql`delete from jobs where repo_id = ${repoId} and pr_number = ${PULL_NUMBER}`
      await sql`delete from findings where repo_id = ${repoId} and pr_number = ${PULL_NUMBER}`
    } else {
      await sql`delete from repos where github_repo_id = ${PULL_REPO.githubRepoId}`
    }
  } finally {
    await sql.end()
  }
})

test.beforeEach(async ({ page }) => {
  await signIn(page, 'camille')
  let sql = database()
  try {
    repoId = (await seedPull(sql)).repoId
  } finally {
    await sql.end()
  }
})

test('the sheet shows a finding found again after its lines moved, with no new comment', async ({ page }, info) => {
  let errors = watchConsole(page)
  await page.goto(`/repos/${repoId}/pulls/${PULL_NUMBER}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sessions : expiration et rotation des clés')
  await expect(page.getByText('orchard #142', { exact: true })).toBeVisible()
  await expect(page.getByText('@camille')).toBeVisible()
  await expect(page.getByText('feat/session-expiry → main')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Voir sur GitHub' })).toHaveAttribute('href', /\/sakuga-software\/orchard\/pull\/142$/)

  let tiles = page.getByRole('region', { name: 'En bref' })
  await expect(tiles).toContainText('4/5')
  await expect(tiles).toContainText('1 ouvert · 1 fixed · 1 dismissed · 1 wontfix')

  let sheet = page.getByRole('table')
  let row = (title: string) => sheet.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(title) }) })
  let moved = row('Le jeton de session')
  // REV-91: the last cell is the status of today.
  await expect(moved.getByRole('cell')).toHaveText(['posté l.42', 'déplacé l.47', 'retrouvé', 'retrouvé', 'ouvert'])
  await expect(row('Clé API').getByRole('cell')).toHaveText(['posté l.88', 'fixed', 'fixed', 'fixed', 'fixed'])
  await expect(row('Liste sans clé').getByRole('cell')).toHaveText(['posté l.12', 'retrouvé', 'dismissed', 'dismissed', 'dismissed'])
  // On a phone, the card leaves out the reviews from before the finding.
  let before = info.project.name === 'mobile' ? [] : ['pas encore trouvé']
  await expect(row('Requête SQL').getByRole('cell')).toHaveText([...before, 'posté l.30', 'absent', 'wontfix', 'wontfix'])

  if (info.project.name === 'mobile') {
    // A finding is a card: the label of each review sits over its cell, with no horizontal scroll.
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  }

  await page.getByRole('link', { name: /dismissed/ }).first().click()
  await expect(page).toHaveURL(/statut=dismissed/)
  await expect(sheet.getByRole('rowheader')).toHaveCount(1)
  await expect(sheet.getByRole('rowheader')).toContainText('Liste sans clé stable')

  await expectNoAxeViolations(page)
  expect(errors).toEqual([])
})

test('the dashboard leads to the screen of the pull request', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('region', { name: 'Dernières reviews' }).getByRole('link', { name: 'orchard #142' }).first().click()
  await expect(page).toHaveURL(new RegExp(`/repos/${repoId}/pulls/142$`))
  await expect(page.getByRole('heading', { name: 'Feuille d’exposition' })).toBeVisible()
})

test('the detail of a finding: source, model, scenario, its code at its line, history, thread', async ({ page }) => {
  let errors = watchConsole(page)
  await page.goto(`/repos/${repoId}/pulls/${PULL_NUMBER}`)
  await page.getByRole('link', { name: 'Liste sans clé stable' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Liste sans clé stable')
  await expect(page.getByText('Passe du modèle')).toBeVisible()
  await expect(page.getByText('claude-opus-4-1 (R3, heavy)')).toBeVisible()
  await expect(page.getByText('Scénario de C.')).toBeVisible()
  await expect(page.getByText('Motif : Faux positif')).toBeVisible()
  let code = page.getByRole('group', { name: 'Lignes 8 à 16' })
  await expect(code.locator('.code-line-hit')).toContainText('12')
  let history = page.getByRole('region', { name: 'Historique' })
  await expect(history.getByRole('listitem')).toHaveCount(2)
  await expect(history.getByRole('listitem').nth(1)).toContainText('@camille · « Faux positif »')
  await expect(page.getByRole('link', { name: 'Voir le fil' })).toHaveAttribute('href', /\/sakuga-software\/orchard\/pull\/142#discussion_r914203$/)
  await page.getByRole('link', { name: 'orchard #142' }).click()
  await expect(page.getByRole('heading', { name: 'Feuille d’exposition' })).toBeVisible()
  await page.goBack()
  await expectNoAxeViolations(page)
  expect(errors).toEqual([])
})

const GITHUB = `http://127.0.0.1:${process.env.E2E_GITHUB_PORT ?? 3499}`

test('a member dismisses a finding as « Faux positif »: status, reply in the GitHub thread, history; then reopens it', async ({ page }) => {
  let errors = watchConsole(page)
  let before = ((await (await fetch(`${GITHUB}/_test/replies`)).json()) as unknown[]).length
  await page.goto(`/repos/${repoId}/pulls/${PULL_NUMBER}`)
  await page.getByRole('link', { name: 'Le jeton de session n’expire jamais' }).click()

  await page.getByText('Marquer dismissed…').click()
  await page.getByRole('radio', { name: 'Faux positif' }).check()
  await page.getByRole('button', { name: 'Marquer dismissed', exact: true }).click()

  await expect(page.getByRole('status').filter({ hasText: 'Finding marqué dismissed.' })).toContainText('La réponse est postée sur le fil GitHub.')
  await expect(page.locator('.finding-tags')).toContainText('dismissed')
  await expect(page.locator('.finding-tags')).toContainText('Motif : Faux positif')
  let history = page.getByRole('region', { name: 'Historique' }).getByRole('listitem')
  await expect(history.last()).toContainText('@camille · « Faux positif »')
  let replies = (await (await fetch(`${GITHUB}/_test/replies`)).json()) as { repo: string; pr: number; commentId: number; body: string }[]
  expect(replies.slice(before)).toEqual([
    {
      repo: 'sakuga-software/orchard',
      pr: 142,
      commentId: 914201,
      body: replyText('dismissed', 'Faux positif', 'camille'),
    },
  ])
  await expectNoAxeViolations(page)

  await page.getByRole('button', { name: 'Rouvrir' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Finding rouvert.' })).toBeVisible()
  await expect(page.locator('.finding-tags')).toContainText('ouvert')
  await expect(history.last()).toContainText('@camille')

  // « Marquer wontfix » shares the form of the page with « Marquer dismissed »: its button posts to /wontfix.
  await page.getByText('Marquer wontfix…').click()
  await page.getByRole('button', { name: 'Marquer wontfix', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Finding marqué wontfix.' })).toBeVisible()
  await expect(page.locator('.finding-tags')).toContainText('wontfix')
  await page.getByRole('button', { name: 'Rouvrir' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Finding rouvert.' })).toBeVisible()
  expect(errors).toEqual([])
})

test('an admin re-runs the review in heavy: a column R5 waits, then shows the published review', async ({ page }) => {
  let errors = watchConsole(page)
  // beforeEach signed camille in: the admin signs in from a fresh session.
  await page.context().clearCookies()
  await signIn(page, 'alex')
  await page.goto(`/repos/${repoId}/pulls/${PULL_NUMBER}`)
  // REV-91: « Relancer R5… » beside the title opens the three levels.
  await page.getByText('Relancer R5…').click()
  let rerun = page.getByRole('group', { name: 'Relancer R5' })
  await expect(rerun.getByRole('button', { name: /Relancer en heavy · ≈ 0,41/ })).toBeVisible()
  await rerun.getByRole('button', { name: /Relancer en heavy/ }).click()

  await expect(page.getByText('Review relancée : elle est en file. Un nouveau push l’annule.')).toBeVisible()
  await expect(page.getByText(/R5 en file…/)).toBeVisible()
  await expect(page.getByText('Relancer R5…')).toHaveCount(0)
  let sheet = page.getByRole('table')
  await expect(sheet.getByRole('columnheader', { name: /R5/ })).toContainText('En file…')
  await expectNoAxeViolations(page)

  // The runner takes the job and publishes its review.
  let sql = database()
  let jobId = ''
  try {
    let [job] = await sql<{ id: string; level: string; head_sha: string }[]>`
      select id, level, head_sha from jobs where repo_id = ${repoId} and pr_number = ${PULL_NUMBER} and state = 'queued'`
    expect(job?.level).toBe('heavy')
    expect(job?.head_sha).toBe('d'.repeat(40))
    jobId = job!.id
    await sql`update jobs set state = 'done', started_at = now(), finished_at = now() where id = ${jobId}`
    await sql`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, published_at)
      values (${jobId}, ${repoId}, ${PULL_NUMBER}, ${'d'.repeat(40)}, 5, 'claude-opus-4-1', 0.39,
        ${JSON.stringify({ findings: [] })}::text::jsonb, now())`
    await page.reload()
    await expect(sheet.getByRole('columnheader', { name: /R5/ })).toContainText('5/5')
    await expect(page.getByText(/R5 en file…/)).toHaveCount(0)
  } finally {
    if (jobId) await sql`delete from jobs where id = ${jobId}`
    await sql.end()
  }
  expect(errors).toEqual([])
})
