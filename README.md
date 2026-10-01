# pr-agent-settings

The automatic review of pull requests for the repositories of `sakuga-software`:
[PR-Agent](https://github.com/The-PR-Agent/pr-agent) release **0.46.0**, on the serverless inference
of **Scaleway Generative APIs**, posting as the GitHub App **Sakuga Review** (`sakuga-review[bot]`).

This repository holds:

- [`.pr_agent.toml`](.pr_agent.toml): the configuration of every repository. PR-Agent reads it
  from `<org>/pr-agent-settings` by convention, before the `.pr_agent.toml` of the reviewed
  repository. A key there replaces the same key here.
- [`.github/workflows/review.yml`](.github/workflows/review.yml): the workflow that each repository
  calls.
- [`examples/pr-agent.yml`](examples/pr-agent.yml): the calling workflow to copy.

## What a pull request gets

| Event | Commands |
| --- | --- |
| A pull request opens, reopens or leaves draft | `/describe`, `/review`, `/improve` |
| A push to the pull request | `/describe`, `/review` again |
| A comment on the pull request that starts with `/` | that command |

- `/describe` writes the description: a summary, a diagram walkthrough (Mermaid) and a file
  walkthrough, after the text of the author.
- `/review` posts one summary comment, updated on each push: the effort to review, the risk level,
  the merge recommendation and the findings, each with a confidence in its title.
- `/improve` posts each suggestion on its line as a GitHub suggestion, which a person applies with
  one click. It posts the suggestions that score 7 or more out of 10.
- `/ask <question>`: a question about the change.

A push does not run `/improve`: it makes two model calls, to write the suggestions and then to
score them, and takes about 6 minutes on a 23-file diff where `/review` takes 1. The job holds a
runner slot that CI shares.

Drafts, pull requests opened by a bot and comments from people outside the repository are skipped.
A new push cancels the review of the previous one.

### Limits of PR-Agent 0.46.0 on GitHub

- **No inline findings.** `inline_key_issues` is implemented for Azure DevOps and Bitbucket only. On
  GitHub the findings stay in the summary, without a warning. Only `/improve` writes on the lines.
- **The confidence of a finding is an instruction to the model**, not a field of PR-Agent. With the
  example in the instruction, the model follows it (checked on atlas#1090); a title without it
  is still possible.
- **No « Resolved findings » section.** In a GitHub Action, PR-Agent cannot read the login of an App
  token (`GET /user` refuses it), so it takes its own comments for the ones of
  `github-actions[bot]`. With `persistent_finding_state` on, it would post a new review on each push.
  It is off: PR-Agent finds its review by its hidden marker and updates it.

## Enable it on a repository

1. The repository is **private**: the runners of `prod-host` do not serve public repositories,
   and a self-hosted runner on a public repository runs the code of forks.
2. Add the repository to the visibility of the organization secrets below.
3. Copy [`examples/pr-agent.yml`](examples/pr-agent.yml) to `.github/workflows/pr-agent.yml`. It
   calls the latest tag of `review.yml`, pinned by its SHA, and passes the two secrets by name.
4. Optional: a `.pr_agent.toml` at the root of the repository, for what is proper to it. The usual
   case is `[pr_reviewer] extra_instructions` with its stack and its rules. A key replaces the
   whole key of this repository: to add to the `[ignore] glob` list, copy the list first.
5. Open the pull request: its own review is the test. The calling workflow comes from the branch of
   the pull request, the configurations from the default branches.

The conventions of the repository go into every prompt: PR-Agent reads `CLAUDE.md` and `AGENTS.md`
from its default branch, and skips a missing file.

### Repositories

| Repository | Pull request |
| --- | --- |
| `atlas` | atlas#1113, atlas#1115 |
| `pantry` | pantry#629 |
| `orchard` | orchard#1 |
| `pass-app` | pass-app#3 |
| `client-a` | client-a#90 |
| `web-front` | web-front#545 |
| `sakuga-software` | sakuga-software#11 |
| `infra-repo` | infra-repo#1 |
| `cache-server` | cache-server#1 |
| `fruitback` (public, see below) | fruitback#74 |

### A public repository

A public repository cannot call a workflow of this private one, and the runners of `prod-host`
do not serve it. `fruitback` holds a **copy** of `review.yml` that runs on `ubuntu-latest` (free for
a public repository) and skips the pull requests of forks, which get no secret. PR-Agent still reads
the configuration here. A change of `review.yml` goes to that copy by hand.

## GitHub App

**Sakuga Review**, an App of `sakuga-software`:
[settings](https://github.com/organizations/sakuga-software/settings/apps/sakuga-review).

| | Value |
| --- | --- |
| App ID | `5134298` |
| Client ID | `Iv23liesB1xzywavcnv2` |
| Permissions | Pull requests write, Issues write, Contents read, Metadata read. No webhook, no event. |
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
| `SCW_SECRET_KEY` | The secret key of the Scaleway API key below. |
| `PR_AGENT_APP_PRIVATE_KEY` | The private key of the App. |

The calling workflow passes these two by name, and no other secret of the repository. Both are in the macOS Keychain of the
machine that created them:

| Secret | Keychain service | Account |
| --- | --- | --- |
| `SCW_SECRET_KEY` | `SECRET_STORE_ENTRY` | `IAM_APPLICATION` |
| `PR_AGENT_APP_PRIVATE_KEY` | `github-app-atlas-review` | `private-key` |

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

3. Run a review (`/review` in a comment), then delete the old key in the App settings and the
   `.pem` file.

## Scaleway

| Resource | Name | Id |
| --- | --- | --- |
| Project | `pr-agent` | `00000000-0000-0000-0000-000000000000` |
| IAM application | `IAM_APPLICATION` | `00000000-0000-0000-0000-000000000000` |
| Policy | `IAM_POLICY`: `GenerativeApisModelAccess` on the `pr-agent` project only | `00000000-0000-0000-0000-000000000000` |
| API key | of the application, default project `pr-agent` | access key `SCW_ACCESS_KEY_ID` |

The key can call the models and nothing else, and only through the URL of the project
(`https://api.scaleway.ai/<project id>/v1`): the URL without the project answers 403. The
consumption is billed to the `pr-agent` project, and Cockpit shows its tokens.

The diff of each pull request goes to Scaleway. Enable the review on a client repository only if
its contract allows it.

### Change the model

The models, in `.pr_agent.toml`, section `[config]`:

| Role | Model | Context | Price in / out (per million tokens) |
| --- | --- | --- | --- |
| `model` | `qwen3.5-397b-a17b` | 250k, 16k out | €0.60 / €3.60 |
| `fallback_models` | `qwen3.6-35b-a3b` | 256k, 32k out | €0.25 / €1.50 |

Keep the `openai/` prefix, which routes through the OpenAI-compatible path of LiteLLM, then the
model ID of the
[catalogue](https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/).
For a model that PR-Agent does not know:

- `custom_model_max_tokens`: its context window.
- `max_model_tokens`: the diff sent at most (64000). A larger pull request is clipped. This is what
  bounds the cost, about 6 cents for a `/describe` and a `/review`.
- `additional_reasoning_effort_models`: list it, or PR-Agent does not send `reasoning_effort` and
  the model reasons at its own default. Measured on `qwen3.5-397b-a17b`: `low` answers correctly in
  about 30 s, `medium` takes more than 60 s on a two-line diff, and `ai_timeout` is 300 s.

## Runner

The job runs on the self-hosted pool of `prod-host` (`self-hosted, sakuga-linux, docker`): three
slots, shared with CI. Its rootless Docker daemon runs the image, apart from the production Swarm.
See `~/runners/README.md` on the host.

## Upgrade PR-Agent

The image is pinned by digest. For a new release `X.Y.Z` on the
[Releases page](https://github.com/The-PR-Agent/pr-agent/releases):

```bash
docker buildx imagetools inspect pragent/pr-agent:X.Y.Z-github_action --format '{{.Manifest.Digest}}'
gh attestation verify "oci://index.docker.io/pragent/pr-agent@sha256:<digest>" --repo The-PR-Agent/pr-agent
```

The attestation must name `The-PR-Agent/pr-agent` and the tag `vX.Y.Z`. Then replace the digest in
`review.yml`, and read the release notes for renamed configuration keys. Check again the limits
above: a later release can implement inline findings on GitHub.

## Release a new version of the workflow

The calling workflows pin `review.yml` to a commit, with its tag as a comment: the two secrets go to
that exact code, and a push here reaches no repository until it takes the new pin. The configuration
in `.pr_agent.toml` is not pinned: PR-Agent reads it from `main` at each review.

1. Merge the change of `review.yml` on `main`.
2. Tag the merge commit with the next version: `gh api --method POST repos/sakuga-software/pr-agent-settings/git/refs -f ref=refs/tags/v2 -f sha=<commit>`.
3. In each repository of the table above, replace the SHA and the comment on the `uses:` line of
   `.github/workflows/pr-agent.yml`. `examples/pr-agent.yml` gets the same line.

| Tag | Commit | Change |
| --- | --- | --- |
| `v1` | `246db1d441c38f255880104fd38837301aafa87e` | The first version, with the two secrets passed by name. |
