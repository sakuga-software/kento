# A TypeScript slice of the Martian bench

[`run.ts`](run.ts) runs the engine of [`packages/engine`](../../packages/engine/) on each pull
request of a subset, as the Action does at the `lite` level, then asks the judge of the [Martian Code Review Bench](https://github.com/withmartian/code-review-benchmark)
(MIT) whether each finding matches each golden comment. The judge prompt is the one of Martian,
unchanged. The judge model is `anthropic/claude-sonnet-5.5`; keep it the same from one run to the
next. The full bench that this slice comes from is in [`../PLAN.md`](../PLAN.md).

## The subset

[`subset-ts.json`](subset-ts.json) holds 13 pull requests of Martian whose repository is mostly
TypeScript, with 50 golden comments: 10 of Cal.com, 2 of Grafana, and 1 of Sentry
(`ai-code-review-evaluation/sentry-greptile` #5).

The results below count 20 pull requests and 60 golden comments: these 13, and the 7 internal
cases of the first bench, with their 10 defects. One internal case has none, so each finding on it
is a false positive. The internal cases are pull requests of private repositories: they are in the
internal bench, apart from this repository ([`../README.md`](../README.md)), in
`$INTERNAL_BENCH/martian/subset-ts.json`. Each subset of this folder has its internal part there,
under the same name. `--subset` takes both, separated by a comma, and gives the 20 pull requests
of before (REV-121):

```bash
--subset eval/martian/subset-ts.json,$INTERNAL_BENCH/martian/subset-ts.json
```

Martian publishes its bench under the MIT license: see [`NOTICE.md`](NOTICE.md).

## Run it

`fetch.sh` needs `git` and `jq`; `run.ts` needs Node 26 or later, like the review.

```bash
eval/martian/fetch.sh eval/martian/subset-ts.json ../repos   # blobless clones, about 3 GB
# the internal part needs read access to the private repositories
eval/martian/fetch.sh "$INTERNAL_BENCH/martian/subset-ts.json" ../repos
OPENROUTER_API_KEY=... node eval/martian/run.ts --subset eval/martian/subset-ts.json \
  --repos ../repos --out ../results --label run1 --models z-ai/glm-5.3,openai/gpt-5.6-luna
```

`run.ts` writes one JSON file for each model and label (and repeat, with `--repeats`), and skips a
file that exists. If the judge does not answer for a pair, the summary line counts it in
`unjudged pairs`: delete the file and run the same command again. The reviews and the verdicts
stay in `--out`, so only the missing verdicts cost (see REV-109 below).

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

The bench v2 holds 80 pull requests and 240 golden comments: the 20 of `subset-ts.json` with its
internal part, and 60 cases from the review comments of 9 repositories of the org, and from the
answers to them (`source: "feedback"`). In this repository, [`subset-ts-v2.json`](subset-ts-v2.json)
holds its public part: the 13 pull requests of Martian, and the 25 cases of
[`../internal/subset-feedback.json`](../internal/subset-feedback.json), from the 4 public
repositories of the org. Its internal part, `$INTERNAL_BENCH/martian/subset-ts-v2.json`, holds the
42 others: the 7 internal cases, and 35 cases from 5 private repositories. A test checks that
`subset-ts-v2.json` is `subset-ts.json` then `subset-feedback.json`, and that no JSON file of
`eval/` holds a pull request of a private repository ([`public.test.ts`](public.test.ts)).

The cases come from these steps:

1. [`collect.sh`](../internal/collect.sh) gets the review comments of each pull request.
2. [`label.ts`](../internal/label.ts) (Haiku) reads each comment with its answer
   (`<!-- claude-reply -->`): `applied`, `partly`, `accepted`, `out_of_scope`, `wrong`, `duplicate`
   or `unclear`, with a Martian category, a severity and the defect in one sentence.
3. For a repository with few answers, [`infer.ts`](../internal/infer.ts) compares each comment with the
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

Most golden comments of `feedback` come from other review bots, and 11 from Kentō (a comment can
have more than one reviewer). A case holds the union of the comments of all these reviewers on one commit, so the recall of one
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
  comments. The repositories with large pull requests lose most: these pull requests hold many
  golden comments. The results by private repository are in the internal bench.
- Cost: review $0.62, judge $1.47. 1 failure (network), 5 judge errors.

## Compare two variants: a progress or noise (REV-109)

One run of each variant does not tell a progress from noise. On 2026-11-12, four prompts of
REV-104, all near the prompt of `main`, gave a Core F1 from 0.11 to 0.18 on the 80 pull requests.
The protocol below measures a difference with an interval, on the same pull requests, and says
when the interval is too wide to decide.

### The protocol

1. **The hard subset.** The hard subset holds 57 pull requests of v2: the 44 with 2 golden
   comments or more of the Core profile above `Low` (147 such comments: martian 10, internal 3,
   feedback 31), and the 13 with no golden comment, for precision. Its public part,
   [`subset-ts-hard.json`](subset-ts-hard.json), holds 23 of them (15 dense, 8 with no golden
   comment); `$INTERNAL_BENCH/martian/subset-ts-hard.json` holds the 34 others.
   [`hard.ts`](hard.ts) builds each part from the labels of its part of v2 only, never from past
   scores, and a test checks that the public file follows the rule. These pull requests are the
   dense ones: recall moves on them. Confirm a winner once on the 80 pull requests.
2. **Each variant gets its own label**, the same model, level and subset, and `--repeats 3`
   (2 if the budget is short). Give a variant of the prompt with `--prompt <file>`: the engine
   reads that file in place of `prompts/review.md` (`prompts` of `ModelClient`), and nothing
   changes in the engine.
3. **The judge**: Claude Sonnet 5.5, with the effort set to `low` in `run.ts`, so that a change
   of the default of the model does not change the verdicts. `--judge-batch` sends the pairs
   through the Message Batches API (`--provider anthropic` only), at half the price; it takes
   minutes, and at most 24 hours.
4. **The comparison**: [`compare.ts`](compare.ts), with the files of each arm.

```bash
HARD=eval/martian/subset-ts-hard.json,$INTERNAL_BENCH/martian/subset-ts-hard.json
ANTHROPIC_API_KEY=... node eval/martian/run.ts --provider anthropic --subset "$HARD" \
  --repos ../repos --out ../results --label base --models claude-haiku-5-5 --repeats 3 --judge-batch --concurrency 3
ANTHROPIC_API_KEY=... node eval/martian/run.ts --provider anthropic --subset "$HARD" \
  --repos ../repos --out ../results --label variant --prompt variant.md --models claude-haiku-5-5 --repeats 3 --judge-batch --concurrency 3
node eval/martian/compare.ts --a ../results/base-r1-claude-haiku-5-5.json,../results/base-r2-claude-haiku-5-5.json,../results/base-r3-claude-haiku-5-5.json \
  --b ../results/variant-r1-claude-haiku-5-5.json,../results/variant-r2-claude-haiku-5-5.json,../results/variant-r3-claude-haiku-5-5.json
```

What `run.ts` keeps in `--out`:

- `reviews/<label>-<prompt hash>/<model>/`: each review, by pull request and repeat. A run that
  stops reads them again and pays only for the reviews that it did not finish. A review that
  failed for another cause than a truncation is not kept.
- `judge-cache.jsonl`: each verdict, by judge model, judge prompt, effort, golden comment and
  finding, with its confidence, its reasoning and its cost. A second run on the same findings
  costs nothing. The verdicts of two variants rarely meet, because their findings differ.
- `judge-batch.json`: the batch of the judge that is not finished. A run that stops reads its
  results, and does not send it again.

`--estimate` stops after the reviews, and gives the number of pairs that the judge must read and
their cost. Use it before the judge, then run the same command without it.

### What counts

- **Failures**: `errors` (no answer), `truncated` (the model reached its output cap and its
  JSON is cut) and `fallbacks` (another model of the level answered). On the hard subset, Haiku
  5.5 at `lite` cuts 2 to 8 reviews of 57 a run: the dense pull requests are the ones that cut.
  compare.ts keeps a pull request if each arm has one review of it or more that did not fail;
  else it leaves the pull request out of both arms, and counts it. A cut review is not a review
  with no finding.
- **Unjudged pairs**: a pair that the judge does not answer after three tries stays out of the
  cache. Its golden comment, if no finding matches it, leaves both arms (`unjudged` in the row),
  and so does its finding for precision (`unjudged_findings`). Run the same command again: the
  judge reads only the pairs that have no verdict.
- **Core and Core medium+**, recall and precision apart. F1 hides two metrics that move in
  opposite directions.

### compare.ts

- It aligns the rows of the two arms by pull request. For each arm, a golden comment counts as
  found by the share of the repeats that find it, and the findings by their mean over the
  repeats.
- The paired bootstrap draws pull requests (10,000 draws, `--seed`), not golden comments: the
  golden comments of one pull request depend on one review. It gives Δ = B − A and its 95 %
  interval for recall, precision and F1, on Core and Core medium+.
- McNemar on the majority verdict of each golden comment (a tie is "not found"), with the
  discordance `d`: the share of golden comments that one arm finds and the other does not.
- The decision, on Core medium+: **B wins if the interval of Δrecall is above 0 and the low end
  of Δprecision is above −0.05, or if the interval of Δprecision is above 0 and the low end of
  Δrecall is above −0.05.** The same rule, the other way, makes A win. Else: "No detectable
  difference", or "a trade-off" when one metric moves and the other can fall by more than 0.05.
- For a change of cost or speed, it says also when the interval of Δrecall is inside ±0.05.

`--subset` limits the comparison to the pull requests of a subset: run it with the hard subset
(both parts, `"$HARD"`) on files of the 80 pull requests.

### The noise, measured on 2026-11-12

With no API call, on the four runs of REV-104 (Haiku 5.5, `lite`, one run each, 80 pull
requests), limited to the hard subset:

| A | B | PRs kept | d (Core medium+) | Δrecall Core medium+ [95 %] | Δprecision [95 %] | MDE |
|---|---|---|---|---|---|---|
| main | rev104b | 50 | 0.117 | +0.008 [−0.047, +0.065] | +0.079 [−0.050, +0.218] | 0.080 |
| rev104 | rev104b | 46 | 0.136 | +0.017 [−0.068, +0.101] | +0.059 [−0.094, +0.205] | 0.121 |
| main | rev104c | 50 | 0.116 | −0.029 [−0.076, +0.020] | −0.077 [−0.198, +0.038] | 0.068 |
| rev104b | rev104c | 45 | 0.124 | −0.041 [−0.101, +0.017] | −0.171 [−0.324, −0.028] | 0.083 |

- **The discordance d is about 0.12**: of 100 golden comments of Core medium+, two runs disagree on
  12. These runs differ by their prompt too, so 0.12 is the upper limit of the noise of one run.
- **The minimum detectable effect (MDE)** is 2.8 times the bootstrap standard error of Δrecall:
  the difference that the comparison finds 8 times of 10, at a risk of 5 %. With one run an arm,
  it is 7 to 12 points of recall. Three repeats an arm take off about a quarter (Miller 2024: two
  repeats remove a third of the variance of the review, at most two thirds); more pull requests
  take off the rest. Plan about 6 to 9 points with 3 repeats.
- A change of the prompt that moves recall by 2 or 3 points stays under this limit. Spend runs on
  changes large enough to pass it.
- Only rev104b against rev104c gives a verdict: rev104c is less precise. The other three pairs,
  among them `main` against rev104b, give no detectable difference.

### The prefilter of the judge

`--prefilter` sends a golden comment that starts with a file name (180 of 180 golden comments of
`feedback`, 9 of 10 of `internal`, none of Martian) to the judge only with the findings on that
file, or whose text names it ([`prefilter.ts`](prefilter.ts)). On the four runs above, it keeps
58 to 76 % of the pairs, but it loses 9 of 108 matches (8 %): a finding on the caller can match
a golden comment on the function, and the judge accepts it. The loss is not the same in each arm
(0 to 4 matches a run), so use it only to save money, the same in both arms, and say so with the
result. Measure it on scored files with no API call:

```bash
node eval/martian/prefilter.ts --subset eval/martian/subset-ts-v2.json,$INTERNAL_BENCH/martian/subset-ts-v2.json ../results/*.json
```

### First use, 2026-11-12: the prompt of 2026-11-03 against the prompt of `main`

The Core F1 went from 0.25 on 2026-11-03 to 0.16 on 2026-11-12 with the prompt of `main`, and
the prompt grew by 37 % in between (REV-70 to REV-100). A: `prompts/review.md` of `0728627`
(`--prompt`), B: the prompt of `main`. Both on the engine of today, Haiku 5.5, `--provider
anthropic`, `lite`, the hard subset, one run each, the judge in a batch with `--prefilter`.

| | A: `0728627` | B: `main` |
|---|---|---|
| Findings | 103 | 66 |
| Truncated reviews | 0 of 57 | 5 of 57 |
| Core medium+ recall / precision (52 pull requests) | 0.196 / 0.264 | 0.130 / 0.283 |
| Review cost / judge cost | $0.423 / $0.352 | $0.383 / $0.234 |

compare.ts on the 52 pull requests that both arms reviewed:

- Δrecall Core medium+ −0.065 [−0.121, −0.013], Δprecision +0.020 [−0.079, +0.114]. On Core:
  Δrecall −0.038 [−0.089, +0.011], Δprecision +0.051 [−0.056, +0.159].
- McNemar, Core medium+: 138 golden comments, A only 13, B only 4, d 0.123, p 0.049. MDE 0.077.
- Verdict: "A has the higher recall (+6.5 points), but its precision can be lower by up to 11.4
  points, more than the margin of 5.0 points. No arm wins."

What it says:

- **The prompt of `main` finds less on this subset**, and the interval of recall excludes 0. The
  precision interval is too wide to exclude a loss of more than 5 points in A, so the rule does
  not adopt A.
- **The prompt of `main` cuts 5 reviews of 57, the prompt of `0728627` none.** compare.ts leaves
  these 5 dense pull requests out of both arms, so the gap above understates the loss of `main`.
  If the 5 cut reviews count as reviews with no finding, Δrecall is −0.068 [−0.122, −0.016] on
  the 57 pull requests.
- These numbers have one run each and the prefilter (8 % of matches lost, see above). The judge
  effort is now `low`: compare the arms of one date, not these values with the results of
  2026-11-03. Confirm with `--repeats 3` before a change of the prompt.

Cost: $1.40 (review $0.81, judge $0.59 for 522 pairs in two batches, and a test batch of 8 pairs).

### Cost

On the hard subset, Haiku 5.5 at `lite`: about $0.30–0.40 of review a run. The judge reads
about 200 to 370 pairs a run: $0.0025 a pair at the default effort and price, $0.0011 to
$0.0012 with `--judge-batch` and the effort `low` (measured). One run costs about $0.6–0.8 with
the batch, so two arms with 3 repeats each cost about $3.5–5. The batches of the first use
ended in less than 5 minutes.

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
  missing plural form of a translation key of an internal case stays missed. F1 does not move more than the noise, and the
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
  violation that the ORM wraps, on an internal case, which no cheap model found before. It costs 1.6 cents a
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
Claude Sonnet 4.5, so the comparison is approximate) have an F1 from 0.34 to 0.58.

What it shows:

- **GLM-5.3 stays in production**: it gives the best balance of F1, cost and speed. Its F1 is 0.36
  to 0.43 (0.39 on average), in the range of the commercial tools, at about 1 ¢ a review. MiMo has a higher F1, but not a
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
