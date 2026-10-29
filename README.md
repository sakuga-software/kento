# sakuga-review

The automatic review of pull requests for the repositories of `sakuga-software`, posting as the
GitHub App **Kento Review** (`kento-review[bot]`, renamed from Sakuga Review on 2026-10-29). On each push, one call to **Claude Haiku 5.5**
through OpenRouter reads the diff and answers with findings, a severity and a confidence for each,
and a confidence for the pull request. A script posts them as one review with inline comments, and
blocks the merge on a sure blocking finding.

This repository holds:

- [`.github/workflows/review.yml`](.github/workflows/review.yml): the workflow that each repository
  calls.
- [`examples/sakuga-review.yml`](examples/sakuga-review.yml): the calling workflow to copy.
- [`packages/engine/`](packages/engine/): the engine. It builds the pack of a pull request, calls
  the model with the prompts of `packages/engine/prompts/`, and gives the findings, the score, the
  verdict and the review as a reader sees it. It reads a checkout with git, and never calls GitHub.
- [`review/`](review/): the script of the Action. It calls the engine, then reads the threads of
  GitHub and posts the review.
- [`eval/`](eval/): the bench that chose the model, and its results.

## What a push gets

The layout follows the one of Greptile.

- **A block at the end of the description of the pull request**, replaced on each push:
  - `Sakuga Review · Score de confiance : N/5`, and one sentence on whether the pull request can be
    merged;
  - the findings, numbered, each with its priority badge (`P0`, `P1`, `P2`, and `sécurité` for a
    security finding) and a ▶ link to its thread. A finding with no thread shows its scenario and
    its fix there. A finding on code outside the diff (a caller that the change breaks) links its
    line in the file;
  - a folded summary, a folded Mermaid diagram of the flow that the change touches (when there is
    one), and what the review did not read;
  - a footer: the number of reviews, the last commit reviewed, the model and the cost.

  The script reads the description again just before it writes, and changes only the text between
  its two markers (`<!-- sakuga-review:start -->`, `<!-- sakuga-review:end -->`).
- **A label `review: N/5`**, coloured from red (1) to green (5), replaced on each push. The script
  creates the label in a repository the first time.
- **One review** on the head commit: the score and the sentence, the level, the model and the cost
  of the review, and one inline comment per finding
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
| No such finding, a score of 4 or 5, and no deeper review recommended | `APPROVE` |
| No such finding, and a score of 1 to 3 or a deeper review recommended | `COMMENT` |

**A deeper review.** A `lite` review can say that a stronger level would be worth its cost: for
example when the change modifies a route whose callers it cannot see, or touches authorization or
a migration it cannot confirm. The review and the description then show the reason and the command
to type, and the review does not approve. The bench of 2026-10-05 saw it on the internal cases
whose defects sit in another file, and not on the clean pull request.

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

Drafts are skipped, and so are the pull requests, the pushes and the comments of a bot, except the
bots of the `trusted_bots` input of the workflow (default `sakuga-agent[bot]`, the App that the
Claude Code agents push and open pull requests with). A trusted bot counts as a person: its pull
requests get a review, and its comments give commands. Every other bot stays out, this App first,
so that its own comments start no run. A caller can pass another list, comma-separated with no
space:

```yaml
    uses: sakuga-software/sakuga-review/.github/workflows/review.yml@<SHA> # v5
    with:
      trusted_bots: sakuga-agent[bot],other-agent[bot]
```

A new push cancels the review of the previous one.

## Commands

A comment that starts with `@sakuga-review` gives a command. The App is not a GitHub user, so the
mention notifies nobody: the workflow reads the comment. On a repository that Kentō serves
(enabled by an admin on the Repos screen of Kentō, `apps/web`), Kentō reads the command instead, with
`@kento` as its new name and `@sakuga-review` as an alias, and `@kento review heavy force` to pay
again for a level that the head already has (see [apps/web/DEPLOY.md](apps/web/DEPLOY.md), section 9). Only a person who can write to the
repository, or a bot of `trusted_bots`, can give a command, because a command costs money. The bot
reacts 👀 when it starts, 🚀 when it ends and 😕 on an error or an unknown command, which also gets
the list of commands.

