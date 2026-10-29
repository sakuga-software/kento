import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { commandFor, type EventPolicy } from './events.ts'
import { headSha, issueCommentPayload, pullRequestPayload, REPO } from './test-helpers.ts'

const policy: EventPolicy = {
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
        action,
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

  it('any repository of the installation gives a job command: the store reads whether it is enabled', () => {
    let other = { ...REPO, id: 4001, full_name: 'sakuga-software/fruitback' }
    assert.equal(commandFor('pull_request', pullRequestPayload({ repo: other }), policy).type, 'enqueue_review')
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
    let self = { login: 'kento-review[bot]', type: 'Bot' }
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
  it('ping answers, and unknown events are ignored', () => {
    assert.deepEqual(commandFor('ping', { zen: 'Keep it logically awesome.' }, policy), { type: 'ping' })
    assert.equal(reasonOf({ action: 'completed' }, 'check_run'), 'event check_run is not handled')
  })
})

describe('commandFor issue_comment', () => {
  it('a new comment that starts with a name of the bot gives a command', () => {
    assert.deepEqual(commandFor('issue_comment', issueCommentPayload({ body: '@sakuga-review review balanced' }), policy), {
      type: 'comment_command',
      installation,
      repository,
      prNumber: 28,
      commentId: 9001,
      commenter: { login: 'alex', isBot: false },
      command: { verb: 'review', level: 'balanced', force: false },
    })
  })

  it('an unknown command still goes to the handler, which answers with the list', () => {
    let command = commandFor('issue_comment', issueCommentPayload({ body: '@kento-review frobnicate' }), policy)
    assert.ok(command.type === 'comment_command')
    assert.deepEqual(command.command, { verb: 'unknown', text: '@kento-review frobnicate' })
  })

  it('an edited or deleted comment gives no command', () => {
    assert.match(reasonOf(issueCommentPayload({ action: 'edited' }), 'issue_comment'), /action edited gives no command/)
    assert.match(reasonOf(issueCommentPayload({ action: 'deleted' }), 'issue_comment'), /action deleted gives no command/)
  })

  it('a comment of an issue, or a comment that is not a command, gives nothing', () => {
    assert.equal(reasonOf(issueCommentPayload({ onPullRequest: false }), 'issue_comment'), 'comment is not on a pull request')
    assert.equal(reasonOf(issueCommentPayload({ body: 'Looks good. @kento-review review heavy' }), 'issue_comment'), 'comment is not a command')
  })

  it('a comment of any repository gives the command: the handler reads whether the repository is enabled', () => {
    let other = { ...REPO, id: 4001, full_name: 'sakuga-software/fruitback' }
    assert.equal(commandFor('issue_comment', issueCommentPayload({ repo: other }), policy).type, 'comment_command')
  })

  it('the App itself never gives a command, even when it is trusted', () => {
    let app = { login: 'kento-review[bot]', type: 'Bot' }
    let trusting: EventPolicy = { ...policy, trustedBots: new Set(['kento-review[bot]']) }
    let command = commandFor('issue_comment', issueCommentPayload({ user: app, body: '@kento-review review heavy' }), trusting)
    assert.deepEqual(command, { type: 'ignore', reason: 'comment of the App itself' })
  })

  it('an untrusted bot is ignored; a bot of KENTO_TRUSTED_BOTS gives a command', () => {
    let bot = { login: 'dependabot[bot]', type: 'Bot' }
    assert.equal(reasonOf(issueCommentPayload({ user: bot }), 'issue_comment'), 'command of an untrusted bot')
    let agent = { login: 'sakuga-agent[bot]', type: 'Bot' }
    let command = commandFor('issue_comment', issueCommentPayload({ user: agent }), policy)
    assert.ok(command.type === 'comment_command')
    assert.deepEqual(command.commenter, { login: 'sakuga-agent[bot]', isBot: true })
  })

  it('a closed pull request gives no command', () => {
    assert.equal(reasonOf(issueCommentPayload({ state: 'closed' }), 'issue_comment'), 'pull request is closed')
  })

  it('a payload without its comment is invalid', () => {
    let payload: Record<string, unknown> = issueCommentPayload()
    payload.comment = { body: '@kento-review review' }
    assert.match(reasonOf(payload, 'issue_comment'), /lacks installation, repository, number or comment/)
  })
})
