---
"@kento-review/web": patch
---

pr: #87

**Provider presets** (KNT-204): "Settings → Providers and keys → Add a provider" starts with a
choice of the provider. OpenAI, Google Gemini, Mistral, Groq, xAI, Together AI, Fireworks AI,
DeepInfra and Cerebras fill the name, the URL, the models of each level and the link to the page of
their keys, and show their data terms; everything stays editable. "Other OpenAI-compatible server"
keeps the form as before. The list of the providers and the Config screen of a repository name the
preset of a provider by its base URL, so a provider added before this release gets it too. The
models of the presets have dated prices, so their cost counts in the cost limit.

The runner calls a preset through the OpenAI-compatible adapter of the engine
(`packages/engine/src/providers.ts`; no file of `apps/runner` changes). On the base URL of a preset,
the adapter sends the field of its answer cap (`max_completion_tokens` at OpenAI and xAI) and no
more answer tokens than its model takes. It reads more limits of the providers (KNT-161): the codes of OpenAI (`credit_balance_exhausted`, `organization_spend_limit_exceeded`…),
the spend limit of Groq (a 400, which no longer gets a second call), the `retryDelay` of Gemini, and
a « quota » of a minute, which is a rate limit and no longer stops the review.

A preset is a provider of the kind `openai_compatible`: no migration, no new kind, and no change of
the protocol of the runners. A runner of an earlier release calls a preset as any server of the
OpenAI API, with `max_tokens`: update the runners before you add the OpenAI preset, whose reasoning
models refuse that field.