| Command | What it does |
| --- | --- |
| `@sakuga-review review [lite\|balanced\|heavy]` | A review of the pull request at this level, posted as on a push. `@sakuga-review` alone is a `lite` review. |
| `@sakuga-review resolve [lite\|balanced\|heavy]` | The model reads up to 20 open review threads (of a bot or a person) and 150 kB, with the code at the head and the diff of each file since its thread opened, and answers in each thread; the final comment counts the threads left for a next command. It resolves a thread that the code fixed, or a finding of a bot that a reply settled. A thread of a person closes only when its file changed. Then one comment lists the threads and the cost. |

| Level | Model | Context | Cost a review | Time |
| --- | --- | --- | --- | --- |
| `lite` (a push) | Claude Haiku 5.5, medium reasoning; GLM-5.3 when it fails | definitions only | about 1 cent | 20 to 45 s |
| `balanced` | Claude Sonnet 5.5, medium reasoning | yes | about 5 cents | 1 to 3 min |
| `heavy` | Claude Opus 5.5, high reasoning | yes | 10 to 50 cents (estimate); at most about $1.10 for a full pack of 240 kB with the 32,000 output tokens of its cap | 2 to 10 min |

A `heavy` review of a large pull request can cost up to about $1, from the same OpenRouter key as
all the reviews of the organization: its daily limit stops every review when it is reached.

Everything that the model reads is data: a comment or a line of code that tells it to approve, or
to mark a thread fixed, is not followed (see the prompts). A thread of a person closes only when its
file changed, whatever the model says.

**Resolving needs Contents write.** GitHub resolves a review thread only for a token that can write
the contents. The App has « Contents: Read and write » since 2026-10-05, and the workflow asks for
that token only for `resolve`, for the one repository. Without it (the step fails), `resolve`
answers in each thread and writes that a person can resolve it. The review of a push still uses a
read token: it replies « Le fil peut être résolu » and resolves nothing.

## The model call

