import { expect, test } from '@playwright/test'
import postgres from 'postgres'

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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('orchard #142 · Sessions : expiration et rotation des clés')
  await expect(page.getByText('@camille')).toBeVisible()
  await expect(page.getByText('feat/session-expiry → main')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Voir sur GitHub' })).toHaveAttribute('href', /\/sakuga-software\/orchard\/pull\/142$/)

  let tiles = page.getByRole('region', { name: 'En bref' })
  await expect(tiles).toContainText('4/5')
  await expect(tiles).toContainText('1 ouvert · 1 fixed · 1 dismissed · 1 wontfix')

  let sheet = page.getByRole('table')
  let row = (title: string) => sheet.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(title) }) })
  let moved = row('Le jeton de session')
  await expect(moved.getByRole('cell')).toHaveText(['posté l.42', 'déplacé l.47', 'retrouvé', 'retrouvé'])
  await expect(row('Clé API').getByRole('cell')).toHaveText(['posté l.88', 'fixed', 'fixed', 'fixed'])
  await expect(row('Liste sans clé').getByRole('cell')).toHaveText(['posté l.12', 'retrouvé', 'dismissed', 'dismissed'])
  // On a phone, the card leaves out the reviews from before the finding.
  let before = info.project.name === 'mobile' ? [] : ['pas encore trouvé']
  await expect(row('Requête SQL').getByRole('cell')).toHaveText([...before, 'posté l.30', 'absent', 'wontfix'])

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
  await page.getByRole('region', { name: 'Dernières reviews' }).getByRole('link', { name: 'sakuga-software/orchard#142' }).first().click()
  await expect(page).toHaveURL(new RegExp(`/repos/${repoId}/pulls/142$`))
  await expect(page.getByRole('heading', { name: 'Feuille d’exposition' })).toBeVisible()
})
