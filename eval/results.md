# Results of 2026-10-02

Seven cases, ten defects (see [`truth.md`](truth.md)). Each match below was read by hand: a finding
counts when it names the defect, not a nearby one.

## One call

| Model | Runs | Defects found per run | Clean PR blocked | Cost a review | No answer |
| --- | --- | --- | --- | --- | --- |
| `xiaomi/mimo-v2.6-pro` | 3 | about 2.3 | 0 of 3 | $0.02 | 0 |
| `z-ai/glm-5.3` | 2 | 1.5 to 2 | 0 of 2 | $0.02 | 0 |
| `openai/gpt-5.6-sol` | 1 | 2 | 0 of 1 | $0.13 | 0 |
| `anthropic/claude-sonnet-5.5` | 3 | about 1.3 | 0 of 3 | $0.08 | 0 |
| `openai/gpt-5.6-luna` | 3 | about 1.3 | 0 of 3 | $0.002 | 0 |
| `moonshotai/kimi-k3` | 1 | 1 | 0 of 1 | $0.08 | 0 |
| `anthropic/claude-haiku-4.5` | 1 | 0 | 0 of 1 | $0.04 | 0 |
| `google/gemini-3.8-flash` | 1 | 0 | 0 of 1 | $0.02 | 0 |
| `qwen/qwen3.8-27b` | 1 | 0 | 0 of 1 | $0.02 | 0 |
| `deepseek/deepseek-v4-pro` | 2 | about 0.3 | — | $0.08 | 3 of 7 |
| `moonshotai/kimi-k2.6` | 1 | 0 | — | $0.07 | 3 of 7 |
| Scaleway: `qwen3.5-397b`, `glm-5.2`, `gpt-oss-120b`, `qwen3.6-35b`, `deepseek-v4-flash` | 1 each | 0 to 1 | 1 of 5 | €0.001 to €0.13 | 9 of 30 |

`mistralai/mistral-large-2512` has no provider on OpenRouter that keeps nothing: it answered 404.

## Agents (4 rounds of `read_file`, `search`, `list_dir`)

| Model | Runs | Defects found per run | Clean PR blocked | Cost a review |
| --- | --- | --- | --- | --- |
| `anthropic/claude-sonnet-5.5` | 2 | about 0.5 | 0 | $0.125 |
| `z-ai/glm-5.3` | 2 | about 0.5 | 0 | $0.03 |
| `openai/gpt-5.6-luna` | 2 | 0 | 0 | $0.016 |
| `xiaomi/mimo-v2.6-pro` | 1 | 0 | 0 | $0.03 |

The prompt cache works through OpenRouter (21 k tokens read from it at rounds 2 and 3), but the
agents read files without aiming better: fewer defects than one call.

## Which defects

| Defect | Found by (one call) |
| --- | --- |
| plai565 G1: a `null` body answers 500 | every model of the top six, on most runs |
| dbx539 G1: the French decimal comma | MiMo, GLM-5.3, Kimi K3 |
| plai574 G2: an explicit `isActive` clears the pause of the site | MiMo, Sonnet 5.5 |
| suri1035 G1: a line paid in part leaves the demand | GPT-5.6 Sol, Luna (once), MiMo and GLM-5.3 in part (the sale of several lines) |
| plai549 G1, G2, G3; plai565a G1; plai574 G1; dbx539 G2 | nobody |

The six defects that nobody found need a reading of another service (the relay of plai549), of a
library (drizzle wraps the error of plai565a), or of the input side of a schema.

## Frequent false positives

- A file, an import or a function named "missing" because the diff does not show it. The prompt now
  forbids it.
- On atlas#1035, the own lots read with their total quantity and not their remainder: the code
  replays the whole history, so the total is right. Luna, GLM-5.3 and DeepSeek reported it.
- A blocking finding on the clean PR, on a line that the PR did not change. The script now blocks
  only on a changed line.
