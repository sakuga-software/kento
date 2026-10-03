# A TypeScript slice of the Martian bench

[`run.ts`](run.ts) runs `review/sakuga-review.ts --dry-run` on each pull request of a subset, then
asks the judge of the [Martian Code Review Bench](https://github.com/withmartian/code-review-benchmark)
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

`fetch.sh` needs `git` and `jq`; `run.ts` needs Node 24 or later, like the review.

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

**Cost**: about $0.20–0.50 of review and $0.30–0.80 of judge for each model and run. The key of the
bench is the key of CI: a run that uses the daily limit stops the reviews of the whole organization
until the limit resets (00:00 UTC). Count the cost before you start.

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
