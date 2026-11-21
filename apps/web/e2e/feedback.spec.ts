import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'

import { chooseOption, expectNoAxeViolations, expectReadableButtons, hydrated, signIn, watchConsole } from './helpers.ts'
import { seedFakeOrg } from './pull-seed.ts'

// KNT-176. The pages of the Feedback screen in a browser: 25 answers a page, the newest first,
// "Older" and "Newer" as plain links that keep the filters (KNT-195), with and without JavaScript.

const REPOS = [
  { githubRepoId: 7001, fullName: 'sakuga-software/orchard' },
  { githubRepoId: 7003, fullName: 'sakuga-software/garden' },
] as const

/** 60 answers, one minute apart: 2 in 3 on orchard, the others on garden. Number 59 is the newest. */
const ANSWERS = 60
const START = Date.UTC(2026, 10, 1, 9, 0, 0)

function database() {
  return postgres(process.env.E2E_DATABASE_URL!, { max: 1, onnotice: () => {} })
}

/** Writes the answers again, so that each test starts from the same list. Returns the ids of the repositories. */
async function seed(): Promise<Record<'orchard' | 'garden', string>> {
  let sql = database()
  try {
    let org = await seedFakeOrg(sql)
    let ids: string[] = []
    for (let repo of REPOS) {
      let [row] = await sql<{ id: string }[]>`
        insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
        values (${org.orgId}, ${org.installationId}, ${repo.githubRepoId}, ${repo.fullName}, false)
        -- A repository that another test wrote keeps its state; a new one stays disabled, as after a read of GitHub.
        on conflict (github_repo_id) do update set enabled = repos.enabled
        returning id`
      ids.push(row!.id)
    }
    await sql`delete from feedback where repo_id in ${sql(ids)}`
    for (let n = 0; n < ANSWERS; n++) {
      let repoId = n % 3 === 2 ? ids[1]! : ids[0]!
      // Numbers 33 to 36 share one instant: the pages keep their order by id.
      let at = new Date(START + (n >= 33 && n <= 36 ? 33 : n) * 60_000).toISOString()
      await sql`
        insert into feedback (repo_id, pr_number, author_login, author_is_bot, source, text, github_comment_id, created_at)
        values (${repoId}, ${100 + n}, ${n % 2 ? 'camille' : 'octocat'}, false, ${n % 4 === 3 ? 'reaction' : 'command'},
          ${`Answer ${String(n).padStart(2, '0')}`}, ${9_176_000 + n}, ${at})`
    }
    return { orchard: ids[0]!, garden: ids[1]! }
  } finally {
    await sql.end()
  }
}

async function clean() {
  let sql = database()
  try {
    await sql`delete from feedback where github_comment_id between 9176000 and 9176999`
  } finally {
    await sql.end()
  }
}

/** The texts of the answers on screen, in order. */
async function shown(page: Page): Promise<string[]> {
  let texts = await page.locator('.feedback-table tbody th').allTextContents()
  return texts.map((text) => text.trim())
}

const pager = (page: Page) => page.getByRole('navigation', { name: 'Pages of the feedback' })
const older = (page: Page) => pager(page).getByRole('link', { name: 'Older' })
const newer = (page: Page) => pager(page).getByRole('link', { name: 'Newer' })
/** "Newer" or "Older" when there is no such page: a text, not a link. */
const missing = (page: Page, name: 'Newer' | 'Older') => pager(page).locator('[aria-disabled="true"]', { hasText: name })

/** The texts that the database order gives: the newest first, the tie of 33 to 36 by id. */
async function expectedOrder(where: (n: number) => boolean = () => true): Promise<string[]> {
  let sql = database()
  try {
    let rows = await sql<{ text: string }[]>`
      select text from feedback where github_comment_id between 9176000 and 9176999 order by created_at desc, id desc`
    return rows.map((row) => row.text).filter((text) => where(Number(text.slice(-2))))
  } finally {
    await sql.end()
  }
}

