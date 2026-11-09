import { expect, test } from '@playwright/test'
import postgres from 'postgres'

import { FAKE_ORG } from './fake-github.ts'
import { expectNoAxeViolations, signIn, watchConsole } from './helpers.ts'

// REV-102. The findings that their last review lists under « À considérer (code déjà relu) » (REV-100):
// the Findings screen tags them and filters them, and the detail of a finding says it. The second
// review of dojo#91 (2026-11-09): a new P1 on the settings page that did not change, beside a P1
// of the diff that blocks.

const HEAD = 'c'.repeat(40)
const TITLE_CONSIDERED = 'STUDIO_HOST n’est ni dans .env.example ni documenté'
const TITLE_BLOCKING = 'Le jeton de session n’expire jamais'

/** One review with the two findings, and their rows. Gives the id of each row by its title. */
async function seed(): Promise<Record<string, string>> {
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
  try {
    let [org] = await sql<{ id: string }[]>`select id from orgs where github_installation_id = ${FAKE_ORG.installationId}`
    await sql`
      insert into repos (org_id, github_repo_id, full_name)
      values (${org!.id}, 7003, 'sakuga-software/dojo')
      on conflict (github_repo_id) do nothing`
    let [repo] = await sql<{ id: string }[]>`select id from repos where github_repo_id = 7003`
    await sql`delete from findings`
    await sql`delete from reviews where repo_id = ${repo!.id}`
    await sql`delete from jobs where repo_id = ${repo!.id}`
    let [job] = await sql<{ id: string }[]>`
      insert into jobs (repo_id, level, pr_number, head_sha, github_delivery_id, state, finished_at)
      values (${repo!.id}, 'lite', 91, ${HEAD}, 'e2e-rev-102', 'done', now()) returning id`
    let finding = (title: string, path: string, line: number, extra: Record<string, unknown>) => ({
      path,
      start_line: line,
      line,
      severity: 'major',
      category: 'bug',
      confidence: 85,
      title,
      scenario: 'Scénario du constat.',
      fix: 'Correction du constat.',
      suggestion: '',
      anchor: line,
      blocking: false,
      suggestion_range: null,
      fingerprint: `fp-${line}`,
      ...extra,
    })
    let findings = [
      finding(TITLE_CONSIDERED, 'app/routes/settings.tsx', 18, { seen: true }),
      finding(TITLE_BLOCKING, 'app/auth/session.ts', 47, { blocking: true }),
    ]
    let [review] = await sql<{ id: string }[]>`
      insert into reviews (job_id, repo_id, pr_number, head_sha, score, model, cost_usd, result, published_at)
      values (${job!.id}, ${repo!.id}, 91, ${HEAD}, 2, 'claude-haiku-5-5', 0, ${JSON.stringify({ findings })}::text::jsonb, now()) returning id`
    let ids: Record<string, string> = {}
    for (let f of findings) {
      let [row] = await sql<{ id: string }[]>`
        insert into findings (repo_id, pr_number, fingerprint, key, path, line, title, severity, category, confidence, status,
          first_seen_sha, last_seen_sha, first_review_id, last_review_id)
        values (${repo!.id}, 91, ${f.fingerprint}, ${`k-${f.line}`}, ${f.path}, ${f.line}, ${f.title}, 'major', 'bug', 85, 'open',
          ${HEAD}, ${HEAD}, ${review!.id}, ${review!.id})
        returning id`
      ids[f.title] = row!.id
    }
    return ids
  } finally {
    await sql.end()
  }
}

/**
 * The specs share one database: the repository of this one, its job, its review and its findings go,
 * so that the queue of the dashboard and the cost of the org stay as the other specs expect them.
 */
test.afterAll(async () => {
  let sql = postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
  try {
    let repos = sql`select id from repos where github_repo_id = 7003`
    await sql`delete from findings where repo_id in (${repos})`
    await sql`delete from reviews where repo_id in (${repos})`
    await sql`delete from jobs where repo_id in (${repos})`
    await sql`delete from repos where github_repo_id = 7003`
  } finally {
    await sql.end()
  }
})

test('a member sees the findings to consider, filters them, and reads why one does not block (REV-102)', async ({ page }) => {
  let errors = watchConsole(page)
  await signIn(page, 'camille')
  let ids = await seed()

  await page.goto('/findings')
  let considered = page.getByRole('row', { name: new RegExp(TITLE_CONSIDERED.slice(0, 20)) })
  let blocking = page.getByRole('row', { name: new RegExp(TITLE_BLOCKING) })
  await expect(considered.getByText('À considérer', { exact: true })).toBeVisible()
  await expect(considered.getByText('À considérer', { exact: true })).toHaveAttribute('title', /ce finding ne bloque pas la PR/)
  await expect(blocking.getByText('À considérer', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('rowheader')).toHaveCount(2)
  await expectNoAxeViolations(page)

  // The filter applies on change (findings.js), and the URL keeps it.
  await page.getByLabel('Type').selectOption({ label: 'À considérer (code déjà relu)' })
  await expect(page).toHaveURL(/type=a-considerer/)
  await expect(page.getByRole('rowheader')).toHaveCount(1)
  await expect(page.getByRole('rowheader').first()).toContainText(TITLE_CONSIDERED)
  await expect(page.getByRole('navigation', { name: 'Statut des findings' }).getByRole('link', { name: /open\s*1/ })).toBeVisible()
  await expectNoAxeViolations(page)

  // The detail of the finding says it, the detail of the blocking one does not.
  await page.goto(`/findings/${ids[TITLE_CONSIDERED]}`)
  await expect(page.getByText('À considérer : code déjà relu, non bloquant.')).toBeVisible()
  await expectNoAxeViolations(page)
  await page.goto(`/findings/${ids[TITLE_BLOCKING]}`)
  await expect(page.getByRole('heading', { level: 1, name: TITLE_BLOCKING })).toBeVisible()
  await expect(page.getByText('À considérer')).toHaveCount(0)

  // « Effacer les filtres » gives every finding back.
  await page.goto('/findings?type=a-considerer')
  await page.getByRole('link', { name: 'Effacer les filtres' }).first().click()
  await expect(page.getByRole('rowheader')).toHaveCount(2)
  expect(errors).toEqual([])
})
