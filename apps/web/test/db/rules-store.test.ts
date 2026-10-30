import * as assert from 'remix/assert'
import { after, before, beforeEach, describe, it } from 'remix/test'

import { createDatabase, type Database } from '../../app/db/client.ts'
import { runMigrations } from '../../app/db/migrate.ts'
import { createRulesStore, MAX_RULES, type RulesStore } from '../../app/rules/store.ts'
import { createTestDatabase } from './helpers.ts'

const VALUES = { title: 'Index des FK', body: 'Chaque FK a son index.', paths: ['**/migrations/**'], severityFloor: 'major' as const }

describe('the store of the rules (REV-19)', () => {
  let test: Awaited<ReturnType<typeof createTestDatabase>>
  let database: Database
  let store: RulesStore
  let orgId: string
  let otherOrgId: string
  let repoId: string
  let otherRepoId: string
  let userId: string

  before(async () => {
    test = await createTestDatabase()
    await runMigrations(test.url)
    database = createDatabase(test.url, { max: 4 })
    store = createRulesStore(database.sql)
    let [org] = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (77, 2001, 'sakuga-software') returning id`
    let [other] = await database.sql<{ id: string }[]>`
      insert into orgs (github_installation_id, github_account_id, login) values (78, 2002, 'orchard') returning id`
    orgId = org!.id
    otherOrgId = other!.id
    let [repo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name) values (${orgId}, 3001, 'sakuga-software/orchard') returning id`
    let [otherRepo] = await database.sql<{ id: string }[]>`
      insert into repos (org_id, github_repo_id, full_name) values (${otherOrgId}, 3002, 'orchard/app') returning id`
    repoId = repo!.id
    otherRepoId = otherRepo!.id
    let [user] = await database.sql<{ id: string }[]>`
      insert into users (github_id, login) values (1, 'alex') returning id`
    userId = user!.id
  })

  beforeEach(async () => {
    await database.sql`delete from rules`
  })

  after(async () => {
    await database?.close()
    await test?.drop()
  })

  it('adds, lists, edits, disables with its author, enables and removes a rule of a repository', async () => {
    let added = await store.create(orgId, repoId, userId, VALUES)
    assert.equal(added.kind, 'saved')
    if (added.kind !== 'saved') return
    let [rule] = await store.list(orgId, repoId)
    assert.deepEqual(
      { title: rule!.title, paths: rule!.paths, floor: rule!.severityFloor, active: rule!.active, version: rule!.version, by: rule!.updatedBy },
      { title: 'Index des FK', paths: ['**/migrations/**'], floor: 'major', active: true, version: 1, by: 'alex' },
    )
    assert.deepEqual(await store.list(orgId, null), [], 'a rule of a repository is not a rule of the org')

    let saved = await store.update(orgId, added.id, userId, 1, { ...VALUES, title: 'FK indexées', severityFloor: null })
    assert.deepEqual(saved, { kind: 'saved', id: added.id, title: 'FK indexées', version: 2, repoId })

    let stale = await store.update(orgId, added.id, userId, 1, VALUES)
    assert.equal(stale.kind, 'conflict')

    await store.setActive(orgId, added.id, userId, 2, false)
    let [off] = await store.list(orgId, repoId)
    assert.equal(off!.active, false)
    assert.equal(off!.disabledBy, 'alex')
    assert.ok(off!.disabledAt instanceof Date)

    await store.setActive(orgId, added.id, userId, 3, true)
    let [on] = await store.list(orgId, repoId)
    assert.deepEqual({ active: on!.active, by: on!.disabledBy, at: on!.disabledAt }, { active: true, by: null, at: null })

    assert.deepEqual(await store.remove(orgId, added.id), { title: 'FK indexées', repoId })
    assert.deepEqual(await store.list(orgId, repoId), [])
  })

  it('keeps each org to its own rules and repositories', async () => {
    assert.deepEqual(await store.create(orgId, otherRepoId, userId, VALUES), { kind: 'not_found' })
    let added = await store.create(orgId, null, userId, VALUES)
    if (added.kind !== 'saved') return assert.fail(added.kind)
    assert.equal(await store.activeOrgRules(orgId), 1)
    assert.equal(await store.activeOrgRules(otherOrgId), 0)
    assert.deepEqual(await store.update(otherOrgId, added.id, userId, 1, VALUES), { kind: 'not_found' })
    assert.deepEqual(await store.setActive(otherOrgId, added.id, userId, 1, false), { kind: 'not_found' })
    assert.equal(await store.remove(otherOrgId, added.id), null)
    assert.deepEqual(await store.list(otherOrgId, null), [])
  })

  it(`holds ${MAX_RULES} rules at most for a repository, even with additions at the same time`, async () => {
    await database.sql`
      insert into rules (org_id, repo_id, title, body)
      select ${orgId}, ${repoId}, 'R' || n, 'Texte' from generate_series(1, ${MAX_RULES - 1}) n`
    let outcomes = await Promise.all([store.create(orgId, repoId, userId, VALUES), store.create(orgId, repoId, userId, VALUES)])
    assert.deepEqual(outcomes.map((o) => o.kind).sort(), ['full', 'saved'])
    assert.equal((await store.list(orgId, repoId)).length, MAX_RULES)
  })
})
