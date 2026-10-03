# The full bench (parked)

On 2026-10-03 this plan was parked for its cost: about $60–80 once, then about $10 a month. Only a
slice of it runs now: [`martian/`](martian/), a few models on the TypeScript pull requests of
Martian and on our own cases. Take this plan again when the budget allows it.

## 1. The bench

- **Martian** ([withmartian/code-review-benchmark](https://github.com/withmartian/code-review-benchmark),
  MIT): 50 pull requests of Sentry, Grafana, Cal.com, Discourse and Keycloak, 173 golden comments
  checked by hand, a published judge prompt, and the scores of 49 tools with the same judge. The
  pull requests date from 2023–2025, so a model can have seen them in training.
- **Internal**: harvest the threads of our pull requests (Sakuga Review, Greptile, CodeRabbit,
  Copilot, the old Claude reviewer) that a fix commit followed. This is the "online" method of
  Martian, with no training leak. Add clean pull requests to measure the false positives.
- **Three runs a configuration**, to measure the variance and not one sample.
- One judge model for all runs: `anthropic/claude-sonnet-5.5` through OpenRouter.

## 2. The harness experiments

- **Context**: add the callers and the definitions of the changed symbols, found with `git grep`,
  with no agent. All reviewers miss the cross-file defects, and this targets them.
- **Self-consistency**: three cheap samples, and keep the findings that at least two samples give.
- **Verification**: a second call confirms or rejects each finding.
- **Split** the large pull requests by groups of files.
- **Models**: GLM-5.3, MiMo, DeepSeek V4 Pro and Flash, Kimi K2.6, Qwen 3.8, GPT-5.6 Luna,
  Gemini 3.8 Flash, MiniMax M3, on the best harness.

## 3. Regular runs

Add a workflow to this repository. It must run the bench each month and on each pull request that
changes `review/`, on `runners-host`, and post the table of scores. This workflow does not exist
yet.

## Budget

About $2.50 a configuration and a run on the 50 pull requests (review and judge). The judge costs
about three times the review.
