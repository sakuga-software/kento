---
"@kento-review/web": patch
---

pr: #50

**Fallback provider** (KNT-161): each level of Config and Settings gets an optional fallback
provider and its model, next to the fallback model. When the provider of the level refuses the call
on its usage limit, the runner calls the fallback provider once, and the review says which provider
answered. Its key goes to a runner under the rules of the provider of the job: only a provider of the
org of the job, its key only to a trusted runner, and never a key held on the runners of the org
unless the runner holds that kind. Otherwise the job goes without it, and the log says why
(`job.fallback_provider_not_sent`). No migration.

**Protocol**: the feature `fallback-provider` (`models.fallbackProvider` in a job, `fellBack` in a
review). **Order**: the service first. A runner of this release claims the feature, and a service of
an earlier release refuses a claim with a feature that it does not know.
