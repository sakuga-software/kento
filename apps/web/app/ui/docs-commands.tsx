// REV-96. "Kentō commands": a public page, open without a sign-in, so that the link of a
// comment of Kentō on GitHub works for every reader of the pull request. It describes `review`,
// `force`, `resolve`, `reject` and `feedback` (REV-107): where to write them, who can run them, what they cost, what they do
// at once and what the next review does with them.
import { levelCost } from '@kento/engine/levels'
import { MAX_RESOLVE_PACK_BYTES, MAX_RESOLVE_THREADS } from '@kento/protocol'
import type { Handle, RemixNode } from 'remix/component'

import { REASON_MAX } from '../findings/store.ts'
import { commandNames } from '../github/comment-command.ts'
import { mention } from '../instance.ts'
import { authRoutes } from '../routes.ts'
import { Document } from './document.tsx'
import { Logo } from './icons.tsx'
import type { Theme } from './theme.ts'

export interface CommandsPageProps {
  theme: Theme
  version: string
  assetVersion: string
}

interface Command {
  id: string
  name: string
  lead: string
  syntax: { where: string; code: string }[]
  who: string
  cost: RemixNode
  now: RemixNode
  next: RemixNode
  examples?: { code: string; why: string }[]
}

const WRITERS = 'A person who can write to the repo (write, maintain or admin), or a bot that the org declared as trusted.'

const LEVEL_COSTS = (
  <>
    <code>lite</code> {levelCost('lite')}, <code>balanced</code> {levelCost('balanced')}, <code>heavy</code> {levelCost('heavy')}
  </>
)

/** The commands, with the names of the instance (KENTO_COMMAND_NAMES). */
function commands(): Command[] {
  return [
    {
      id: 'review',
      name: 'review',
      lead: 'Ask for a review of the PR, at the level that you choose.',
      syntax: [
        { where: 'In the conversation of the PR', code: mention('[lite|balanced|heavy]') },
        { where: 'Long form', code: mention('review balanced') },
      ],
      who: WRITERS,
      cost: <>One review at the chosen level: {LEVEL_COSTS}.</>,
      now: (
        <>
          Kentō queues the review and reacts 👀 on the comment, then 🚀 when the review is published, or 😕 if it fails. Without a level,
          the level is <code>lite</code>.
        </>
      ),
      next: (
        <>
          The review reads the last commit of the PR. Kentō does not review a commit a second time at a level that it already got: use{' '}
          <code>force</code>.
        </>
      ),
    },
    {
      id: 'force',
      name: 'force',
      lead: 'Pay for a new review at a level that this commit already got.',
      syntax: [{ where: 'In the conversation of the PR', code: mention('heavy force') }],
      who: WRITERS,
      cost: <>The price of a review at the chosen level ({LEVEL_COSTS}), paid a second time for this commit.</>,
      now: <>Like <code>review</code>: the review starts even if the commit already has a review at this level.</>,
      next: <>You pay for the review a second time. Kentō publishes it like the others: its block replaces the earlier one in the description of the PR.</>,
    },
    {
      id: 'resolve',
      name: 'resolve',
      lead: 'Answer the open threads of Kentō, and resolve those that the code settles.',
      syntax: [{ where: 'In the conversation of the PR', code: mention('resolve [lite|balanced|heavy]') }],
      who: WRITERS,
      cost: (
        <>
          One call to the model of the chosen level (<code>lite</code> by default), paid by the token like a review: the price depends on
          the number of threads and on the code that the model reads. With no open thread to read, there is no model call.
        </>
      ),
      now: (
        <>
          Kentō reads up to {MAX_RESOLVE_THREADS} open threads, within {MAX_RESOLVE_PACK_BYTES / 1000} KB, with the code of the last commit.
          It answers in each thread, and resolves those that the code fixes. The other threads wait: the summary says so, and a new command
          reads them.
        </>
      ),
      next: <>A thread that <code>resolve</code> already answered on this commit waits for a new push before Kentō reads it again.</>,
    },
    {
      id: 'reject',
      name: 'reject',
      lead: 'Dismiss a wrong finding, with its cause. It does not come back until its file changes, and it no longer counts in the score.',
      syntax: [
        { where: 'As a reply, in the thread of the finding', code: mention('reject <cause>') },
        { where: 'In the conversation, for a finding without a thread', code: mention('reject #3cf454 <cause>') },
      ],
      who: WRITERS,
      cost: <>No model call: the command costs nothing.</>,
      now: (
        <>
          The finding becomes <code>dismissed</code> with its cause. When the finding has a thread, Kentō replies in it and resolves it. If
          Kentō cannot resolve it, its reply says so, and a person resolves it. If the last review requested changes and no blocking finding
          stays open, Kentō dismisses that request. The id is the one in the list of findings, at the end of the description of the PR.
        </>
      ),
      next: (
        <>
          The next review reads the dismissed findings and their cause. It does not write them again until their file changes, and they no
          longer count in the score.
        </>
      ),
      examples: [
        { code: mention('reject false positive: the schema validates the value (schema.ts:12)'), why: 'The fact that refutes the finding, with where to read it.' },
        { code: mention('reject accepted risk: the cache is per process, on purpose (doc in cache.ts)'), why: 'A choice made on purpose and already written down.' },
        { code: mention('reject #3cf454 same finding as the thread above, already refuted'), why: 'A finding that comes back in other words.' },
      ],
    },
    {
      id: 'feedback',
      name: 'feedback',
      lead: 'Give your opinion on the reviews of Kentō: what helped, a false positive, a useless thread, a missed defect.',
      syntax: [
        { where: 'In the conversation of the PR', code: mention('feedback <opinion>') },
        { where: 'As a reply, in the thread of a finding', code: mention('feedback this finding caught the bug') },
      ],
      who: 'Anyone, a bot that the org declared as trusted, or the bot that opened the PR.',
      cost: <>No model call and no job: the command costs nothing.</>,
      now: (
        <>
          Kentō keeps the opinion, with the lines under the command, then reacts ❤️ on the comment. The opinions are on the Feedback page of
          the app. After its third review of a PR, Kentō asks its author for an opinion once: a quote of that message, or a 👍 or 👎 on it,
          counts too.
        </>
      ),
      next: <>Nothing changes in the reviews of the PR: the opinions help to make Kentō better.</>,
    },
  ]
}

