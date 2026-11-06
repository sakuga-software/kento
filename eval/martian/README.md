# A TypeScript slice of the Martian bench

[`run.ts`](run.ts) runs the engine of [`packages/engine`](../../packages/engine/) on each pull
request of a subset, as the Action does at the `lite` level, then asks the judge of the [Martian Code Review Bench](https://github.com/withmartian/code-review-benchmark)
(MIT) whether each finding matches each golden comment. The judge prompt is the one of Martian,
unchanged. The judge model is `anthropic/claude-sonnet-5.5`; keep it the same from one run to the
next. The full bench that this slice comes from is in [`../PLAN.md`](../PLAN.md).

## The subset

[`subset-ts.json`](subset-ts.json) holds 20 pull requests, with 60 golden comments:

- 13 pull requests of Martian whose repository is mostly TypeScript: 10 of Cal.com, 2 of Grafana,
  and 1 of Sentry (`ai-code-review-evaluation/sentry-greptile` #5);
- 7 internal cases of [`../cases.tsv`](../cases.tsv), with their defects from
  [`../truth.md`](../truth.md). `plai529clean` has none, so each finding on it is a false positive.

## Run it

`fetch.sh` needs `git` and `jq`; `run.ts` needs Node 26 or later, like the review.

```bash
eval/martian/fetch.sh eval/martian/subset-ts.json ../repos   # blobless clones, about 3 GB
OPENROUTER_API_KEY=... node eval/martian/run.ts --subset eval/martian/subset-ts.json \
  --repos ../repos --out ../results --label run1 --models z-ai/glm-5.3,openai/gpt-5.6-luna
```

`run.ts` writes one JSON file for each model and label, and skips a file that exists. If the judge
does not answer for a pair, the summary line counts it in `judge errors`: run that model again.

- `REVIEW_TIMEOUT_MS` sets the time limit of one model call (480 s by default here).
- `REVIEW_MAX_PRICE` (`prompt,completion`, in dollars a million tokens) sets the price cap. The cap of
  production (0.5 / 3.5) excludes some models, for example Gemini 3.8 Flash.
- A value of these variables, or of `REVIEW_MAX_TOKENS`, that is not a valid number stops the run
  at its start with the name of the variable.
- `REVIEW_TOOLS=1` gives the model the tools `read_file` and `grep` on the head, with the budget of
  the level (REV-68, `packages/engine/src/tools.ts`). Each review then records its tokens and what
  the tools used (`tokens`, `tools`). Compare it with a run without, on the same models.

**Cost**: about $0.20–0.50 of review and $0.30–0.80 of judge for each model and run. The key of the
bench is the key of CI: a run that uses the daily limit stops the reviews of the whole organization
until the limit resets (00:00 UTC). Count the cost before you start.

## A level, and a review in passes (REV-20)

`--level` runs another level than `lite` (`balanced`, `heavy`), with its models and its context.
`--passes` reviews in passes: each model of `--models` runs the three passes of base (security, data
and migrations, contracts and logic) at the `lite` level, on the same pack and at once; then the
model of the level reads each finding with its code and keeps or drops it. The check reads no
`REVIEW_*` variable but `REVIEW_TIMEOUT_MS`, so that it stays the same from one run to the next
([`packages/engine/src/passes.ts`](../../packages/engine/src/passes.ts), prompt
[`verify.md`](../../packages/engine/prompts/verify.md)). The file of a run names its level and
`passes`, and the summary line counts the findings that the check dropped and the passes that failed.

```bash
# balanced as today, then balanced in passes: Haiku 5.5 for the passes, Sonnet 5.5 for the check
OPENROUTER_API_KEY=... node eval/martian/run.ts --subset eval/martian/subset-ts.json --repos ../repos \
  --out ../results --label m5 --level balanced --models anthropic/claude-sonnet-5.5
OPENROUTER_API_KEY=... node eval/martian/run.ts --subset eval/martian/subset-ts.json --repos ../repos \
  --out ../results --label m5 --level balanced --passes --models anthropic/claude-haiku-5.5
```

`--provider anthropic` calls the Messages API of Anthropic with `ANTHROPIC_API_KEY`, for the review,
the check and the judge (Sonnet 5.5), with the prompt cache of production. The cost comes from
the price table of the engine. With this provider, the run does not use the key of CI.

## The bench v2: cases from the feedback of the org (REV-69)

[`subset-ts-v2.json`](subset-ts-v2.json) holds 80 pull requests and 240 golden comments: the 20 of
`subset-ts.json`, and 60 cases of [`../internal/subset-feedback.json`](../internal/subset-feedback.json)
(`source: "feedback"`). These cases come from the review comments of 9 repositories of the org, and
from the answers to them:

1. [`collect.sh`](../internal/collect.sh) gets the review comments of each pull request.
2. [`label.ts`](../internal/label.ts) (Haiku) reads each comment with its answer
   (`<!-- claude-reply -->`): `applied`, `partly`, `accepted`, `out_of_scope`, `wrong`, `duplicate`
   or `unclear`, with a Martian category, a severity and the defect in one sentence.
3. client-a has few answers. [`infer.ts`](../internal/infer.ts) compares each comment with the
   diff of its lines up to the last head of the pull request (Haiku). Sonnet then compares the
   comments of a pull request that are on the same file, at most 5 lines apart: `same`,
   `different` or `opposite`. If two comments are opposite, the comment that the last head does
   not follow is `wrong`.
4. [`build.ts`](../internal/build.ts) keeps one commit for each pull request, at most 2000 changed
   lines, and the code files only. An `applied`, `partly` or `accepted` comment is a golden comment.
   A `wrong` comment is a known false positive (`false_positives`).

Each run gives more numbers:

- the scoring profiles of Martian ([`profiles.ts`](profiles.ts)): **Core** is the main score,
  Strict and All show beside it. A finding that matches only a golden comment out of the profile
  counts in `matched_excluded`, not as a false positive;
- the F1 of Core for each source (`martian`, `internal`, `feedback`);
- `core medium+`: Core on the golden comments of Medium severity and more. A finding that matches
  only a Low golden comment counts in `matched_excluded`, as in the profiles: it is not a false
  positive, and it is not a true finding of this view;
- `independent recall`: the recall only (no precision) on the golden comments of a reviewer other than Kentō
  (`kento-review[bot]`, `sakuga-claude-review[bot]`);
- the findings that repeat a known false positive.

Most golden comments of `feedback` come from other review bots: CodeRabbit 60, Copilot 47,
Kilo 30, cubic 20, Greptile 14, Kentō 11 (a comment can have more than one reviewer). A case
holds the union of the comments of all these reviewers on one commit, so the recall of one
review stays far below 100 %.

### Results, 2026-11-03: Haiku 5.5 at `lite` and Sonnet 5.5 at `balanced`, one run each

F1 Core, recall and precision, Haiku / Sonnet:

| Source | PRs | F1 Core | Recall | Precision | Findings |
| --- | --- | --- | --- | --- | --- |
| martian | 13 | 0.46 / 0.57 | 21 / 25 of 46 | 47 / 60 % | 49 / 47 |
| internal | 7 | 0.33 / 0.11 | 3 / 1 of 10 | 38 / 13 % | 8 / 8 |
| feedback | 60 | 0.16 / 0.14 | 21 / 20 of 165 | 23 / 16 % | 84 / 112 |
| **all** | 80 | **0.25 / 0.24** | 20 / 21 % | 32 / 28 % | 141 / 167 |

- `core medium+` 0.26 / 0.27, independent recall 20 / 21 %.
- On `feedback`, Sonnet finds no more than Haiku. Of the 116 golden comments of Medium severity
  and more, each model finds 21, but only 11 are the same: together they find 31 (27 %). The
  limit is thus not the model alone, and two different reviews find more than one.
- Sonnet: review $7.39, judge $1.56, no failure, 5 judge errors, 1 finding repeats a known false
  positive.

Haiku:

- 2 findings repeat a known false positive (of 15), both on fruitback.
- Haiku gives 1.4 findings for each `feedback` case, but the past reviews give 2.75 golden
  comments. pantry (2/43) and atlas (2/38) lose most: their large pull requests hold many
  golden comments. client-a finds 8 of 50.
- Cost: review $0.62, judge $1.47. 1 failure (network), 5 judge errors.

## Results, 2026-11-02: the prompt and two samples (REV-67)

An error analysis of the 8 runs of REV-20 gave the misses that no run finds: 23 golden comments of
60. About 8 of them are `Low` comments that the prompt excludes on purpose (style, documentation,
performance). At least 4 sit in code that the pack does not hold (26 files of sentry-greptile#5 go
out for the size). 3 are about localisation, and the prompt had no item on it. Then:

- `review.md` gets an item on localisation (a fixed locale or separator, a key with a count and no
  plural form, a text that no translation file holds).
- `run.ts` keeps, for each finding of a row, the golden comments that it matches (`matches`).
- `--samples 2` runs two reviews of a pull request and merges their findings
  ([`merge.ts`](merge.ts)): two findings on one file at 3 lines or less are one, and the higher
  severity stays.

| Method | F1 Martian | Recall | Precision | Internal found | Review cost (20 PRs) | Median |
|---|---|---|---|---|---|---|
| `lite`: Haiku 5.5, before | 0.43 / 0.38 | 33 / 28 % | 42 / 40 % | 1 / 1 of 10 | $0.20 / $0.20 | 134 / 106 s |
| `lite`: Haiku 5.5, localisation item | 0.42 / 0.35 | 35 / 27 % | 43 / 38 % | 2 / 1 of 10 | $0.21 / $0.20 | 131 / 113 s |
| `lite`: Haiku 5.5, localisation item, 2 samples merged | 0.33 / 0.36 | 33 / 38 % | 26 / 28 % | 1 / 2 of 10 | $0.40 / $0.40 | 234 / 197 s |
| `balanced`: Sonnet 5.5, before | 0.40 / 0.45 | 37 / 42 % | 37 / 42 % | 2 / 2 of 10 | $2.09 / $2.09 | 48 / 46 s |
| `balanced`: Sonnet 5.5, localisation item | 0.43 / 0.50 | 38 / 43 % | 43 / 43 % | 3 / 1 of 10 | $2.07 / $2.09 | 44 / 47 s |

- **The localisation item finds what it aims at.** The 3 golden comments that it aims at give
  6 chances a model (3 × 2 runs). Haiku finds 3 of them, Sonnet 3; before, no run of 8 found one. The
  plural form of `en/admin.json` stays missed. F1 does not move more than the noise, and the
  findings do not grow: 49 / 42 for Haiku, 53 / 60 for Sonnet.
- **Two samples merged do not pay.** Recall goes from 31 to 35 % on average, but precision falls
  from 41 to 27 %: the second sample adds about 35 findings for 3 more golden comments found. The
  merge by place also leaves duplicates: 7 to 8 golden comments a run match two kept
  findings. With no duplicate at all, precision stays under 30 %.

Cost: $9.00 for the 6 runs, with the judge.

## Results, 2026-11-02: one model or passes, at each level (REV-20)

The same 20 pull requests, Anthropic direct. Each column gives one value a run. The cost is for the
20 reviews; the judge is not in it. The cost of a defect is the review cost over the golden comments
found (of 60).

| Method | F1 Martian | Recall | Precision | Internal found | Review cost (20 PRs) | Cost of a defect | Median |
|---|---|---|---|---|---|---|---|
| `lite`: Haiku 5.5 | 0.43 / 0.38 | 33 / 28 % | 42 / 40 % | 1 / 1 of 10 | $0.20 / $0.20 | $0.011 | 134 / 106 s |
| `balanced`: Sonnet 5.5 | 0.40 / 0.45 | 37 / 42 % | 37 / 42 % | 2 / 2 of 10 | $2.09 / $2.09 | $0.089 | 48 / 46 s |
| `balanced` in passes: Haiku 5.5, Sonnet 5.5 check | 0.29 / 0.39 | 27 / 33 % | 31 / 41 % | 2 / 2 of 10 | $2.24 / $2.17 | $0.123 | 312 / 273 s |
| `heavy`: Opus 5.5 | 0.55 | 47 % | 54 % | 2 of 10 | $5.92 | $0.211 | 191 s |
| `heavy` in passes: Haiku 5.5, Opus 5.5 check | 0.43 | 35 % | 43 % | 1 of 10 | $4.26 | $0.203 | 305 s |

The check of the passes:

| Method | Check cost | Share of the review cost | Findings dropped | Golden comments found only by a dropped finding |
|---|---|---|---|---|
| `balanced` in passes | $1.72 / $1.65 | 77 / 76 % | 18 / 21 | 1 / 2 |
| `heavy` in passes | $3.74 | 88 % | 21 | 4 |

- **At each level, the passes find less than one model alone, and cost about as much.** At
  `balanced`, F1 is 0.34 against 0.43 on average, for $2.2 against $2.1. At `heavy`, F1 is 0.43
  against 0.55, for $4.3 against $5.9. The passes are also 1.6 to 6 times slower.
- **The loss comes from the passes, not from the check.** Without the check, the passes find
  1 to 4 golden comments more. That is still less than one model alone.
- **The check is most of the cost.** One pass of Haiku costs about 1 cent; the check reads each
  finding with its code at the model of the level.
- **Opus 5.5 alone finds the most**: 28 golden comments of 60, for 30 cents a review.
- **Haiku 5.5 alone finds about 80 % of what Sonnet 5.5 finds, for a tenth of the cost.**

Limits of these numbers:

- The passes read the pack of `lite` (with the definitions), and one model alone at `balanced` and
  `heavy` reads the full pack. This bench measures the passes as `passes.ts` builds them, not
  passes in general.
- From one run to the next, F1 changes by 0.05 to 0.10. The `heavy` rows have one run each.
- A judge error is one pair (golden comment, finding) that the judge did not answer after three
  tries. It counts as no match. There are 1 to 4 in a run, of several thousand pairs.

Cost of the bench: $19.17 of review and $5.04 of judge, for the 8 runs.

## Results, 2026-10-08: Claude Haiku 5.5 for `lite`

The same 20 pull requests, with the review of v5 (the definitions in the pack). Each column gives
one value a run.

| Model, reasoning, output cap | F1 Martian | Recall | Precision | Internal found | Review cost (20 PRs) | Median | Failures |
|---|---|---|---|---|---|---|---|
| `z-ai/glm-5.3`, low, 16k (`lite` until v5) | 0.41 / 0.37 / 0.33 | 33 / 28 / 23 % | 42 / 38 / 41 % | 1 / 0 / 1 of 10 | $0.22 / $0.21 / $0.39 | 58 / 46 / 67 s | 0 / 0 / 2 |
| `anthropic/claude-haiku-5.5`, low, 16k | 0.32 / 0.30 | 25 / 22 % | 33 / 31 % | 1 / 0 of 10 | $0.16 / $0.16 | 24 / 11 s | 0 / 0 |
| `anthropic/claude-haiku-5.5`, medium, 32k (`lite` from v5.1) | 0.39 / 0.46 | 33 / 37 % | 39 / 48 % | 2 / 1 of 10 | $0.20 / $0.21 | 21 / 25 s | 0 / 0 |
| `anthropic/claude-haiku-5.5`, high, 32k | 0.37 / 0.47 | 37 / 42 % | 35 / 50 % | 3 / 3 of 10 | $0.32 / $0.31 | 60 / 55 s | 0 / 0 |
| `anthropic/claude-haiku-5.5`, high, 16k | 0.17 / 0.21 | 13 / 15 % | 28 / 28 % | 2 / 1 of 10 | $0.10 / $0.11 | 62 / 58 s | 8 / 7 |

- **At low reasoning Haiku 5.5 finds less than GLM-5.3.** With more reasoning it finds as much or
  more. No review failed in 120 when the output cap left room for the answer.
- **High reasoning finds the most internal defects**: 3 of 10 in both runs, with the unique
  violation that drizzle wraps on pantry#565, which no cheap model found before. It costs 1.6 cents a
  review against 1.0 at medium.
- **The reasoning counts in the output tokens.** At 16,000, high reasoning left no room for the
  answer in 7 to 8 reviews of 20: the content came back empty. The two failures of GLM-5.3 in its
  third run have the same symptom.
- `mistralai/mistral-large-4-0`, released the same week, has no provider with zero data retention.

`REVIEW_EFFORT` (`low`, `medium`, `high`) and `REVIEW_MAX_TOKENS` set the reasoning and the output
cap of a run.

## Results, 2026-10-03

Up to three runs of the 20 pull requests, counted as Martian counts them (see `score` in `run.ts`).
F1 Martian counts the 13 pull requests of Martian only; recall and precision count all 20. A failure
is a review that gave no answer.

| Model | F1 Martian | Recall | Precision | Internal found | Review cost (20 PRs) | Median | Failures |
|---|---|---|---|---|---|---|---|
| `z-ai/glm-5.3` (production) | 0.36 / 0.43 / 0.38 | 35 / 37 / 30 % | 32 / 42 / 38 % | 1 / 1 / 0 of 10 | $0.21–0.23 | 37–71 s | 2 / 2 / 1 |
| `xiaomi/mimo-v2.6-pro` | 0.49 / 0.43 / — | 52 / 32 / — % | 40 / 49 / — % | 4 / 0 / — of 10 | $0.44 | 347–480 s | 0 / 11 / 20 |
| `openai/gpt-5.6-luna` | 0.35 / 0.34 / 0.27 | 25 / 22 / 20 % | 54 / 43 / 34 % | 2 / 0 / 1 of 10 | $0.15 | 11–12 s | 0 / 0 / 0 |
| `qwen/qwen3.8-27b` | 0.37 / 0.15 | 27 / 10 % | 43 / 21 % | 0 / 0 of 10 | $0.50–0.52 | 46–54 s | 1 / 2 |
| `google/gemini-3.8-flash` (cap 0.8 / 4) | 0.30 / 0.28 | 20 / 18 % | 39 / 39 % | 0 / 0 of 10 | $0.48–0.49 | 6–8 s | 0 / 0 |

The third run of GLM-5.3 and Luna had 2 judge errors each, so their figures can be a little low.
In the evening, MiMo hit timeouts (480 s) and `429 rate-limited upstream` at its providers: 11 of
20 reviews failed in its second run, and all 20 in its third.

The commercial tools on the same 13 pull requests, from the published results of Martian (judge
Claude Sonnet 4.5, so the comparison is approximate): Augment 0.58, Copilot v2 0.53, CodeRabbit
0.47, Greptile v4.1 0.44, Claude Code 0.34.

What it shows:

- **GLM-5.3 stays in production**: it gives the best balance of F1, cost and speed. Its F1 is 0.36
  to 0.43 (0.39 on average), near Greptile, at about 1 ¢ a review. MiMo has a higher F1, but not a
  reliable answer.
- **MiMo finds the most when it answers** (F1 0.49 in its one full run, 4 of the 10 internal
  defects), but it takes 6 to 8 minutes, and its providers fail under load. It is not a reliable
  fallback.
- **GPT-5.6 Luna is more precise than GLM-5.3** (44 % against 37 % on average), fast (11 s) and
  reliable (0 failures in 60 reviews), but it finds less: F1 0.27 to 0.35. Gemini is also reliable
  and a little faster, but its F1 is lower. With the `APPROVE` verdict, a lower recall
  means more approved pull requests with a defect. It is a good fallback, or a second opinion.
- **Qwen 3.8 27B varies too much** from one run to the next (0.37, then 0.15).
- **Gemini 3.8 Flash** finds less than GLM-5.3 and costs twice as much.
- All models miss most internal defects: those cross files or services, which one diff does not show.
  The context experiment of `PLAN.md` targets them.

The first runs read `CLAUDE.md` from the working tree: the internal cases had a worktree at the
head, the Martian clones had no checkout. The third runs of GLM-5.3 and Luna, and the second and third
of MiMo, read it at the head commit, as CI does. Of the Martian pull requests, only `sentry-greptile`
#5 changes (its head has one).
