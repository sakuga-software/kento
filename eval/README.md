# The bench of Sakuga Review

The bench that chose the model of [`review/`](../review/). Run it again before you change the model
or the prompt, and when a new model comes out.

[`martian/`](martian/) runs the same cases with the TypeScript pull requests of the Martian Code
Review Bench and its judge, and gives the latest comparison of models.

## The public bench and the internal bench (REV-121)

This repository holds only cases of public repositories: the pull requests of Martian (Cal.com,
Grafana, Sentry) and of the public repositories of the org. The cases of private repositories
describe their defects, some of them security defects, and their commits and paths name these
repositories. A new name does not hide them, and a case with an invented commit cannot run. So
these cases are in the internal bench, a private repository apart from this one, with the same
layout:

| Internal bench | What it holds |
| --- | --- |
| `first-bench/cases.tsv`, `truth.json`, `truth.md`, `results.md` | the 7 cases of this first bench, their defects, and the results by case |
| `martian/subset-ts.json`, `subset-ts-v2.json`, `subset-ts-hard.json` | the internal part of each subset of [`martian/`](martian/) |
| `internal/subset-feedback.json` | the cases from the feedback of the private repositories |
| `results/` | the results by private repository |

The scripts stay here and read the internal bench by a path: `BENCH_CASES` for the scripts of this
folder, `--subset` with several files for [`martian/run.ts`](martian/run.ts). The public part and
the internal part together are the cases of before, so the scores stay comparable. Keep the
internal bench outside this work tree, for example beside it, and set `INTERNAL_BENCH` to its path.
A test ([`martian/public.test.ts`](martian/public.test.ts)) fails when a JSON file of `eval/` holds
a pull request of a repository that is not public.

## The cases

The 7 cases are in `$INTERNAL_BENCH/first-bench/cases.tsv`: one pull request range a line, with a
name, the repository, the base commit and the head commit. `truth.json` holds the defects of each
case as patterns for [`judge.py`](judge.py) ([`bench_cases.py`](bench_cases.py) reads both), and
`truth.md` describes them.

Each defect is one that an earlier reviewer (Claude Opus, exploring the repository) reported on that
head, and that a later commit fixed. One case has none: every blocking finding on it is a false
positive.

## Run it

1. Check out each case at its head commit, in a folder named after the case, inside `../wt` (or the
   folder that `WORKTREES` names, relative to the parent of this folder). `REPOS` is the folder of
   your clones:

   ```bash
   export BENCH_CASES=$INTERNAL_BENCH/first-bench
   while IFS=$'\t' read -r name repo base head; do
     git -C "$REPOS/$repo" worktree add --detach "$PWD/../wt/$name" "$head"
   done < "$BENCH_CASES/cases.tsv"
   ```

2. Put an OpenRouter key in the Keychain (service `openrouter-pr-review`, account `api-key`).
3. Run a label and the models:

   ```bash
   PROMPT=review-prompt-oneshot-v2.md python3 oneshot_or.py v3a xiaomi/mimo-v2.6-pro z-ai/glm-5.3
   ROUNDS=4 PROMPT=review-prompt-agent.md python3 agent_or.py ag3 xiaomi/mimo-v2.6-pro
   python3 judge.py v3a
   SHOW=1 python3 judge.py v3a | grep '^HIT'
   ```

   Without `BENCH_CASES`, the scripts stop at once and call no model.

   Pass a list of models through `bash`, not `zsh`: `zsh` does not split `$M` into words.

**Read the `SHOW` lines before you trust a number.** `judge.py` proposes a match from the path and
from words of the defect. On 2026-10-02, about half of its matches were a nearby finding and not the
defect. [`results.md`](results.md) counts the matches read by hand.

## What a run costs

On 2026-10-02 the whole series cost about $8.80 on OpenRouter: eleven models in one call, two runs
of the four best, and the same four as agents. Claude Sonnet 5.5 as an agent ($0.125 a review) and
GPT-5.6 Sol ($0.13) cost the most. A run of MiMo on the seven cases costs about $0.15.

[`results.md`](results.md) holds the results of that day, with no case named: the results by case
are in the internal bench. A run writes its answers to `runs/`,
which git ignores.

## Cases from the findings of Kentō (REV-112)

`apps/web/scripts/bench-cases.ts` reads the statuses of the findings in the database of the web
service, on a read-only connection, and writes cases for [`martian/run.ts`](martian/run.ts). These
cases come from the repositories that Kentō reviews, private ones too: the script refuses to write
in the work tree of this repository, except to a file that git ignores. Write them to the internal
bench.

- a finding `dismissed` with a reason is a known false positive: a variant must not report it again;
- a finding `fixed` or `wontfix` is a golden comment: a variant must find it again.

Each case is the last commit where a review found its findings, one commit for each pull request.
Their source is `kento` and their reviewer is `kento-review[bot]`: they count in the `kento`
profile of the results, never in the independent recall. Keep them in their own file:

```bash
DATABASE_URL=... pnpm -F @kento/web bench:cases "$INTERNAL_BENCH/internal/subset-kento.json" --weeks 12
node eval/martian/run.ts --subset "$INTERNAL_BENCH/internal/subset-kento.json" ...
```

`fixed` counts too many defects: a file can change for another reason. A dismissal that has no
reason (a 👎) gives no case. No status records an applied suggestion yet: its commit makes the
finding `fixed`.

## A rejected false positive (REV-95)

[`rejected/run.ts`](rejected/run.ts) builds a small pull request with a false P1 (« the port is not
validated », while a zod schema bounds it), rejects it with its cause, and reviews the same head
again. It measures whether the defect comes back and whether the score falls because of it.

```bash
node eval/rejected/run.ts                                                  # no model, no cost
OPENROUTER_API_KEY=... node eval/rejected/run.ts --model z-ai/glm-5.3 --runs 3
```

Without a model, the engine gets scripted answers: the same finding, the same defect in other words
one line off, the same title elsewhere in the file, and a real defect far from it. Measured on
2026-11-08, without a model (the deterministic net of `rejected.ts` only):

| answer of the model | findings without / with the rejection | blocking with | score without / with |
|---|---|---|---|
| the same finding | 1 / 0 | 0 | 2 / 4 |
| in other words, one line off | 1 / 0 | 0 | 2 / 4 |
| the same title, elsewhere in the file | 1 / 0 | 0 | 2 / 4 |
| a real defect far from it, with the false P1 | 2 / 1 | 0 | 2 / 4 |

With `--model`, the column « reported again by the model » counts the findings near the rejection
before the net: it measures the instruction of the prompt alone. Not measured yet with a model.
