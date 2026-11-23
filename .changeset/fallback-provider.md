---
"@kento-review/web": patch
---

pr: #50

**Fallback provider** (KNT-161): each level of Config and Settings gets an optional fallback
provider and its model, next to the fallback model. When the provider of the level refuses the call
on its usage limit, the runner calls the fallback provider once, and the review says which provider
answered. A short rate limit does not switch provider: the job waits for its reset and runs again
on the same provider. A resolution falls back in the same way and says so in its summary. The cost
of a review or a resolution that the fallback answered goes to the fallback provider, and such a job
does not mark the provider of the job as working. A failure of the fallback names both providers by
their labels in the comment. Its key goes to a runner under the rules of the provider of the job: only a provider of the
org of the job, its key only to a trusted runner, and never a key held on the runners of the org
unless the runner holds that kind, and only with a job that carries the models of the config. Otherwise the job goes without it, and the log says why
(`job.fallback_provider_not_sent`). No migration.

**Protocol**: the feature `fallback-provider` (`models.fallbackProvider` in a job, `fellBack` in a
review or a resolution). **Order**: the service first. A runner of this release claims the feature, and a service of
an earlier release refuses a claim with a feature that it does not know.
