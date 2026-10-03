# sakuga-review

The automatic review of pull requests for the repositories of `sakuga-software`, posting as the
GitHub App **Sakuga Review** (`sakuga-review[bot]`). On each push, one call to **GLM-5.3**
through OpenRouter reads the diff and answers with findings, a severity and a confidence for each,
and a confidence for the pull request. A script posts them as one review with inline comments, and
blocks the merge on a sure blocking finding.

This repository holds:

- [`.github/workflows/review.yml`](.github/workflows/review.yml): the workflow that each repository
  calls.
- [`examples/sakuga-review.yml`](examples/sakuga-review.yml): the calling workflow to copy.
- [`review/`](review/): the script and the prompt.
- [`eval/`](eval/): the bench that chose the model, and its results.

## What a push gets

The layout follows the one of Greptile.

- **A block at the end of the description of the pull request**, replaced on each push:
  - `Sakuga Review · Score de confiance : N/5`, and one sentence on whether the pull request can be
    merged;
  - the findings, numbered, each with its priority badge (`P0`, `P1`, `P2`, and `sécurité` for a
    security finding) and a ▶ link to its thread. A finding with no thread shows its scenario and
    its fix there;
  - a folded summary, a folded Mermaid diagram of the flow that the change touches (when there is
    one), and what the review did not read;
  - a footer: the number of reviews, the last commit reviewed, the model and the cost.

  The script reads the description again just before it writes, and changes only the text between
  its two markers (`<!-- sakuga-review:start -->`, `<!-- sakuga-review:end -->`).
- **A label `review: N/5`**, coloured from red (1) to green (5), replaced on each push. The script
  creates the label in a repository the first time.
- **One review** on the head commit: the score and the sentence, and one inline comment per finding
  of 70 % confidence or more on a line that the pull request changes, at most 5. An inline comment
  gives the priority badge, the title, the failure scenario and the fix, and a GitHub suggestion
  when the fix is a few changed lines. Each comment is a thread that a person resolves, so the
  unsure findings stay in the description.

| Priority | Severity | Meaning |
| --- | --- | --- |
| `P0` | `critical` | data loss or corruption, a security hole, a crash on a main path |
| `P1` | `major` | a wrong result or status on a real path, a broken contract, a regression |
| `P2` | `minor` | an unusual trigger or a cosmetic impact |

| Score | Meaning |
| --- | --- |
| 5 | safe to merge |
| 4 | safe after a look at the minor findings |
| 3 | needs attention |
| 2 | should not be merged as is |
| 1 | must not be merged |

**The verdict**:

| The review finds | Event |
| --- | --- |
| A `P0` or `P1` finding, 70 % confidence or more, on a changed line | `REQUEST_CHANGES`, and the score is at most 2 |
| No such finding, and a score of 4 or 5 | `APPROVE` |
| No such finding, and a score of 1 to 3 | `COMMENT` |

An approval says that this review found nothing that blocks, not that the change is correct: the
bench measured that one call finds about a quarter of the defects that a careful reviewer finds.
No repository of the organization requires an approval to merge (2026-10-03), so the approval of
the bot gates nothing; it shows in the list of reviews. The confidence of a finding (0 to 100) stays
inside the script: it decides the inline comment and the block, and the reader sees the priority.

On the next push:

- A finding that an open thread already carries is not posted again.
- A thread whose file changed since its comment, and whose finding did not come back, gets a reply
  that says it can be resolved. The App cannot resolve it: GitHub refuses `resolveReviewThread` to
  an App that cannot write the contents, and this App only reads them. On a repository that
  requires every thread resolved (atlas), a person resolves it.
- The `REQUEST_CHANGES` of an earlier head is dismissed. A `COMMENT` alone does not lift it, so
  without the dismissal a fixed pull request would stay blocked.

Drafts, pull requests of bots and pushes of bots are skipped. A new push cancels the review of the
previous one.

## The model call

| | Value |
| --- | --- |
| Models | `z-ai/glm-5.3`, then `xiaomi/mimo-v2.6-pro` when it fails (`REVIEW_MODELS` in the script) |
| Routing | OpenRouter, `provider: {zdr: true, data_collection: "deny", require_parameters: true, sort: "price", max_price: {prompt: 0.5, completion: 3.5}}` |
| Answer | JSON, held to a schema by the provider |
| Input | the diff with the whole function around each change, `CLAUDE.md` and `AGENTS.md` up to 400 lines, at most 240 kB |
| Cost | about 0.3 to 1.6 cents a review (measured); the diagram adds a few hundred output tokens, below 0.1 cent |
| Time | 15 to 90 seconds (measured, seven reviews at once); GLM-5.3 stops after 3 minutes, MiMo after 8 |

