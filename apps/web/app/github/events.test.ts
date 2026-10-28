import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { commandFor, type EventPolicy } from './events.ts'
import { headSha, pullRequestPayload, REPO } from './test-helpers.ts'

const policy: EventPolicy = {
  kentoRepos: new Set(['sakuga-software/sakuga-review']),
  trustedBots: new Set(['sakuga-agent[bot]']),
}

const installation = { githubInstallationId: 1001, githubAccountId: 2001, login: 'sakuga-software' }
const repository = { githubRepoId: 3001, fullName: 'sakuga-software/sakuga-review' }

function reasonOf(payload: unknown, event = 'pull_request'): string {
  let command = commandFor(event, payload, policy)
  assert.ok(command.type === 'ignore' || command.type === 'invalid', `got ${command.type}`)
  return command.reason
}

describe('commandFor pull_request', () => {
  for (let action of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
    it(`${action} queues a review of the head`, () => {
      assert.deepEqual(commandFor('pull_request', pullRequestPayload({ action, head: headSha(7) }), policy), {
        type: 'enqueue_review',
        installation,
        repository,
        prNumber: 24,
        headSha: headSha(7),
        baseRef: 'main',
      })
    })
  }

  it('closed cancels the jobs of the pull request', () => {
    assert.deepEqual(commandFor('pull_request', pullRequestPayload({ action: 'closed' }), policy), {
      type: 'cancel_pull_request',
      installation,
      repository,
      prNumber: 24,
    })
  })

  it('other actions create no job', () => {
    assert.match(reasonOf(pullRequestPayload({ action: 'labeled' })), /action labeled creates no job/)
  })

  it('a draft gets no job', () => {
    assert.equal(reasonOf(pullRequestPayload({ draft: true })), 'draft pull request')
  })

  it('a repository outside KENTO_REPOS gets no job, whatever its case', () => {
    let other = { ...REPO, id: 4001, full_name: 'sakuga-software/fruitback' }
    assert.equal(reasonOf(pullRequestPayload({ repo: other })), 'repository is not in KENTO_REPOS')
    let upper = { ...REPO, full_name: 'Sakuga-Software/Sakuga-Review' }
    assert.equal(commandFor('pull_request', pullRequestPayload({ repo: upper }), policy).type, 'enqueue_review')
  })

  it('a push by an untrusted bot gets no job', () => {
    let sender = { login: 'dependabot[bot]', type: 'Bot' }
    assert.equal(reasonOf(pullRequestPayload({ sender })), 'pushed by an untrusted bot')
  })

  it('a pull request opened by an untrusted bot gets no job', () => {
    let author = { login: 'renovate[bot]', type: 'Bot' }
    assert.equal(reasonOf(pullRequestPayload({ author })), 'opened by an untrusted bot')
  })

  it('a trusted bot gets a job, as in review.yml', () => {
    let bot = { login: 'Sakuga-Agent[bot]', type: 'Bot' }
    assert.equal(commandFor('pull_request', pullRequestPayload({ sender: bot, author: bot }), policy).type, 'enqueue_review')
  })

  it('the review App itself gets no job', () => {
    let self = { login: 'sakuga-review[bot]', type: 'Bot' }
    assert.equal(reasonOf(pullRequestPayload({ sender: self })), 'pushed by an untrusted bot')
  })

  it('a pull request from a fork gets no job, also when the fork was deleted', () => {
    assert.equal(reasonOf(pullRequestPayload({ headRepoId: 9999 })), 'pull request from a fork')
    assert.equal(reasonOf(pullRequestPayload({ headRepoId: null })), 'pull request from a fork')
  })

  it('a payload without installation or with a bad head is invalid', () => {
    let payload = pullRequestPayload() as Record<string, unknown>
    assert.equal(commandFor('pull_request', { ...payload, installation: undefined }, policy).type, 'invalid')
    assert.equal(commandFor('pull_request', pullRequestPayload({ head: 'not-a-sha' }), policy).type, 'invalid')
    assert.equal(commandFor('pull_request', [], policy).type, 'invalid')
  })
})

describe('commandFor installation', () => {
  let account = { id: 2001, login: 'sakuga-software', type: 'Organization' }
  let repositories = [{ id: 3001, name: 'sakuga-review', full_name: 'sakuga-software/sakuga-review' }]

  it('created upserts the org and its repositories', () => {
    let payload = { action: 'created', installation: { id: 1001, account }, repositories }
    assert.deepEqual(commandFor('installation', payload, policy), {
      type: 'upsert_installation',
      installation,
      repositories: [repository],
      suspended: false,
    })
  })

  it('suspend marks the org, deleted removes the installation', () => {
    let suspend = commandFor('installation', { action: 'suspend', installation: { id: 1001, account } }, policy)
    assert.deepEqual(suspend, { type: 'upsert_installation', installation, repositories: [], suspended: true })
    let deleted = commandFor('installation', { action: 'deleted', installation: { id: 1001, account } }, policy)
    assert.deepEqual(deleted, { type: 'delete_installation', installation })
  })

  it('installation_repositories adds and removes repositories', () => {
    let added = commandFor(
      'installation_repositories',
      { action: 'added', installation: { id: 1001, account }, repositories_added: repositories },
      policy,
    )
    assert.deepEqual(added, { type: 'add_repositories', installation, repositories: [repository] })
    let removed = commandFor(
      'installation_repositories',
      { action: 'removed', installation: { id: 1001, account }, repositories_removed: repositories },
      policy,
    )
    assert.deepEqual(removed, { type: 'remove_repositories', installation, githubRepoIds: [3001] })
  })
})

describe('commandFor other events', () => {
  it('ping answers, issue_comment and unknown events are ignored', () => {
    assert.deepEqual(commandFor('ping', { zen: 'Keep it logically awesome.' }, policy), { type: 'ping' })
    assert.equal(reasonOf({ action: 'created' }, 'issue_comment'), 'issue_comment is not handled yet')
    assert.equal(reasonOf({ action: 'completed' }, 'check_run'), 'event check_run is not handled')
  })
})