/** The public page of the commands of Kentō. */
export function CommandsPage(handle: Handle<CommandsPageProps>) {
  return () => {
    let { theme, version, assetVersion } = handle.props
    let list = commands()
    let [, ...aliases] = commandNames()
    return (
      <Document title="Commands" theme={theme} assetVersion={assetVersion}>
        <main class="docs">
          <header class="docs-head">
            <a class="mark" href={authRoutes.signIn.href()} aria-label="Kentō, sign in">
              <Logo />
            </a>
          </header>
          <article class="docs-body">
            <h1>Kentō commands</h1>
            <p class="docs-lead">
              Kentō reads a command in a comment of a pull request, on a line that starts with <code>{mention()}</code>
              {aliases.length > 0 ? (
                <>
                  {' ('}
                  {aliases.map((alias, i) => (
                    <>
                      {i > 0 ? ', ' : ''}
                      <code>@{alias}</code>
                    </>
                  ))}
                  {aliases.length === 1 ? ' works too)' : ' work too)'}
                </>
              ) : null}
              , outside a quote and a code block. The rest of the comment is free text.
            </p>
            <p class="docs-lead">
              A command that an agent writes (Claude Code, Copilot...) has the same effect and the same cost as the command of a person.
              Kentō only checks that the account that writes it can run it.
            </p>
            <nav class="docs-toc" aria-label="Commands">
              <ul>
                {list.map((c) => (
                  <li>
                    <a href={`#${c.id}`}>
                      <code>{c.name}</code>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            {list.map((c) => (
              <section class="docs-command" id={c.id} aria-labelledby={`${c.id}-title`}>
                <h2 id={`${c.id}-title`}>
                  <code>{c.name}</code>
                </h2>
                <p>{c.lead}</p>
                <dl class="docs-facts">
                  <div>
                    <dt>Syntax</dt>
                    <dd>
                      <ul class="docs-syntax">
                        {c.syntax.map((s) => (
                          <li>
                            <span>{s.where}</span>
                            <code>{s.code}</code>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                  <div>
                    <dt>Who can run it</dt>
                    <dd>{c.who}</dd>
                  </div>
                  <div>
                    <dt>Cost</dt>
                    <dd>{c.cost}</dd>
                  </div>
                  <div>
                    <dt>What happens now</dt>
                    <dd>{c.now}</dd>
                  </div>
                  <div>
                    <dt>At the next review</dt>
                    <dd>{c.next}</dd>
                  </div>
                  {c.examples ? (
                    <div>
                      <dt>Examples of causes</dt>
                      <dd>
                        <ul class="docs-syntax">
                          {c.examples.map((e) => (
                            <li>
                              <code>{e.code}</code>
                              <span>{e.why}</span>
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </section>
            ))}
            <section class="docs-command" id="hint" aria-labelledby="hint-title">
              <h2 id="hint-title">When Kentō suggests <code>reject</code></h2>
              <p>
                When the replies in the thread of a finding show that the finding is wrong, Kentō gives the command once in that thread.
                The model decides, in the language of the replies, at the next review or at a <code>resolve</code> command. Kentō does not
                look for words in the replies. That reply does not change the finding: only <code>reject</code> dismisses it. It never
                comes for a finding that is already dismissed.
              </p>
            </section>
            <p class="docs-note">
              The cause goes on the line of the command, in {REASON_MAX} characters at most. An unknown command gets 😕 and the list of the
              commands.
            </p>
          </article>
          <p class="signin-foot">Kentō {version} · by Sakuga</p>
        </main>
      </Document>
    )
  }
}