test.describe('the pages of the Feedback screen (KNT-176)', () => {
  test.afterAll(async () => {
    await clean()
  })

  test('pages forward by Older and back by Newer, 25 answers a page', async ({ page }) => {
    let errors = watchConsole(page)
    await seed()
    let order = await expectedOrder()
    await signIn(page, 'camille')
    await page.goto('/feedback')
    await expect(page.getByRole('heading', { level: 1, name: 'Feedback' })).toBeVisible()

    expect(await shown(page)).toEqual(order.slice(0, 25))
    await expect(missing(page, 'Newer')).toBeVisible()
    await expectNoAxeViolations(page)
    await expectReadableButtons(page)

    await older(page).click()
    await expect(page).toHaveURL(/\/feedback\?before=[\w-]+$/)
    expect(await shown(page)).toEqual(order.slice(25, 50))
    await expect(newer(page)).toBeVisible()

    await older(page).click()
    expect(await shown(page)).toEqual(order.slice(50))
    await expect(missing(page, 'Older')).toBeVisible()
    await expectNoAxeViolations(page)

    await newer(page).click()
    expect(await shown(page)).toEqual(order.slice(25, 50))
    await newer(page).click()
    await expect(page).toHaveURL(/\/feedback$/)
    expect(await shown(page)).toEqual(order.slice(0, 25))
    expect(errors).toEqual([])
  })

  test('keeps the filters of the repository and the source in Older and Newer', async ({ page }) => {
    let ids = await seed()
    await signIn(page, 'camille')
    await page.goto('/feedback')
    await hydrated(page)
    await chooseOption(page, 'Repo', { label: 'orchard' })
    await page.getByRole('button', { name: 'Filter' }).click()
    // The form sends its empty fields: the server keeps only the filter in use.
    await expect(page).toHaveURL(new RegExp(`/feedback\\?repo=${ids.orchard}$`))
    let orchard = await expectedOrder((n) => n % 3 !== 2)
    expect(orchard.length).toBe(40)
    expect(await shown(page)).toEqual(orchard.slice(0, 25))

    await older(page).click()
    await expect(page).toHaveURL(new RegExp(`/feedback\\?repo=${ids.orchard}&before=[\\w-]+$`))
    expect(await shown(page)).toEqual(orchard.slice(25))
    await expect(missing(page, 'Older')).toBeVisible()

    await newer(page).click()
    await expect(page).toHaveURL(new RegExp(`/feedback\\?repo=${ids.orchard}$`))
    expect(await shown(page)).toEqual(orchard.slice(0, 25))

    // A filter with fewer than 26 answers has no pager.
    await page.goto(`/feedback?repo=${ids.orchard}&source=reaction`)
    expect(await shown(page)).toEqual(await expectedOrder((n) => n % 3 !== 2 && n % 4 === 3))
    await expect(pager(page)).toHaveCount(0)
  })

  test('a page after the last one says so and links the newest feedback', async ({ page }) => {
    await seed()
    await signIn(page, 'camille')
    await page.goto('/feedback')
    await older(page).click()
    await older(page).click()
    // The 10 oldest answers, those of the third page, leave the list after its link was written.
    let url = page.url()
    let sql = database()
    try {
      await sql`delete from feedback where github_comment_id between 9176000 and 9176999 and created_at < ${new Date(START + 10 * 60_000).toISOString()}`
    } finally {
      await sql.end()
    }
    await page.goto(url)
    await expect(page.getByRole('heading', { name: 'No older feedback' })).toBeVisible()
    await page.getByRole('link', { name: 'See the newest feedback' }).click()
    await expect(page).toHaveURL(/\/feedback$/)
    expect(await shown(page)).toEqual((await expectedOrder()).slice(0, 25))
  })

  test('a broken cursor gives the first page', async ({ page }) => {
    await seed()
    await signIn(page, 'camille')
    await page.goto('/feedback?source=command&before=not-a-cursor')
    await expect(page).toHaveURL(/\/feedback\?source=command$/)
    expect(await shown(page)).toEqual((await expectedOrder((n) => n % 4 !== 3)).slice(0, 25))
  })
})

test.describe('the pages of the Feedback screen without JavaScript (KNT-176)', () => {
  test.use({ javaScriptEnabled: false })

  test.afterAll(async () => {
    await clean()
  })

  test('Older and Newer are plain links, and the native form keeps its filter in them', async ({ page }) => {
    let ids = await seed()
    await signIn(page, 'camille')
    await page.goto('/feedback')
    await page.getByLabel('Repo').selectOption({ label: 'orchard' })
    await page.getByRole('button', { name: 'Filter' }).click()
    await expect(page).toHaveURL(new RegExp(`/feedback\\?repo=${ids.orchard}$`))
    let orchard = await expectedOrder((n) => n % 3 !== 2)
    expect(await shown(page)).toEqual(orchard.slice(0, 25))
    await older(page).click()
    await expect(page).toHaveURL(new RegExp(`/feedback\\?repo=${ids.orchard}&before=[\\w-]+$`))
    expect(await shown(page)).toEqual(orchard.slice(25))
    await newer(page).click()
    expect(await shown(page)).toEqual(orchard.slice(0, 25))
  })
})