| | Value |
| --- | --- |
| Models | by level, see [Commands](#commands) (`LEVELS` in the script) |
| Routing | OpenRouter, `provider: {zdr: true, data_collection: "deny", require_parameters: true, sort: "price", max_price}`; `max_price` is 0.5 / 3.5 dollars a million tokens for `lite` |
| Answer | JSON, held to a schema by the provider |
| Input | the diff with the whole function around each change, `CLAUDE.md` and `AGENTS.md` up to 400 lines, and the context below, at most 240 kB |
| Cost | `lite`: about 1 cent a review (measured on the bench: $0.20 for 20 reviews); the diagram adds below 0.1 cent |
| Time | `lite`: 20 to 45 seconds (measured, median 21 to 25); Haiku 5.5 stops after 3 minutes, GLM-5.3 after 4 |

**The context.** The model has no tool, so the script adds the code outside the diff that a
reviewer opens first. It finds that code with `git grep` at the head, and sends at most 60 kB of it,
in the room that the diff leaves. Every level gets the definitions; `balanced` and `heavy` also get
the callers:

- the definition of each imported name that the added lines use (a schema, a type, a helper), in
  the app of the importing file, or in the folder of a package of the repository (`@acme/db`
  → `packages/db/`);
- each SQL name that the added lines write in a string (`product_sku_unique`, `*_idx`, `*_fkey`):
  its migration or its schema. A name that no file outside the diff holds is listed as absent, so
  the model can say that the code depends on a migration that is not there yet;
- `balanced` and `heavy` only: the callers of each changed API route under `routes/api/`, found by
  its URL, and of each exported name that the change declares or modifies, outside the files of
  the diff. A name that several files export (`loader`, `action`) is skipped, because a grep cannot
  tell its callers apart.

A finding can sit on that code when the change breaks it. It has no inline comment and does not
block: it appears in the description, with a link to its line. The bench of 2026-10-04 measured no
gain from the callers with GLM-5.3 or GPT-5.6 Luna, which did not use them, when Claude Sonnet 5.5
found a defect of a caller with them; so `lite` sends only the definitions, which are small (0 to
12 kB on the bench) and answer what the review otherwise lists as not reviewed.

**Where the diff goes.** OpenRouter sends it only to a provider that keeps nothing and trains on
nothing (`zdr`, `data_collection: deny`); a model with no such provider answers 404. The provider
can be outside the EU: Claude runs at Google, Anthropic or Azure, GLM-5.3 at Reka, Wafer or
InferenceNet.
Enable the review on a client repository only if its contract allows it.

**Why Claude Haiku 5.5 at medium reasoning** (bench of 2026-10-08, 20 TypeScript pull requests,
see [`eval/martian/`](eval/martian/README.md)): it found as much as GLM-5.3 or more (F1 0.39 and
0.46 against 0.33 to 0.41), for the same cost, two to three times faster, and no review failed. At
high reasoning it found 3 of the 10 internal defects in both runs, for 1.6 cents and 55 to 60
seconds: the level to take if the budget allows it. At low reasoning it found less than GLM-5.3.
The reasoning counts in the output tokens, so `lite` allows 32,000: at 16,000, a long reasoning
left no room for the answer.

GLM-5.3 takes over when Haiku fails; the `max_price` keeps it off the providers at $1.4 / $4.4,
one of which reasons less and found less on the bench. MiMo V2.6 Pro was the fallback until v5:
it writes about 10,000 tokens of reasoning at 35 to 50 tokens a second, so 4 to 6 minutes, and its
providers answered `429` and timeouts under load.

The script and the engine read the code and never run it. They are TypeScript that Node 24 or later
runs as is: they need `git` and Node, and no package and no build. The script imports the engine by
its relative path, so the checkout of `review.yml` runs it with no install. Keep them to erasable
syntax (no `enum`, no `namespace`), which Node strips without a compiler.

The repository is a pnpm workspace. `pnpm install`, then `pnpm typecheck` and `pnpm test`, check
the types and run the tests of the engine with a fake model: only these need the install.

## Run it by hand

```bash
export OPENROUTER_API_KEY=...
node review/sakuga-review.ts --repo-dir <checkout> --base <base sha> --head <head sha> --level lite --dry-run
```

`--dry-run` prints the answer with, for each finding, the line it would anchor on and whether it
blocks, and the body of the review. `--pack-only` prints the message that the model would read, and
calls no model. Without them, and with `GITHUB_TOKEN`, `--repository` and `--pr`, it posts.

## Why this model, and not an agent

[`eval/`](eval/) holds the bench, and [`eval/results.md`](eval/results.md) its detailed results: seven pull requests of pantry, atlas and web-front, with
the ten defects that an earlier reviewer (Claude Opus, exploring the repository) found and that the
authors then fixed, and one clean pull request. On 2026-10-02 (the bench measures the defects
found, not the time; the models of today come from the later bench of [`eval/martian/`](eval/martian/README.md)):

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
   `.github/workflows/sakuga-review.yml`. It calls `review.yml@stable`: nothing to change at a
   release.
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
| `sakuga-review` (this repository, pinned to a released version) | — | sakuga-review#15 |

### A public repository

A public repository cannot call a workflow of this private one, and the runners of `runners-host`
do not serve it. `fruitback` holds a **copy** of `review.yml` that runs on `ubuntu-latest` (free for
a public repository) and skips the pull requests of forks, which get no secret. The copy checks out
the script from this repository with the token of the App, at `stable`, because `job.workflow_sha`
names the copy there. A release reaches the script of the copy with `stable`, but a change of the
jobs of `review.yml` goes to the copy by hand. `boo` holds the same copy.

## GitHub App

**Sakuga Review**, an App of `sakuga-software`:
[settings](https://github.com/organizations/sakuga-software/settings/apps/sakuga-review).

| | Value |
| --- | --- |
| App ID | `5134298` |
| Client ID | `Iv23liesB1xzywavcnv2` |
| Permissions | Pull requests write, Issues write (the score label, the reactions), Contents read and write, Metadata read. No webhook, no event. Contents write serves `resolve` only: every other token asks for read (see [Commands](#commands)). |
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

The calling workflows call `review.yml@stable`. `stable` is a tag that moves: a release moves it to
a new commit, and every repository takes that commit on its next pull request event, with no change
in the repository. The job checks out the script and the prompt at the commit of the workflow
(`job.workflow_sha`), so the three always match. A version tag (`v5.1`, `v5.2`…) stays on each
release, to name it and to roll back to it.

The reviews and the comment commands of this repository come from Kentō (`apps/web`), not from a
workflow (REV-5, REV-7): nothing here runs `review.yml`.

1. Merge the change on `main`. In a repository that calls `review.yml@stable` (git8n, for example),
   open a test pull request that changes its caller to `review.yml@main`: a `pull_request` event runs
   the workflow file of the pull request, so its review runs the new code. Check that review, then
   close the test pull request.
2. Tag the merge commit with the next version, and move `stable` to it. GitHub refuses a ref to a
   commit that changes a workflow to a token without the `workflow` scope, so push with git:

   ```bash
   git fetch origin main
   git push origin origin/main:refs/tags/v5.3
   git push --force origin origin/main:refs/tags/stable
   ```

3. To roll back, move `stable` to the previous version: `git push --force origin v5.2^{commit}:refs/tags/stable`.

**Who can move `stable`.** The callers send their two secrets to the code at `stable`, so a ruleset
of this repository (« stable tag: admins only ») lets only its admins create, move or delete that
tag. A second ruleset refuses a branch named `stable`, which would make `@stable` mean a branch. A
third makes every change of `main` go through a pull request (« main: pull requests only »).

A caller can still pin a commit (`review.yml@<SHA> # v5.1`), for example to hold a repository on a
version during an incident. It then takes no release until it moves the pin back to `@stable`.

| Tag | Commit | Change |
| --- | --- | --- |
| `stable` | moves | The release that the callers run. |
| `v5.2` | `9f57969ae86cccc3f22ecbf7c37068c2932cbcf2` | The script uses the engine of `packages/engine`. The bot login is `kento-review[bot]`, the new name of the App. A thread whose commit a force-push removed stays open. Comments escape every special character. |
| `v5.1.1` | `a02273946b313af0dfbaaa9aa37abda6c89895b8` | A thread whose commit a force-push removed stays open instead of failing the review. |
| `v5.1` | `146912bd2b76ad5addee85eeade678ce2058f891` | `lite` is Claude Haiku 5.5 at medium reasoning, with 32,000 output tokens; GLM-5.3 is the fallback, MiMo goes. |
| `v5` | `f421015719b5e137fefb82113931c91253747239` | The pull requests, pushes and comments of the bots of `trusted_bots` (default `sakuga-agent[bot]`) get a review and give commands, as a person's do. |
| `v4.1` | `ea75cd4ceb471dab6b3cede1994ab13dcb07f30b` | Every level reads the definitions that the change uses and the migration of each SQL name that it writes. |
| `v4` | `37df2bf7d03a076030cd29820c3bc5c53325779b` | Commands in a comment (`review` at a level, `resolve`); levels `lite`, `balanced`, `heavy`; a deeper review recommended; the level, the model and the cost in the review. The caller adds `issue_comment: types: [created]`. |
| `v1` | `246db1d441c38f255880104fd38837301aafa87e` | PR-Agent on Scaleway, with the two secrets passed by name. |
| `v3.1` | `ba76536f0ed54bca91fc88b30a0b4cbb1546a965` | The review approves on a score of 4 or 5 with no blocking finding. |
| `v3` | `a6a499e7ac5248c2f957919b9545c0c6869c0929` | The layout of Greptile: a score of 1 to 5, a `review: N/5` label, a block at the end of the description with a Mermaid diagram, priority badges and suggestions. GLM-5.3 first. The token asks for Issues write. |
| `v2` | `98155ea6756730cf44ef35590f1e8f5d743cb8fe` | Sakuga Review on OpenRouter; PR-Agent goes. The caller passes `PR_AGENT_APP_PRIVATE_KEY` and `OPENROUTER_API_KEY`, and no longer `SCW_SECRET_KEY`. |
