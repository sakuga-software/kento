---
"@kento-review/web": patch
"@kento-review/runner": patch
---

**Presets of the clouds of Europe and of the local servers** (KNT-205). "Add a provider" offers
Scaleway Generative APIs (Paris, zero data retention by default) and OVHcloud AI Endpoints (the
European Union, no data stored), with the models that their docs give for a JSON schema, and their
prices in euros counted in dollars at the rate of the ECB of 2026-11-24. It also offers LM Studio,
vLLM and the llama.cpp server on the network of a runner, as Ollama: the form fills their default
URL and keeps the key on the runner, takes an `http://` URL only for a server that the runner
holds, and a call to such a server costs 0. A runner with `PROVIDER_KIND=openai_compatible` and an
`http://` `PROVIDER_BASE_URL` calls its own server, with no key. No migration, no new kind.
