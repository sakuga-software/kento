# review.yml: the old workflow

Before Kentō, each repository ran the review in GitHub Actions: a calling workflow called
[`.github/workflows/review.yml`](../.github/workflows/review.yml), which ran
[`sakuga-review.ts`](sakuga-review.ts) on a self-hosted runner with the two organization secrets.
The script uses the same engine (`packages/engine`) as Kentō, and posts the same review.

Kentō replaces it repository by repository (REV-23). A repository that an admin enabled on the
Repos screen of Kentō gets its reviews and its commands from Kentō; the others still run this
workflow. One month after the last repository moves, REV-24 removes `review.yml`, `examples/`, this
folder, the tag `stable` and its rulesets, and the two organization secrets. Until then, this page
is the runbook of the workflow.

## Bots

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

On a repository that runs the workflow, a comment that starts with `@sakuga-review` gives a
command, with the same forms as on Kentō (see the [README](../README.md#commands)):
`@sakuga-review review [lite|balanced|heavy]` and `@sakuga-review resolve [lite|balanced|heavy]`.
The workflow reads the comment, because the App is not a GitHub user and the mention notifies
nobody. Only a person who can write to the repository, or a bot of `trusted_bots`, can give a
command.

**Resolving needs Contents write.** GitHub resolves a review thread only for a token that can write
the contents. The App has « Contents: Read and write » since 2026-10-05, and the workflow asks for
that token only for `resolve`, for the one repository. Without it (the step fails), `resolve`
answers in each thread and writes that a person can resolve it. The review of a push still uses a
read token: it replies « Le fil peut être résolu » and resolves nothing.

## Run it by hand

```bash
export OPENROUTER_API_KEY=...
node review/sakuga-review.ts --repo-dir <checkout> --base <base sha> --head <head sha> --level lite --dry-run
```

`--dry-run` prints the answer with, for each finding, the line it would anchor on and whether it
blocks, and the body of the review. `--pack-only` prints the message that the model would read, and
calls no model. Without them, and with `GITHUB_TOKEN`, `--repository` and `--pr`, it posts.

## Enable it on a repository

A new repository goes to Kentō instead: install the App on it, then enable it on the Repos screen.
These steps are for a repository that has to stay on the workflow.

1. The repository is **private**: the runners of `runners-host` do not serve public repositories,
   and a self-hosted runner on a public repository runs the code of forks.
2. Add the repository to the visibility of the organization secrets below.
3. Copy [`examples/sakuga-review.yml`](../examples/sakuga-review.yml) to
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

## Secrets

Each run asks for a token for the calling repository and for this one only. The workflow token has
no permission.

**The private key opens every repository.** The token of a run is limited, but the private key can
ask for a token on any repository where the App is installed, with read access to its code. Every
repository that can read the secret can read the key: keep the visibility of the secret to the
repositories that run the review.

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

## The Actions runner

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
