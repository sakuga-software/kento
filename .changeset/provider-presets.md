---
"@kento-review/web": patch
---

**Provider presets** (KNT-204): "Settings → Providers and keys → Add a provider" starts with a
choice of the provider: a known server of the OpenAI API fills the name, the URL, the models of
each level and the link to the page of its keys, and everything stays editable. "Other
OpenAI-compatible server" keeps the form as before. The list of the providers and the Config screen
of a repository name the preset of a provider, found by its base URL: a provider added before this
release gets it too. The models of the presets have dated prices, so their cost counts in the cost
limit. A preset is a provider of the kind `openai_compatible`: no migration, no new kind, and no
change of the protocol of the runners.
