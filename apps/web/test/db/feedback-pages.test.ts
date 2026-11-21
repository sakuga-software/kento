// KNT-176. The pages of the answers: keyset pages of FEEDBACK_PAGE_SIZE on (created_at, id), the
// newest first. Postgres is real.
import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { FEEDBACK_PAGE_SIZE, listFeedback, type FeedbackQuery, type FeedbackScreen } from '../../app/feedback/store.ts'
import { encodeCursor } from '../../app/findings/store.ts'
import { createTestDatabase, seedEnabledRepo } from './helpers.ts'

describe('the pages of the feedback (KNT-176)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let orgId: string
  let repoId: string
  let otherRepoId: string
  let commentId = 0

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    ;({ orgId, repoId } = await seedEnabledRepo(database.sql))
    let [installation] = await database.sql<{ id: string }[]>`select id from installations where org_id = ${orgId}`
    let [other] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, installation_id, github_repo_id, full_name, enabled)
      values (${orgId}, ${installation!.id}, 3002, 'sakuga-software/orchard', true) returning id`
    otherRepoId = other!.id
  })

  beforeEach(async () => {
    await database.sql`delete from feedback`
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  /** One answer; `at` is written by Postgres to the microsecond. Returns its text. */
  async function answer(at: string, options: { repo?: string; source?: string; text?: string } = {}) {
    let text = options.text ?? `answer ${++commentId}`
    await database.sql`
      insert into feedback (repo_id, pr_number, author_login, author_is_bot, source, text, github_comment_id, created_at)
      values (${options.repo ?? repoId}, 7, 'camille', false, ${options.source ?? 'command'}, ${text}, ${++commentId}, ${at}::timestamptz)`
    return text
  }

  /** `count` answers, one minute apart, the last one the newest. Returns their texts, the newest first. */
  async function answers(count: number, options: { repo?: string; source?: string; from?: number } = {}) {
    let texts: string[] = []
    for (let i = 0; i < count; i++) {
      let at = new Date(Date.UTC(2026, 10, 1) + ((options.from ?? 0) + i) * 60_000).toISOString()
      texts.push(await answer(at, { ...options, text: `answer ${options.repo === otherRepoId ? 'O' : 'A'}${(options.from ?? 0) + i}` }))
    }
    return texts.reverse()
  }

  /** Every page from the first one, by the Older links. */
  async function walk(query: FeedbackQuery = {}): Promise<FeedbackScreen[]> {
    let pages = [await listFeedback(database.sql, orgId, query)]
    while (pages.at(-1)!.older) pages.push(await listFeedback(database.sql, orgId, { ...query, before: pages.at(-1)!.older }))
    return pages
  }

  const texts = (screen: FeedbackScreen) => screen.rows.map((row) => row.text)

  it('shows 25 answers, the newest first, and the next pages by Older, each answer once', async () => {
    let all = await answers(60)
    let pages = await walk()
    assert.deepEqual(pages.map((page) => page.rows.length), [FEEDBACK_PAGE_SIZE, FEEDBACK_PAGE_SIZE, 10])
    assert.deepEqual(pages.flatMap(texts), all)
    assert.equal(pages[0]!.newer, null, 'the first page has no Newer')
    assert.equal(pages[2]!.older, null, 'the last page has no Older')
  })

  it('goes back by Newer to the same pages, and from the second page to the first one', async () => {
    await answers(60)
    let [first, second, third] = await walk()
    assert.deepEqual(second!.newer, { before: null }, 'Newer on the second page is the first page')
    assert.ok(third!.newer?.before, 'Newer on the third page has a cursor')
    let back = await listFeedback(database.sql, orgId, { before: third!.newer!.before })
    assert.deepEqual(texts(back), texts(second!))
    assert.deepEqual(back.newer, { before: null })
    assert.deepEqual(texts(await listFeedback(database.sql, orgId, { before: back.newer!.before })), texts(first!))
  })

  it('keeps the order of answers of the same instant, and of instants closer than a millisecond', async () => {
    // 30 answers at one instant, and 10 a microsecond apart: a cursor in milliseconds would lose some.
    for (let i = 0; i < 30; i++) await answer('2026-11-10T10:00:00.000000Z')
    for (let i = 1; i <= 9; i++) await answer(`2026-11-10T10:00:00.00000${i}Z`)
    await answer('2026-11-10T10:00:00.000010Z')
    let pages = await walk()
    let seen = pages.flatMap(texts)
    assert.equal(seen.length, 40)
    assert.equal(new Set(seen).size, 40, 'no answer twice')
    let expected = await database.sql<{ text: string }[]>`select text from feedback order by created_at desc, id desc`
    assert.deepEqual(seen, expected.map((row) => row.text))
    // And back: Newer of the second page gives the first page.
    assert.deepEqual(texts(await listFeedback(database.sql, orgId, { before: pages[1]!.newer!.before })), texts(pages[0]!))
  })

  it('reads an invalid cursor as the first page', async () => {
    let all = await answers(30)
    let id = '11111111-1111-4111-8111-111111111111'
    let bad = [
      'abc',
      '!!!',
      encodeCursor({ at: 'yesterday', id }),
      encodeCursor({ at: '2026-11-10T10:00:00.000000Z', id: 'not-a-uuid' }),
      // The pattern of a date, not a date: Postgres would refuse them with an error.
      encodeCursor({ at: '2026-02-30T10:00:00.000000Z', id }),
      encodeCursor({ at: '2026-11-10T24:00:00.000000Z', id }),
      encodeCursor({ at: '0000-01-01T00:00:00.000000Z', id }),
      encodeCursor({ at: '2026-13-01T00:00:00.000000Z', id }),
    ]
    for (let before of bad) {
      let screen = await listFeedback(database.sql, orgId, { before })
      assert.deepEqual(texts(screen), all.slice(0, FEEDBACK_PAGE_SIZE), before)
      assert.equal(screen.newer, null, before)
    }
  })

  it('pages within the filters: the repository and the source', async () => {
    let mine = await answers(30, { from: 0 })
    let theirs = await answers(30, { repo: otherRepoId, from: 1000 })
    let pages = await walk({ repoId })
    assert.deepEqual(pages.flatMap(texts), mine)
    let back = await listFeedback(database.sql, orgId, { repoId, before: pages[1]!.newer!.before })
    assert.deepEqual(texts(back), mine.slice(0, FEEDBACK_PAGE_SIZE), 'Newer stays in the repository')
    assert.deepEqual((await walk({ repoId: otherRepoId })).flatMap(texts), theirs)
    // All repos: the other repository is newer.
    assert.deepEqual((await walk()).flatMap(texts), [...theirs, ...mine])

    await database.sql`update feedback set source = 'quote' where text like 'answer A%' and right(text, 1) in ('0', '2', '4', '6', '8')`
    let quotes = mine.filter((text) => /[02468]$/.test(text))
    let quotePages = await walk({ repoId, source: 'quote' })
    assert.deepEqual(quotePages.flatMap(texts), quotes)
    assert.equal(quotePages.length, 1, '15 quotes fit on one page')
  })

  it('shows no answer after the last page, with a way back to the newest', async () => {
    let all = await answers(30)
    let [first] = await walk()
    // The 5 answers of the second page leave the list, after the link to it was written.
    await database.sql`delete from feedback where text in ${database.sql(all.slice(FEEDBACK_PAGE_SIZE))}`
    let gone = await listFeedback(database.sql, orgId, { before: first!.older })
    assert.deepEqual(gone.rows, [])
    assert.equal(gone.older, null)
    assert.deepEqual(gone.newer, { before: null }, 'Newer goes to the first page')
  })
})