**Where the diff goes.** OpenRouter sends it only to a provider that keeps nothing and trains on
nothing (`zdr`, `data_collection: deny`); a model with no such provider answers 404. The provider
can be outside the EU: GLM-5.3 runs at Reka, Wafer or InferenceNet, MiMo at DeepInfra or Novita.
Enable the review on a client repository only if its contract allows it.

**Why GLM-5.3 and not MiMo**, which found a little more on the bench: MiMo writes about 10,000
tokens of reasoning at 35 to 50 tokens a second, whatever the reasoning budget asks, so a review
takes 4 to 6 minutes. In v2, which tried MiMo first, 23 of the first 28 reviews fell back to
GLM-5.3 after the wait (2026-10-03). The `max_price` keeps GLM-5.3 off the providers at
$1.4 / $4.4, one of which reasons less and found less on the bench.

The script reads the code and never runs it. It is TypeScript that Node 24 or later runs as is: it
needs `git` and Node, and no package and no build. Keep it to erasable syntax (no `enum`, no
`namespace`), which Node strips without a compiler.

## Run it by hand

```bash
export OPENROUTER_API_KEY=...
node review/sakuga-review.ts --repo-dir <checkout> --base <base sha> --head <head sha> --dry-run
```

`--dry-run` prints the answer with, for each finding, the line it would anchor on and whether it
blocks. Without it, and with `GITHUB_TOKEN`, `--repository` and `--pr`, it posts.

## Why this model, and not an agent

