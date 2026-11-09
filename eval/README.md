# The bench of Sakuga Review

The bench that chose the model of [`review/`](../review/). Run it again before you change the model
or the prompt, and when a new model comes out.

[`martian/`](martian/) runs the same cases with the TypeScript pull requests of the Martian Code
Review Bench and its judge, and gives the latest comparison of models.

## The cases

[`cases.tsv`](cases.tsv) holds one pull request range a line: a name, the repository, the base
commit and the head commit. [`truth.md`](truth.md) holds the defects of each case.

Each defect is one that an earlier reviewer (Claude Opus, exploring the repository) reported on that
head, and that a later commit fixed. `plai529clean` has none: every blocking finding on it is a
false positive.

## Run it

1. Check out each case at its head commit, in a folder named after the case, inside `../wt` (or the
   folder that `WORKTREES` names, relative to the parent of this folder):

   ```bash
   while IFS=$'\t' read -r name repo base head; do
     git -C ~/code/sakuga-software/$repo worktree add --detach "$PWD/../wt/$name" "$head"
   done < cases.tsv
   ```

2. Put an OpenRouter key in the Keychain (service `openrouter-pr-review`, account `api-key`).
3. Run a label and the models:

   ```bash
   PROMPT=review-prompt-oneshot-v2.md python3 oneshot_or.py v3a xiaomi/mimo-v2.6-pro z-ai/glm-5.3
   ROUNDS=4 PROMPT=review-prompt-agent.md python3 agent_or.py ag3 xiaomi/mimo-v2.6-pro
   python3 judge.py v3a
   SHOW=1 python3 judge.py v3a | grep '^HIT'
   ```

   Pass a list of models through `bash`, not `zsh`: `zsh` does not split `$M` into words.

**Read the `SHOW` lines before you trust a number.** `judge.py` proposes a match from the path and
from words of the defect. On 2026-10-02, about half of its matches were a nearby finding and not the
defect. [`results.md`](results.md) counts the matches read by hand.

## What a run costs

On 2026-10-02 the whole series cost about $8.80 on OpenRouter: eleven models in one call, two runs
of the four best, and the same four as agents. Claude Sonnet 5.5 as an agent ($0.125 a review) and
GPT-5.6 Sol ($0.13) cost the most. A run of MiMo on the seven cases costs about $0.15.

[`results.md`](results.md) holds the results of that day. A run writes its answers to `runs/`,
which git ignores.

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