[`eval/`](eval/) holds the bench, and [`eval/results.md`](eval/results.md) its detailed results: seven pull requests of pantry, atlas and web-front, with
the ten defects that an earlier reviewer (Claude Opus, exploring the repository) found and that the
authors then fixed, and one clean pull request. On 2026-10-02 (the bench measures the defects
found, not the time: see [Why GLM-5.3](#the-model-call)):

| | Defects found per run (of 10) | Clean PR blocked | Cost a review |
| --- | --- | --- | --- |
| MiMo V2.6 Pro, one call | about 2.3 | 0 of 3 | $0.02 |
| GLM-5.3, one call | 1.5 to 2 | 0 | $0.02 |
| Claude Sonnet 5.5, one call | about 1.3 | 0 | $0.08 |
| GPT-5.6 Luna, one call | about 1.3 | 0 | $0.002 |
| The same four as agents (4 rounds of read-only tools) | about 0.5 | 0 | $0.016 to $0.125 |
| Five models of Scaleway Generative APIs, one call | 0 to 1 | 1 of 5 | €0.001 to €0.13 |

- **No model found the hard defects** at this budget: the endpoint of pantry#549 reachable through the
  relay, the unique violation that drizzle wraps on pantry#565. They need a reading of another
  service or of a library.
- **OpenCode was dropped.** Its step limit ends a run inside a tool call with no answer; as an agent
  it found fewer defects than one call; and its GitHub action can push commits.
- **Scaleway has no prompt cache**, so an agent there pays the whole context at each step.

## Enable it on a repository

1. The repository is **private**: the runners of `runners-host` do not serve public repositories,
   and a self-hosted runner on a public repository runs the code of forks.
2. Add the repository to the visibility of the organization secrets below.
3. Copy [`examples/sakuga-review.yml`](examples/sakuga-review.yml) to
   `.github/workflows/sakuga-review.yml`, with the SHA of the latest tag (see the table at the end).
   It passes the two secrets by name.
4. Open the pull request: its own review is the test. The calling workflow comes from the branch of
   the pull request.

The conventions of the repository go into every review: the script sends `CLAUDE.md` and
`AGENTS.md` of the head commit, up to 400 lines each, and skips a missing file.

### Repositories

| Repository | v1 (PR-Agent) | v2 (Sakuga Review) |
| --- | --- | --- |
| `atlas` | atlas#1113, atlas#1115 | atlas#1179 |
| `pantry` | pantry#629 | pantry#649 |
| `orchard` | orchard#1 | orchard#2 |
| `pass-app` | pass-app#3 | pass-app#4 |
| `client-a` | client-a#90 | client-a#92 |
| `web-front` | web-front#545 | web-front#549 |
| `sakuga-software` | sakuga-software#11 | sakuga-software#12 |
| `infra-repo` | infra-repo#1 | infra-repo#2 |
| `cache-server` | cache-server#1 | cache-server#2 |
| `fruitback` (public, see below) | fruitback#74 | fruitback#75 |

### A public repository

A public repository cannot call a workflow of this private one, and the runners of `runners-host`
do not serve it. `fruitback` holds a **copy** of `review.yml` that runs on `ubuntu-latest` (free for
a public repository) and skips the pull requests of forks, which get no secret. The copy checks out
the script from this repository with the token of the App, at a SHA written in the copy, because
`job.workflow_sha` names the copy there. A new version goes to that copy by hand: the job and the
SHA.

## GitHub App

**Sakuga Review**, an App of `sakuga-software`:
[settings](https://github.com/organizations/sakuga-software/settings/apps/sakuga-review).

| | Value |
| --- | --- |
| App ID | `5134298` |
| Client ID | `Iv23liesB1xzywavcnv2` |
| Permissions | Pull requests write, Issues write (the score label), Contents read, Metadata read. No webhook, no event. |
| Installation | All the repositories of the organization. |

Each run asks for a token for the calling repository and for this one only, with those
permissions. The workflow token has no permission.

**The private key opens every repository.** The token of a run is limited, but the private key can
ask for a token on any repository where the App is installed, with read access to its code. Every
repository that can read the secret can read the key: keep the visibility of the secret to the
repositories that run the review.

## Secrets and variables

Organization secrets, visibility « selected repositories »:

| Name | Value |
| --- | --- |
| `PR_AGENT_APP_PRIVATE_KEY` | The private key of the App. |
| `OPENROUTER_API_KEY` | An OpenRouter API key for Sakuga Review, with a daily limit. |

The calling workflow passes these two by name, and no other secret of the repository. They are in
the macOS Keychain of the machine that created them:

| Secret | Keychain service | Account |
| --- | --- | --- |
| `PR_AGENT_APP_PRIVATE_KEY` | `github-app-atlas-review` | `private-key` |
| `OPENROUTER_API_KEY` | `openrouter-pr-review` | `api-key` |

**The daily limit of the OpenRouter key is the cost guard of the review** ($10 a day). The same key
serves the bench of `eval/`. A key of its own for the CI would only split the usage per key and let
one be revoked without the other.

**Budget.** September 2026 had about 1,500 pull request heads that a review would read (atlas
about 870, web-front 236, fruitback 201, pantry 173, the others about 10). At 0.3 to 2 cents a
review, plus the 5.5 % that OpenRouter takes on a top-up, that is about $15 to $30 a month. The worst
case, one review per commit (3,200 in September) at 2 cents, is about $70.

A multi-line value comes back from `security find-generic-password -w` in hexadecimal: decode it
with `xxd -r -p`.

### Rotate the private key of the App

1. App settings → Private keys → Generate a private key. GitHub downloads a `.pem`.
2. Name the new file exactly: an older `.pem` in the same folder would make a glob match two files.

   ```bash
   PEM=~/Downloads/<the new file>.private-key.pem
   REPOS=$(gh api orgs/sakuga-software/actions/secrets/PR_AGENT_APP_PRIVATE_KEY/repositories \
     --jq '[.repositories[].name] | join(",")')
   gh secret set PR_AGENT_APP_PRIVATE_KEY --org sakuga-software --visibility selected --repos "$REPOS" < "$PEM"
   security add-generic-password -U -a private-key -s github-app-atlas-review -w "$(cat "$PEM")"
   ```

   Pass the visibility again: without `--visibility`, `gh secret set --org` gives the secret to all
   the private repositories.

3. Push to an open pull request to run a review, then delete the old key in the App settings and the
   `.pem` file.

## Runner

The job runs on `runners-host`, the CI server of the organization (`self-hosted, sakuga-linux`).
It shares the slots with CI and holds one for 1 to 3 minutes. See `~/runners/README.md` on the
host.

## Release a new version of the workflow

The calling workflows pin `review.yml` to a commit, with its tag as a comment: the two secrets go to
that exact code, and a push here reaches no repository until it takes the new pin. The job checks out
the script and the prompt at the same commit (`job.workflow_sha`), so they are pinned too.

1. Merge the change of `review.yml` on `main`.
2. Tag the merge commit with the next version: `gh api --method POST repos/sakuga-software/sakuga-review/git/refs -f ref=refs/tags/v2 -f sha=<commit>`.
3. In each repository of the table above, replace the SHA and the comment on the `uses:` line of
   `.github/workflows/sakuga-review.yml`. `examples/sakuga-review.yml` gets the same line.

| Tag | Commit | Change |
| --- | --- | --- |
| `v1` | `246db1d441c38f255880104fd38837301aafa87e` | PR-Agent on Scaleway, with the two secrets passed by name. |
| `v3.1` | (at the merge) | The review approves on a score of 4 or 5 with no blocking finding. |
| `v3` | `a6a499e7ac5248c2f957919b9545c0c6869c0929` | The layout of Greptile: a score of 1 to 5, a `review: N/5` label, a block at the end of the description with a Mermaid diagram, priority badges and suggestions. GLM-5.3 first. The token asks for Issues write. |
| `v2` | `98155ea6756730cf44ef35590f1e8f5d743cb8fe` | Sakuga Review on OpenRouter; PR-Agent goes. The caller passes `PR_AGENT_APP_PRIVATE_KEY` and `OPENROUTER_API_KEY`, and no longer `SCW_SECRET_KEY`. |
