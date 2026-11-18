# Changelog of apps/web

What each release of the web service changed for the person who deploys it: its migration, its
variables, the permissions of the GitHub App, the order of the deployment, and the checks of its
ticket. The newest first. The installation as it is today is in [DEPLOY.md](DEPLOY.md): read the
entries since the deployed release before a deployment or a rollback.

The number of migrations that `/healthz` gives after a release is in its entry.

## REV-112: Weekly measures and bench cases from the findings

**Two scripts only; `web` needs no deployment.** The service does not run them. No migration
(`/healthz` still gives `"migrations":29`), no new variable, no new permission.

- `pnpm -F @sakuga-review/web measures` reads the findings of every org and gives, for each week
  (Monday, UTC), by repository, severity, category and decile of confidence: the handled rate
  `(fixed + applied) / closed`, the reject rate `dismissed / closed`, with Wilson intervals at
  95 %, and the findings for each pull request of a published review. The calibration over all the
  weeks shows the deciles where the reject rate goes up, and whether the threshold of 70 splits the
  reject rates. `closed` is `fixed + applied + dismissed + wontfix`; open and stale findings are
  out. `applied` is 0: no status records an applied suggestion.
- `pnpm -F @sakuga-review/web bench:cases <out.json>` writes cases of the bench (source `kento`):
  a finding dismissed with a reason is a known false positive, a fixed or wontfix finding is a
  case of non-regression. See eval/README.md.
- Both scripts read `DATABASE_URL` on a connection that Postgres keeps read-only
  (`default_transaction_read_only`), and never print the URL.

## REV-113: A prompt cache that the reviews read

**The runners carry the change; `web` needs no deployment.** No change to the protocol: the new
fields go to the logs of the runner only. No migration (`/healthz` still gives `"migrations":29`),
no new variable, no new permission. Deploy the runners in any order with `web`.

- **The answer schema is the same for every review of a level.** Anthropic puts the schema of
  `output_config.format` in the system prompt, and a change of the schema empties the prompt cache.
  The schema held the references of the rules (`R1`…), of the earlier findings (`E1`…) and of the
  answered threads (`T1`…) of each pack, so it changed from one review to the next. This explains
  why 83 % of the reviews read nothing from the cache: the code and the documentation of structured
  outputs say so, and `schemaHash` in the logs confirms it after the deployment. `rule_id`, `follows` and `threads` are now in
  every answer, as a free string or null, and the engine drops a reference that the pack does not
  hold, as before. `prompts/review.md` asks for `null` when its section is absent.
- **The system prompt carries a cache mark of 1 hour** (5 minutes before). 97 % of the reviews come
  less than 1 hour after the last review of the same model.
- **The docs (`CLAUDE.md`, `AGENTS.md`) open the pack, with a cache mark of 1 hour.** They are the
  same for every pull request of the repository: a review reads them from the cache when the
  repository had a review with the same model in the last hour. The rest of the pack keeps its
  order and has no mark: an incremental review (REV-88) builds its rules, imports and context from
  the files that changed since the last review, and they were the same as in the last review 3
  times in 49 on a replay of 13 pull requests.
- In a review in passes (bench only), the passes leave one after the other: the second and the
  third wait for the start of the answer of the first, then read the system prompt and the pack
  from the cache. The focus of a pass goes at the end of the user message, after the pack.
- The cost counts a cache write at 1.25 times the input with the TTL of 5 minutes and 2 times with
  1 hour. A cache read on Sonnet 5.5 costs 0.05 times the input ($0.10 a million tokens, not
  $0.20). The tier of Haiku 5.5 above 100,000 tokens reads each request alone, so a retry without
  thinking of REV-108 no longer adds two prompts into the tier.
- The runner logs in `job.model_usage`: `repo`, `pr`, `reviewLevel`, `incremental`, `promptTokens`,
  `cacheRead`, `cacheWrite5m`, `cacheWrite1h`, `systemHash` and `schemaHash` (12 characters of their
  SHA-256), `contextHash` (the same for the rules, the imports and the context of the pack),
  `effort`, `thinking` (`adaptive`, or `adaptive+disabled` after a retry of REV-108) and `costUsd`.
  Two reviews of one pull request with the same `contextHash` could have read that part from the
  cache: a week of logs tells whether a mark there pays. `eval/martian/run.ts` writes the
  writes by TTL in `tokens` and the rest in `stop`.
- The retry without thinking of REV-108 changes the thinking, which empties the cache of the
  messages: it cannot read the pack of the first request. It carries no mark on the pack.
- The reuse key (REV-89) reads the prompt: after the deployment, the review of an unchanged diff
  calls the model once more.

Checks after the deployment:

- In the logs of the runners (`{app="runner"} |= "job.model_usage"`), `systemHash` and `schemaHash`
  take one value at `lite` and one value at `balanced` and `heavy` (these two levels have the patch
  of REV-104), and `cacheRead` is above 5,000 on most reviews.
- One week after, compare with the week before. Expected: more than 80 % of the reviews with a hit
  (17 % at `balanced` before), about 5,000 tokens of system prompt read from the cache on every
  review, plus the docs on the repositories that have them, and a lower mean cost at `balanced`:

  ```sql
  select j.level, r.model,
         count(*) as reviews,
         round(100.0 * count(*) filter (where (r.result->>'cachedTokens')::int > 0) / count(*)) as hit_pct,
         round(avg((r.result->>'promptTokens')::int)) as prompt_avg,
         round(avg((r.result->>'cachedTokens')::int)) as cached_avg,
         round(avg(r.cost_usd), 4) as cost_avg
  from reviews r join jobs j on j.id = r.job_id
  where r.created_at >= :since and r.created_at < :since + interval '7 days'
    and r.model like 'claude-%' and r.cost_usd > 0 and r.result ? 'cachedTokens'
  group by 1, 2 order by 3 desc;
  ```

## REV-116: The model's verdict suggests `reject`, not keywords

No migration: `/healthz` still gives `"migrations":29`. No new variable, no new permission, no change
to the protocol of the runners.

**Deploy `web` alone.** The runners do not change. The review path reads `refutedThreads`, which the
runners send since REV-96 (feature `refuted`). The `resolve` path reads the verdict `answered`, which
every runner sends.

- The webhook no longer reads the words of a reply. A reply in the thread of a finding without a
  command gets `202 ignored` (`comment is not a command`), in any language. The pattern of
  `refutation.ts`, its 174 cases and the hint handler of the webhook are gone.
- The hint of `reject` comes from the model, in the language of the replies:
  - at a review, when the model calls a thread of its `Answered threads` section `refuted` (as
    before, REV-96);
  - at a `resolve` command, when the model calls the thread of a finding of Kentō `answered`. The
    resolve prompt has no verdict `refuted`. Its `answered` means "a reply shows that the report is
    wrong", or "a reply answers a question". A finding of Kentō asks no question, so on its thread
    `answered` means refuted. The hint is its own reply, posted before the reply of the verdict
    and before the resolve closes the thread. If GitHub refuses the hint, the thread stays open, so
    that a later resolve can post it, and the reply of the verdict says why.
- The rules do not change: one hint per finding (`findings.reject_hint_at`, claimed before the
  post, given back when GitHub refuses it), only for an open finding, only when a person who can
  write to the repository replied, and never when a reply names `reject`. A refuted finding still
  does not come back, and the score does not drop.
- The page `/docs/commands` describes the new trigger.

Checks after the deployment:

- On a test pull request, reply "c'est un faux positif, la fonction vérifie déjà le null" in the
  thread of a finding. The webhook answers `202 ignored`, and no hint comes.
- Push, or run `@kento-review resolve`: Kentō suggests `reject` in that thread, once. A second
  `resolve` posts no second hint.

## REV-115: No French left in the code

One migration (`0028_failure_reasons_straight_quotes`): `/healthz` gives `"migrations":29`. No new
variable, no new permission, no change to the protocol of the runners.

**Deploy `web` first, then the runners.** Each side works with the other at either release. The
runners carry the prompts and the pack; `web` carries the migration, the redirects and the label.

- The service no longer reads the French texts that REV-114 kept for the pull requests opened
  before it: the badge `sécurité` of an open thread with no row, a quote of the French request for
  feedback, the French reasons of the dismiss dialog, and the French starts of a reply that sets a
  finding aside (`Non appliqué`, `faux positif`, `voulu`…). Accepted consequence: a pull request
  opened before REV-114 and reviewed after this release can lose the security category of an old
  thread, and a quote of the old French request no longer counts as an answer. The hint of
  `reject` reads English replies only (`refutation.cases.ts` keeps the 174 English starts: precision
  100 %, recall 68.8 %).
- The reason of a failed job writes the label of the provider in straight quotes
  (`the provider "X" refused its key (401): …`). The migration rewrites the stored reasons in
  French quotation marks, and is idempotent. The previous container still serves while it runs: a
  reason that it writes in that window shows as unknown, with its text under "Technical details".
  Run the statement again to map it.
- The anchors of the settings are in English: `#cap`, `#defaults`, `#org-rules`, `#new-provider`
  (and `#new-runner` on the Runners screen). The check `Kentō · cap` links `/settings#cap`.
  `settings.js` sends an old anchor (`#plafond`, `#defauts`, `#regles`, `#nouveau-provider`) to
  the new one, so the check runs posted before the deployment still open the right section.
- The keys of a query are in English: `?status=`, `?before=`, `?after=`, `?rerun=` on the screen of
  a pull request, `?done=` and `?history=` on a finding and a user, `?view=precision` and
  `?type=to-consider` on Findings, `?author=` on Feedback. A GET with an old key (`statut`, `avant`,
  `suite`, `relance`, `fait`, `historique`, `vue`, `auteur`, or `type=a-considerer`) gets a `301` to
  the same URL with the new names. `/docs/commandes` still answers a `301` to `/docs/commands`.
- When Kentō sets a label `review: N/5` whose description is not `Kentō confidence score (5: ready to
  merge)`, it writes that description (`PATCH /repos/{repo}/labels/{name}`), after it sets the
  label. A description that a person wrote by hand on these labels is overwritten too.
- The prompts and the pack quote with straight quotes, and a long comment or diff ends with
  `[… cut here]` (was `[… coupé ici]`). The reuse key (REV-89) reads the prompt, so the first push
  of each pull request after the runners are updated calls the model again.
- On the dashboard at 390 px, the list of the last reviews starts the facts of each review on their
  own line again: the stylesheet read the French label `Niveau` of the cell since REV-114.
- The icons `*.v1.svg` with French names stay in `public/assets/pr`: the comments posted before
  REV-106 link them.

Check: `/settings#plafond` opens the section `#cap`; `/findings?vue=precision` opens
`/findings?view=precision`; after a review on a repository whose labels an earlier release created,
the label `review: N/5` reads `Kentō confidence score (5: ready to merge)` on GitHub.

## REV-114: Kentō writes in English

One migration (`0027_dismiss_reasons_in_english`): `/healthz` gives `"migrations":28`. No new
variable, no new permission, no change to the protocol of the runners.

**Deploy `web` first, then the runners.** `web` posts every text of Kentō on GitHub and reads the
old French texts too. The prompts are in the runner image (`packages/engine/prompts`, copied by
`apps/runner/Dockerfile`): until a runner is updated, the text that its model writes (the title,
the scenario and the fix of a finding, the summary, the replies of `resolve`) stays in French
inside the English frame. A runner of either release works with the new `web`.

- Everything that Kentō posts is in English: the review body, the block of the description
  (`Confidence score`, `Findings`, `To consider (code already reviewed)`, `Summary`, `Diagram`,
  `Not reviewed`, the line of the commands), the comment of a finding (`**Fix:**`, `Rule:`), the
  comment on a file outside the diff, the reply to a variant, the replies of `resolve` and `reject`,
  the hint of `reject`, the errors of a command, the note of the queue, the comment of a failed job,
  the request for feedback, the check (title and summary), the assignment and force-push notes and
  the label description. Amounts read `$0.012`, and the cost of a level `about 1 cent`,
  `10 to 20 cents`.
- The cap check is now `Kentō · cap` (was `Kentō · plafond`). It never blocks a merge, and nothing
  requires it by name.
- The prompts `review.md` and `resolve.md` ask for plain English, even when the code or a thread is
  in another language, with the same rules of style in English (one idea per sentence, active
  voice, no em or en dash, no colon between two clauses, a list of banned filler words, no closing
  formula). The reuse key (REV-89) reads the prompt, so the first push of each pull request after
  the runners are updated calls the model again. The texts of the pack and of `not_reviewed`
  (`path: generated or binary file`…) are in English too.
- The screens of review.sakuga.dev are in English (`<html lang="en">`), with English formats at the
  hour of Paris: `$12.50`, `27 Oct 2026, 18:02`, `5 min ago`. A money field shows `12.50` and still
  accepts `12,50`.
- The page of the commands moves to `/docs/commands`. `/docs/commandes` answers a `301` to it, so
  the links in the comments posted before the deployment keep working.
- The reasons of the dismiss dialog are `False positive`, `Off topic`, `Already known` and
  `Style, not a defect`, and a 👎 gives `no reason, GitHub reaction`. The migration changes the
  stored French values of these five reasons (`findings.status_reason`, `finding_events.reason`):
  the Precision screen counts each reason once. A reason that a person typed does not change. A form
  opened before the deployment still posts a French reason: the service stores its English value.
  The previous container still serves while the migration runs: a dismissal in that window can store
  a French reason. The statements of the migration are idempotent; run them again to map it.

What the service still reads in French, for the pull requests opened before the deployment:

- The HTML markers (`<!-- sakuga-review:… -->`, `<!-- kento:… -->`) do not change. Every lookup of
  a posted comment, review, reply or block uses them, and none reads the visible text.
- An open thread of an earlier release that has no row: its security badge `sécurité` (an image
  `alt` or the text badge) still gives the category `security`.
- A quote of the French request for feedback (« Kentō a relu cette PR », « Ton avis sur ces
  reviews ») still counts as an answer.
- The commands and their keywords do not change.

Known limit: the key and the fingerprint of a finding hash its title. An English finding on a
defect that a French thread already carries is matched by `follows` (REV-99) or by the open thread
a few lines away on the same file, so it gets no second thread. A French finding that is fixed or
dismissed and has no open thread is matched only by `follows`. The rejected findings and the
earlier findings that the pack sends to the model keep their French titles; the model reads them
as they are.

Check: on a test pull request after the deployment, the review, the threads, the block, the check
and a `reject` are in English. On a pull request opened before it, a push gives no duplicate thread,
and `/docs/commandes` opens `/docs/commands`.

## REV-106, follow-up: the gauge of the score is a bar of five segments; the icons have English names

No migration, no new variable, no new permission, no change to the protocol of the runners: deploy
`web` alone. `/healthz` still gives `"migrations":27`.

- The gauge next to the score was five bars of growing height, like a network signal. It is now a
  progress bar of five rectangles of the same height (10 × 14 px), filled up to the score. Its colour
  does not change: red up to 2, amber at 3, green from 4. The gauge sits next to the `h2` of the block
  (21 px text, 26 px line): its image is 60 × 26 and the `<img>` has `height="26"`; the other icons
  keep 20.
- The icons go to version 2 (`ICON_VERSION`, `VERSION` of `scripts/pr-icons.py`), with English names:
  `security`, `to-check`, `to-consider`, `blocking`, `warning`, `thread`, `resolved`, `to-resolve`,
  `stays-open` and `gauge-1` to `gauge-5` (`p0`, `p1`, `p2` and `ok` keep theirs). The text drawn in
  the badges and the `alt` of each image are in English (`security`, `to check`, `to consider`,
  `Blocking`…). The rest of the texts of a review does not change in this entry.
- The files of version 1 stay in `public/assets/pr`: the comments already posted still link them.

Check: after the next review of a pull request, the title of the block shows the bar of five
segments, and the badges read in English, in the light and the dark theme of GitHub.

## REV-108: A Haiku answer cut at `max_tokens`, or late, gets one request without thinking

**The runners carry the change; deploy them in any order with `web`.** No change to the protocol:
the new fields go to the logs of the runner only. No migration (`/healthz` still gives
`"migrations":27`), no new variable, no new permission. `web` needs no deployment for this entry.

- The engine streams the Messages API of Anthropic (`stream: true`). OpenRouter, a server of the
  OpenAI API and Ollama do not change, and still do not stream.
- At Anthropic, with Claude Haiku 5.5, two cases get one more request to the same model with
  `thinking: {type: "disabled"}`, at the same effort, in the time left to the call:
  - the answer stopped at `max_tokens`. On the bench, the cut requests had 1,700 to 7,800 thinking
    tokens: the answer text took the rest of the 32,000, and not the thinking as REV-108 supposed.
    The second request gave an answer 5 times in 7;
  - the model thought for `MAX_THINKING_MS` (60 s, about 14,000 tokens) with no answer block, or
    until 60 s before the time limit (`RETRY_ROOM_MS`, 120 s of the 180 s at `lite`). The call
    stops the first request. The clock starts at the first thinking block: on the bench, the API
    held some requests 50 to 99 s before it, and stopping them would only queue the second request.

  Sonnet 5.5 and Opus 5.5 refuse `disabled` (400): they get no second request, as before. The second
  request puts no cache mark on the pack. Of a stopped request, only the input tokens and the first
  output token count in the cost: the API gives the rest at the end of the stream only.
- The runner logs `job.model_usage` after each review at Anthropic: `stopReason`, `thinkingTokens`,
  `firstTokenMs` (the first content block), `firstTextMs` (the first text of the answer) and
  `retriedWithoutThinking` (`max_tokens`, `no_answer_in_time` or null). The Action adds `stop=`,
  `thinking=`, `first_text_ms=` and `retried=` to its log line. `eval/martian/run.ts` writes them in
  `stop` on each row.
- `prompts/review.md`: a suggestion holds 10 lines at most, and a diff of fewer than 50 changed
  lines gets no diagram. Two answers of the bench passed 25 kB of JSON. The reuse key (REV-89)
  reads the prompt, so after the deployment the review of an unchanged diff calls the model once
  more.
- The error of an answer that does not parse now gives the length of its text, for example
  `(stop_reason max_tokens, 32000 output tokens, 1600 characters of text)`.
- An error of the model that the stream sends (`overloaded_error`) fails the attempt with
  `Anthropic stopped the stream: …`, and the next model of the level takes over. The screen of the
  jobs shows it as an error that Kentō does not know.

Check: in the logs of a runner (the lines `job.model_usage`), a review at `lite`
with an Anthropic provider gives a `stopReason`. Over a day, `retriedWithoutThinking` is not null on
a few percent of them, and the failures `stop_reason max_tokens` of the jobs go away.

## REV-107, follow-up: no request on a pull request reviewed three times before the deployment

Migration `0026_feedback_skipped`: one column, `feedback_requests.skipped` (a default, no rewrite of
the table), then one skipped row for each pull request that has 3 published reviews and no request
yet. `/healthz` gives `"migrations":27`. No new variable, no new permission: deploy `web` alone.

- The first release asked every pull request that had 3 or more published reviews at its next
  review: a wave of requests at the deployment. Now a pull request whose third published review
  came before this migration is never asked. The rule is the state of the database when the
  migration runs, not a date: a skipped row takes the place of the request, so `on conflict do
  nothing` of the claim never posts. A pull request already asked since the first release keeps its
  row and its answers.
- A pull request with 2 reviews at the migration is asked at its third. A request that GitHub
  refuses still gives its row back (a skipped row never goes), and the next review asks with its
  real count (« 4 fois »). During the deployment, the container of the earlier release can publish a
  review after the migration: such a pull request is asked at its next review, once.
- A skipped row has no comment: a quote and the reactions of that pull request are not read.

Check: after the deploy, `select count(*) from feedback_requests where skipped` gives the open and
closed pull requests that had 3 reviews; on such a pull request, a new review posts no request; on a
pull request with 2 reviews, the third posts one.

## REV-104: More code suggestions on the P0 and P1 findings, and a diff when a suggestion cannot apply

**The protocol of the runners changes: deploy `web` first, then the runners.** A runner of this
release claims the feature `patch`; a web service of an earlier release refuses a claim with a
feature that it does not know. No migration: the patch is in `reviews.result`, as the suggestion.
`/healthz` gives the count of the release before it (`"migrations":26` after REV-107). No new
variable, no new permission.

- `prompts/review.md` does not change. A prompt that asked for a suggestion on each P0 and P1,
  with a free `patch`, cut the recall of Haiku at `lite` on the bench, and a lighter version found no
  more suggestions than the prompt of `main`. 4 % of the P1 of the last 30 days had a suggestion.
- A suggestion can start on a context line of the hunk on GitHub (3 lines around a change), not only
  on a changed line. The engine reads the hunks with `git diff -U3`, as GitHub shows them. Its last
  line stays a changed line, the line of the thread, and the limit of 30 lines stays.
- At `balanced` and `heavy`, a finding whose fix does not fit a suggestion (several places, lines
  outside the hunks) can carry a `patch`: a short unified diff (`prompts/patch.md`). At `lite`, the
  prompt and the answer schema hold no `patch`. The thread shows the patch under « Correction » in a
  `diff` block. A finding with no thread shows it in the description, in a `<details>`. A patch of
  more than 40 lines, or one that holds a code fence, is not shown. An applicable suggestion wins:
  the runner then sends no patch.
- The `delta` of a job (REV-88) carries the patch of each finding only to a runner that claims
  `patch`. A runner of an earlier release reads the findings of `delta` strictly, and would refuse
  the key. A runner that goes back to an earlier release after this deployment therefore gets no
  patch, and nothing fails.
- A service of an earlier release never receives `patch`: it refuses the claim. Roll back the
  runners before the service.
- The reuse key (REV-89) now reads `prompts/patch.md` too, so it changes: after the deployment, the
  review of an unchanged diff calls the model once more instead of reusing the earlier review.
- An answer of Anthropic that is not valid JSON gives its `stop_reason` and its output tokens in the
  error, for example `(stop_reason max_tokens, 32000 output tokens)`.

Check: a job claimed by a runner of this release has `patch` in the features of its claim. On a test
pull request, a P1 whose fix covers a changed line and the context line above it gets a thread with
the button « Commit suggestion », and its commit gives the expected code. A P1 whose fix touches two
functions gets a thread with a `diff` block under « Correction », and no suggestion, at `balanced`.

## REV-107: After three reviews, Kentō asks the author for feedback, once per pull request

Migration `0025_feedback`: two new tables, `feedback_requests` and `feedback` (no change to an
existing table). `/healthz` gives `"migrations":26`. No new variable, no new permission (the App
already writes the comments of the conversation and reads their reactions with `issues` and
`pull_requests`), no change to the protocol of the runners: deploy `web` alone. The Action
(`@sakuga-review`) does not change.

- After a review is on GitHub, when the pull request has 3 or more published reviews
  (`reviews.github_review_id` set) and no request yet, the publisher posts one comment in the
  conversation that mentions the author of the pull request only, a bot too:
  « @auteur Kentō a relu cette PR 3 fois. Ton avis sur ces reviews nous aide à l'améliorer… ». The
  row of `feedback_requests` (one per pull request) is written before the comment: two publications
  or two tries never post it twice. A comment that GitHub refuses gives the row back, and the next
  review asks. Nothing on a closed pull request. A pull request that already had more than 3 reviews
  before the deployment is asked at its next review, with its real count.
- The answers go to `feedback`, unique by the id of the comment or of the reaction on GitHub:
  - `@kento-review feedback <avis>` (the lines under the command count too): no job, no cost, ❤️ on
    the comment. Without a text: 😕 and the form of the command. Any person can give it, a trusted
    bot, or the bot that opened the pull request; also in a review thread, and on a closed pull
    request. Before this release, `feedback` got the list of the commands as an unknown command.
  - A comment of the conversation that quotes the request (`> …`) with a text of its own, on a pull
    request where Kentō asked: the text out of the quote, with ❤️ too.
  - 👍 and 👎 on the request: GitHub sends no event for a reaction, so the service reads them at
    `pull_request.closed` and at each new answer. A 👍 removed later stays.
- « Retours » (`/feedback`, in the navigation after Findings): the answers of the org, the newest
  first (200 at most), with the repository, the pull request, the author, person or agent, the source
  and the score of the last published review of the pull request. Filters: repository, source,
  person or agent. Every member of the org reads it.
- `feedback` is in `/docs/commandes`, in the list of the commands of a refused command, and in the
  line of the commands at the end of the block of the description.

Check: on a test pull request, after the second review, no request; after the third, one comment
that mentions the author; after a fourth review and after `@kento-review heavy force`, no second
request. `@kento-review feedback ça a trouvé le bug` gets ❤️, queues no job, and shows on
« Retours ». A reply that quotes the request shows there too. A 👍 on the request shows after the
close of the pull request.

## REV-106: Kentō's icons replace the emojis and the shields.io badges on a pull request

No migration, no new variable, no new permission, no change to the protocol of the runners: deploy
`web` alone, after REV-103. `/healthz` still gives `"migrations":25`.

- The service serves 36 SVG files under `/assets/pr/` (`p1.v1.svg`, `p1-dark.v1.svg`…), with
  `Content-Type: image/svg+xml` and, in production, `Cache-Control: public, max-age=31536000,
  immutable`. The version is in the name: GitHub's image proxy (camo) keeps an image in its cache.
  `apps/web/scripts/pr-icons.py` writes them again from the tokens of `kento.css`; a change of an
  icon increases `VERSION` there and `ICON_VERSION` in `packages/engine/src/render.ts`.
- The texts that Kentō posts (review, comments, file comments, variant replies, the block of the
  description, the summary of `resolve`) show these icons in a `<picture>`, light and dark, from the
  origin of `KENTO_PUBLIC_URL`. Every image has an alt text that gives its meaning (`P1`,
  `Bloquant`, `À vérifier`). Without `KENTO_PUBLIC_URL`, the texts give the alt texts and no image.
  No text of the service holds an emoji now; the reactions (👀 🚀 😕 👎) do not change.
- The head of the review: `N points bloquants` when a finding blocks; else `N points à vérifier`
  (warning icon) when a P0 or P1 has a thread and does not block; else `Rien de bloquant`, also with
  P2 findings only (it showed ⚠️ before). The warning icon also marks the advice of a deeper review
  and the note of a force-push, which is no longer a GitHub `[!NOTE]`.
- The title of the block keeps `Score de confiance : N/5` as text, and adds a gauge after it.
- The markers that the next review reads (`sakuga-review:finding`, `summary`, `count`, `kento:variant`,
  the short id) do not change. The Action (`review/sakuga-review.ts`) keeps its emojis: it has no host
  for the files.

Check: after the deploy, `curl -sI https://review.sakuga.dev/assets/pr/p1.v1.svg` gives 200,
`image/svg+xml` and `immutable`. On a test pull request with a P1 that blocks, a P1 of confidence 60
and a P2, the icons show in the light and the dark theme of github.com and of the mobile app, and the
head says « 1 point bloquant »; without the P1 that blocks, « 1 point à vérifier » with the warning;
with the P2 alone, « Rien de bloquant » with the OK icon.

## REV-103: Every P0 and P1 opens a conversation on GitHub

No migration, no new variable, no new permission (the App writes the review comments already), no
change to the protocol of the runners: deploy `web` alone. `/healthz` still gives `"migrations":25`.
A review opens more threads than before; its verdict, its score and the rule that blocks do not
change (`isBlocking`: a P0 or P1 of 70 or more, on a changed line, and not to consider).

- A P0 or P1 on a changed line gets a thread, whatever its confidence. Below 70, its comment has the
  mark « à vérifier » next to the priority, and it does not block: no REQUEST_CHANGES for it.
  `@kento-review reject <cause>` sets it aside, as any finding.
- A P0 or P1 outside the diff gets a comment at the level of its file (`subject_type: "file"`), posted
  after the review, because GitHub takes no such comment in a review. Its first line links the lines
  of the finding at the reviewed commit. The database keeps it as a line thread
  (`findings.github_comment_id`): a push that fixes the finding resolves it, a variant (REV-99) and
  `reject` answer in it. A retry does not post it twice: the comment of the earlier try carries the
  finding by its key. GitHub refuses a comment on a file that the pull request does not change: the
  finding then stays in the list of the block only (log `publish.file_comment_refused`).
- MAX_INLINE (5) counts the P2 findings only after the P0 and P1: a P2 still gets a thread only from
  70, and only while the review has fewer than 5 inline comments.
- A P1 to consider (REV-100) gets a thread with the mark « à considérer », which does not block, when
  both are true:
  1. the published score is below 4;
  2. no other P0 or P1 of the review is new, that is: not to consider and not carried by an open thread.

  Otherwise it stays in the list « À considérer » of the block only, as before.
- The Action (`review/sakuga-review.ts`) gives a thread to every P0 and P1 on a changed line too. It
  posts no comment on a file, and it has no finding to consider: it never sends `reviewed`.

Check: on a test pull request, a review with a P1 of confidence 60 on a changed line gets a thread
with « à vérifier » and a review COMMENTED; a P1 outside the diff gets a comment on its file whose
link opens its line, and a push that fixes it resolves that thread; a P1 to consider with a published
score of 3 gets a thread « à considérer », and with a score of 4 none.

## REV-105: The block of the description lists the commands of Kentō

No migration, no new variable, no new permission, no change to the protocol of the runners: deploy
`web` alone. `/healthz` still gives `"migrations":25`.

- The block of the review at the end of the description of the pull request ends with one `<sub>`
  line: `Commandes de Kentō : @kento-review [lite|balanced|heavy] · @kento-review resolve ·
  @kento-review reject <cause> (dans un fil) ou reject #<id> <cause> · Les commandes de Kentō`, the
  last part a link to `/docs/commandes`. The line says what exists, not when to use it: an agent that
  reads the pull request learns the commands. Each review writes its block in place of the earlier
  one, so the line stays unique. As for the footer of the comment of a finding, the line comes only
  under `KENTO_PUBLIC_URL`: without that variable, no line. The Action (`@sakuga-review`) has no page
  of its commands and shows no line. The body of the review and the footer of the threads do not
  change.
- `/docs/commandes` gives the cost of each command (`review` and `force` at the price of their level,
  `resolve` at the price of the tokens that it reads, `reject` free), and says that a command written
  by an agent has the same effect and the same cost as one written by a person.

Check: on a test pull request, after a review, the line of the commands ends the block of the
description, with the link to the page of the commands; after a second review, the description has
the line once.

## REV-96: Kentō suggests `reject` on a reply that sets a finding aside; the page of the commands

**Deploy `web` first, then the runners.** A runner of this release claims the feature `refuted`; a
web service of an earlier release refuses a claim with a feature that it does not know. Migration
`0024_finding_reject_hint`: one nullable column, `findings.reject_hint_at` (no rewrite of the table).
`/healthz` gives `"migrations":25`. No new variable, no new permission: the App already receives
`pull_request_review_comment` since REV-93.

- A reply in the thread of an open finding whose start sets it aside in words (« Not applied »,
  « Non retenu », « Risque accepté », « Kept as is »…) gets one reply of Kentō with the command
  `@kento-review reject <cause>` and a link to the page of the commands. The pattern reads the start
  of the reply only, with no call to a model (`app/commands/hint.ts`: precision 98.9 %, recall
  82.5 % on 1,051 replies of the org labelled by hand). No hint in a resolved thread, for a finding
  that is no longer open, on a reply that names `reject` already, or on a reply of a person who cannot
  write to the repository or of an untrusted bot. One hint per finding: `findings.reject_hint_at` is
  claimed before the post, so two deliveries, or a delivery and a review, never both post it; a post
  that GitHub refuses gives the claim back. The hint changes no status, and the thread still carries
  its finding (its hidden marker `<!-- kento:reject-hint -->` is no last word of the bot).
- At the next review, a thread that the model calls refuted (REV-71) gets the same hint when it has
  none: the runner sends `refutedThreads`, the ids of these threads.
- `/docs/commandes`: a public page, without a sign-in, that describes `review`, `force`, `resolve` and
  `reject`. The list of the commands of a refused command, the hint, and the footer of the comment of
  each finding link to it, under `KENTO_PUBLIC_URL`. Without that variable, no link.

Check: on a test pull request, the reply « Not applied: the value is validated by the schema » in the
thread of a finding gets the hint once, even after a second reply of the same kind; « Applied in
abc123 » gets nothing; the link of the hint opens `/docs/commandes` in a private window.

## REV-101: A head that no reviewed file changed gets its own review

No migration, no new variable, no new permission, no change to the protocol of the runners: deploy
`web` alone. Since REV-89, a push that changes no reviewed file (a merge of `main`, a rebase of
GitHub after the squash of the pull request below) calls no model, and the service publishes the
last review again: the block, the label and the check. The head had no review of its own, so a
merge policy that reads the score on the head (boo, `merge-when-green.sh`) stayed blocked.

- The publisher now also posts a review on the head: the score and the verdict of the block
  (APPROVE, COMMENT or REQUEST_CHANGES), no inline comment, and the line « Même score que le commit
  `<sha>` : aucun fichier relu n'a changé depuis. ». A hidden marker names its source: the copy does
  not replace the source, so the next unchanged push is published again too. A second try finds the
  review by its marker and posts nothing. `reviews.result.headReviewId` keeps its id.
- A command `@kento-review <level>` on such a head is no longer refused when the copy was published
  without a review on the head (a release before this one, or a copy that a later review replaced):
  the head has no score, and the command is its only way to get one.
- `@kento-review reject` on such a head dismisses the copy, and its source when the source asks for
  changes too.

Check: on a pull request whose last review is on GitHub, merge `main` with no change to its files:
the new head gets a review of `kento-review[bot]` with the same score, and the line above.

## REV-95, follow-up: a more severe finding near a rejection stays; unchanged files first

**The protocol of the runners changes: deploy `web` first, then the runners.** A runner of this
release says `rejected-severity` in the features of its claim, and an earlier service refuses it. The
service then adds the `severity` of each rejected finding; a runner of REV-95 does not say it, reads
`rejected` strictly, and gets no `severity`. No migration, no new variable, no new permission.

- Near a rejection (at most 3 lines, same category, a word in common), a finding **more severe**
  than the rejected one stays: it is another defect, not the rejected one reworded. Without the
  severity (a service of REV-95), the engine does not compare the severities, as before.
- In the « Rejected findings » section, the rejections whose file did not change come first: the
  rejections of a changed file use the rest of the 12 000 bytes.

Check: a review job of a runner of this release gives `severity` in each item of `rejected`.
## REV-88: The review of a push reads only what changed since the last reviewed head

No migration, no new variable, no new permission. A runner of this release says `delta` in the
features of its claim. When the service sends `reuse` (REV-89) and the last review on GitHub is of
the level of the job, it adds `delta`: the score of that review, its findings still open (not
fixed, dismissed or kept in the findings of the pull request), and the settled findings of the pull
request (at most 200).

When that head is in the history of the new head, the pack holds only the files of the pull
request that changed since then, with a section that lists the earlier findings and the settled
ones. The findings of the files that did not change come back as they were; a finding that a
person dismissed or kept, raised again, is dropped; with no new finding, the score is at least the
score of the last review. A force-push or a rebase takes that head out of the history: the review
reads the whole pull request, as before. A merge of `main` that changes no file of the pull request
calls no model and publishes the last review again (`unchanged`, REV-89). The review says
`delta: { since, files }`, and the block of the description says « Review incrémentale ».

Measured without a model, on the eval cases (the head of the case as the last reviewed head, the
later head of the same pull request as the push): the pack of the push is 25 % (plai574), 39 %
(plai565) and 32 % (plai549) smaller in input tokens, prompt included.

Deploy `web` before the runners: a runner of this release sends the feature `delta`, and an
earlier service refuses it. A runner of REV-89 gets no `delta` and reviews the whole pull request.

Check: on a pull request with a review, a push that changes one file gives `job.review_incremental`
with `files: 1` in the log of the runner, and « Review incrémentale » in the block.

## REV-95: The next review reads the rejected findings and their cause

**The protocol of the runners changes: deploy `web` first, then the runners.** A runner of this
release says `rejected` in the features of its claim, and an earlier service refuses that feature.
A runner of an earlier release does not say `rejected` and gets its review jobs as before. No
migration, no new variable, no new permission.

For a review job of a runner that says `rejected`, the service sends the findings of the pull
request that a person set aside: `dismissed` (the command `reject`, the Findings screen, a 👎) and
`wontfix`, the most recently changed first, 50 at most. Each one gives its file, line, title,
category, status, cause and the head of the last review that reported it. A failed read logs
`job.rejected_failed` and the review runs without them.

The engine puts them in a « Rejected findings » section of the pack, after the answered threads
(REV-71), 12 000 bytes at most. The cause is data, on one line, never an instruction. Each entry
says whether its file changed since. The prompt says: do not report a rejected defect again, at its
line or near it, unless the file changed and gives a new fact; a rejected defect does not lower
`confidence_score`. A deterministic net removes a finding of the same file and category with the same title, or
at most 3 lines from a rejection with the same category and a word of the subject in both titles,
when the file did not change: before the score, so that the
defect does not lower it. The bench case is in `eval/rejected/`.

Check: on a pull request, reject a blocking finding, then `@kento-review force` without a change of
the file. `job.claimed` gives `rejectedFindings`, the new review does not report the defect (the
runner may log `job.finding_dropped_as_rejected`), and its score is not lower than without it. After
a push that changes the file, the defect can come back.

## REV-94: `reject` sets the finding aside, resolves its thread, and lifts the CHANGES_REQUESTED

Migration `0023_finding_event_source`, one `ALTER TABLE "finding_events" ADD COLUMN "source" text`
(nullable, no rewrite of the table). `/healthz` gives `"migrations":24`. No new variable, no new
permission: the resolve of a thread uses the token `contents: write` that a resolve job already asks
for (REV-71), and the dismissal of a review uses `pull_requests: write`. No change of the protocol
of the runners: deploy `web` alone. Deploy it with REV-93 (the subscription to `Pull request review
comment` of REV-93 comes first).

A `reject` that names a finding now has its effect at once, without a new review:

- The finding becomes `dismissed`, with the cause as its reason and the login of the person. A
  `wontfix` finding becomes `dismissed` too (a false positive is more than « accepted as is »); its
  events keep both decisions. Its
  event has `source = 'command'`. The screens show it as a dismissal of REV-18, and the precision
  counts it as a false positive.
- The thread of the finding gets the reply `replyText` and is resolved. Without `contents: write`,
  the reply says that a person can resolve it. A command of the conversation also gets a reply under
  the pull request.
- When the last review of Kentō on the head is `CHANGES_REQUESTED` and no finding that the engine
  marked blocking in it stays open (`blocking` in `reviews.result`, matched to the findings by their
  key), Kentō dismisses that review with a message that names the finding and the person. A review
  that Kentō did not store is left as it is; a review kept is logged `command.reject_review_kept`.
- The confidence score of the review does not change: the next review computes it again.
- 👀 on receipt, 🚀 after the effect, 😕 when a step on GitHub failed (the finding stays dismissed;
  the log `command.reject_<step>_failed` names the step). GitHub never sends a delivery again by
  itself, whatever its status: after a 😕, the person writes the same `reject` again (or redelivers
  the webhook from the settings of the App), and Kentō does the missing steps then (the reply by its
  marker, the resolve of the thread, the dismissal of the review), without a second reply. When a
  redelivery of the same comment succeeds, the handler tries to take its 😕 back before 🚀, and a
  redelivery that fails takes its 🚀 back before 😕. One
  case gets no retry: a push that fixed the finding in between makes the reject refused; the next
  review then dismisses the old `CHANGES_REQUESTED` by itself (`publish.ts`). A redelivery, or a second `reject` of the
  same finding, posts only a reply that is missing: each reply carries the hidden marker
  `<!-- kento:reject <finding id> -->`, and a reply that failed the first time goes then, once. A finding `fixed` or `stale` refuses the command with 😕.

Check: on a pull request whose review has one blocking finding, `@kento-review reject <cause>` in its
thread. The thread is resolved, the reply quotes the cause, the review `CHANGES_REQUESTED` is
dismissed, and the log `command.rejected` gives `dismissedReview`. The finding is `dismissed` with
the cause on the Findings screen.

## REV-89: No new review of a push that changes no reviewed file

No migration, no new variable, no new permission. A runner of this release says `reuse` in the
features of its claim. For a review job of a push (not a command, a « Relancer » or a retry), the
service then sends `reuse`: the head and the reuse key of the last review of the pull request on
GitHub, or null. The runner builds the pack, and when its key is the same (the pack after its list
of commits, the level, the provider, the models and the prompt: a merge of `main` or a rebase with
no conflict), it calls no model and sends the outcome `unchanged`. The service stores a copy of the
earlier review at no cost, and the publisher writes only the block of the description (with a note
that names the earlier commit), the label and the check « Sakuga Review » of the new head. No new
review, comment or reply on GitHub, and the findings of the database do not change. When the
earlier review is no longer the last one on GitHub at the result, the job goes back to the queue
(it fails after its last attempt); when a person dismissed it, the copy is posted as a review of
its own. A new reply in
a thread, a changed rule, another model or a changed reviewed file gives a new key and a new
review.

Each review of such a runner also carries `diffHash` (the hash of the paths and blobs of the
reviewed files of `base...head`), `reuseKey` and `cachedTokens` (the tokens of the prompt that the
provider read from its cache). The logs `job.result` of the service and `job.finished` of the
runner give `diffHash`, `cachedTokens` and `promptTokens`.

Deploy `web` before the runners: a runner of this release sends the feature `reuse` in its claim,
and an earlier service refuses it. A runner of an earlier release does not say `reuse`, gets no
`reuse`, sends none of the new keys, and reviews every push as before.

Check: on a pull request with a review, a merge of `main` that touches no file of the pull request
gives `job.review_unchanged` in the log of the runner, `review.republished` in the log of the
service, a block that says « Aucun fichier relu n'a changé depuis le commit … », and a check on the
new head. The cost of that review on the screens is 0.

## REV-93: The command `reject`, read in a thread and in the conversation

**Before the deployment, in the settings of the GitHub App `kento-review`: subscribe to the event
`Pull request review comment`** (General > Permissions & events > Subscribe to events). Without it,
GitHub sends no reply of a thread, and `reject` works only in the conversation. No new permission:
the reactions and the replies on a review comment use `pull_requests: write`, which the commands
already have. No migration, no new variable. No change of the protocol of the runners: deploy `web`
alone.

- `@kento-review reject <cause>`, in reply in the thread of a finding, names the finding of that
  thread. `@kento-review reject #<id> <cause>` in the conversation names the finding of the pull
  request whose key starts with the id (6 to 12 characters; `#` can be left out when the id has a
  digit). The cause is the rest of the line, at most 500 characters (`REASON_MAX`).
- Each comment of a finding, and each line of the list of the description, shows the short id of
  the finding, `` `#3cf454` ``.
- The command gets 👀 when it names a finding. It gets 😕 and a short reply (in the thread, or
  under the pull request) for: no cause, a cause too long, an id in a thread, no id in the
  conversation, an unknown id, an id of several findings, a thread that is not the thread of a
  finding, another command in a thread. A person who cannot write to the repository gets no answer
  (`command.not_allowed` in the log).
- This release reads the command only: the finding stays `open`. REV-94 sets it aside.

Check: in the thread of a finding, `@kento-review reject faux positif, la valeur est validée par le
schéma` gets 👀 and the log `command.reject_accepted` with the id of the finding. In the
conversation, `@kento-review reject #<id> …` with the id of a finding of the list gets 👀.
`@kento-review reject` with no cause gets 😕 and the list of the commands.

## REV-72: A command on its own line, anywhere in the comment

A line of a new comment that starts with `@kento-review` or `@sakuga-review` is a command, even
after other text: a reply that ends with `@kento-review heavy` queues a heavy review. Before, only a
comment that started with the name gave a command, and the rest were ignored without a word. A line
in a block of code (a fence, or four spaces) or in a quote gives no command. A command line of the
wrong form gets 😕 and the list of the commands, as at the start of a comment. No migration, no
new variable, no new permission.

Check: a comment `Fixed.` then `@kento-review` on the next line gets 👀, then a review.

## REV-71: A review reads the replies in the open threads of Kentō

No migration, no new variable, no new permission. A runner of this release says `threads` in the
features of its claim. For a review job, the service then reads the open threads of the pull
request with the token `pull_requests: read` that a resolve job already uses, and sends the threads
of a finding of the bot in which someone else replied, cleaned as for a resolve job (at most 20).
The review reads them as data: the model gives a verdict on each, and a finding near a thread that
it calls refuted goes away when the file did not change since the thread. A failed read of the
threads logs `job.threads_failed` and the review runs without them.

Deploy `web` before the runners: a runner of this release sends the feature `threads` in its
claim, and an earlier service refuses it. A runner of an earlier release does not say `threads`
and gets its review jobs without threads, as before.

Check: on a pull request with a thread of Kentō that a person answered, the log `job.claimed` of
the next review gives `answeredThreads`, and a finding refuted on an unchanged file gives
`job.finding_refuted_in_thread` in the log of the runner.

## REV-65: One index by runner less on the jobs

Migration `0022_drop_jobs_runner_id_idx`, one `DROP INDEX "jobs_runner_id_idx"`: the index on
`jobs (runner_id)`. `jobs_runner_finished_idx` of `0020_jobs_runner_finished` (REV-54) starts with
`runner_id` and serves its reads: the jobs of the last 24 hours on the Runners screen, and the
`on delete set null` of `jobs.runner_id` when a runner row is deleted. Each write to `jobs` updates
one index less. `/healthz` gives `"migrations":23`. No new variable, no new permission.

Deploy it after REV-54: the migrations apply in their order, so a database that is still before
`0020` gets `0020` then `0022` at the same start. `DROP INDEX` takes an ACCESS EXCLUSIVE lock on
`jobs` in the transaction of the migrations: 3 ms on 200 000 jobs, but it waits for each
transaction that uses `jobs`, and each query on `jobs` waits behind it. Deploy when no long query
runs on `jobs` (the hourly purge says `jobs.purged`). A rollback keeps the drop: the previous
release reads the same rows by `jobs_runner_finished_idx`. To get the index back, by hand:
`create index concurrently "jobs_runner_id_idx" on jobs (runner_id);`.

Check: `/healthz` gives `"migrations":23`, and
`select indexname from pg_indexes where tablename = 'jobs' and indexname like 'jobs_runner%'` gives
`jobs_runner_finished_idx` only.

## REV-66: Providers et clés refuses a model id of the wrong form

No migration, no new variable, no new permission.

The form « Ajouter un provider » applies the rule of the forms of the levels (#66): a model id that
the kind answers 404 to (`anthropic/claude-opus-5.5` on Anthropic, `claude-sonnet-5-5` on
OpenRouter) is refused with what the kind expects, and nothing is kept. Check: add an Anthropic
provider with `anthropic/claude-opus-5.5` for heavy; the form refuses it.

## REV-59: Hide a failure on the dashboard, none for a closed pull request

Migration `0021_failure_dismissal`, additive only: the table `pull_closures` (the last close of each
pull request) and two nullable columns of `jobs`, `failure_dismissed_at` and `failure_dismissed_by`.
`/healthz` gives `"migrations":22`. No new variable, no new permission: the close comes in the
`pull_request` event that the App already receives.

An admin hides a failure with « Masquer », on the banner or in « Échecs récents »: it leaves both for
every member, and « Échecs sur 7 jours » still counts it. A failure of a pull request closed since,
merged or not, shows nowhere; a reopen shows it again (a reopen as a draft does not: GitHub's
event of a draft creates nothing). The closes before
this release are not known: their failures show until they are older than 7 days, or are hidden.

Check: close a pull request whose last review failed; its banner goes. On another failure, click
« Masquer »; the notice « Échec masqué » shows and the failure leaves the list.

## REV-62: A model id of the wrong form already in the database

No migration, no new variable, no new permission.

A level whose model id has not the form of its provider (`anthropic/claude-opus-5.5` on Anthropic,
`claude-sonnet-5-5` on OpenRouter) shows in red on Config and Réglages, with what the provider
expects and where to correct it. A job that would run such an id fails at the claim, before the
installation token and any call to the provider, with the reason « id de modèle invalide pour
Anthropic : … »; the log says `job.model_id_refused`, and the pull request gets the comment of a
failed job. Check: write `anthropic/claude-opus-5.5` on an Anthropic provider in the config of a
repo, open its Config, then push on a pull request of it.

## REV-54: An index for the Runners screen

Migration `0020_jobs_runner_finished`, additive only: the index `jobs_runner_finished_idx` on
`jobs (runner_id, finished_at)`. `jobs_runner_id_idx` stays: its removal is for a later migration.
`/healthz` gives `"migrations":21`. No new variable, no new permission.

The Runners screen counts the jobs of each runner of the last 24 hours by this index, and no longer
reads every job of the runner. The migration builds the index in its transaction: writes to `jobs`
wait for it. Check: `explain` of the `jobs24h` subquery of `apps/web/app/runner/admin.ts` shows an
Index Scan on `jobs_runner_finished_idx`.

## REV-21: Assignment rules

Migration `0019_assignment_rules`, additive only: the table `assignment_rules`, and two nullable
columns of `jobs`, `level_source` and `assignment_rule_id` (what chose the level of a job; null on
the jobs queued before). `/healthz` gives
`"migrations":20`. No new variable, no new permission: the labels come in the payload of
`pull_request`, and the changed files are read with the permission « Pull requests: read » that the
paths of the config already use.

The tab Assignation of the Config screen of a repository lists its rules in order: a condition on
the author, the changed paths and the labels of the pull request, then a level, or no automatic
review. The first rule that matches a push sets the level of its job; with none, the preferences of
the author (REV-22), then the level of the repository apply. A rule wins over the preferences of the
author, also over « automatic review off ». A rule can name a person: the published review mentions
them. The review says which rule applied; the screen of the pull request says what chose the level
of its last job: a rule, the preference of the author, the repository, a command or a retry. A command
(`@kento-review heavy`) ignores the rules.

Check: on a test repository, add a rule « l’auteur est <your login> → heavy » and push on your pull
request: the job is `heavy`, and the review ends with « Assignation : règle 1, … ». Remove the rule:
the next push gets the level of the repository again.

## REV-53: An index for the Repos list

Migration `0018_reviews_repo_published`, additive only: the index `reviews_repo_published_idx` on
`reviews (repo_id, published_at desc, id desc)` for the published reviews. `/healthz` gives
`"migrations":19`. No new variable, no new permission.

The Repos list reads the last 20 published reviews of each repo of its page by this index, and no
longer sorts every review of the repo. The migration builds the index in its transaction: writes to
`reviews` wait for it, under a second at 200 000 reviews. Check: `explain` of the `recent`
subquery of `apps/web/app/repos/store.ts` shows an Index Scan on `reviews_repo_published_idx`.

## REV-52: A job that waits in the queue shows

Migration `0016_queue_notices`, additive only: the table `queue_notices`, with one row per pull
request. `/healthz` gives `"migrations":17`. No new variable, no new permission.

A job queued for more than 10 min shows as a red banner on the dashboard. The pull request gets one
comment « Kentō · review en attente », deleted once the job leaves the queue
([DEPLOY.md](DEPLOY.md#a-job-that-waits-in-the-queue)). The deploy posts nothing for jobs that began
to wait more than a day ago. Check: stop the runner, push on a pull request, wait 10 min; the banner
and the comment show, and the comment goes when the runner is back. The test is
`apps/web/test/db/queued-notice.test.ts`.

## REV-22: The screen of a user

Migration `0017_user_prefs`, additive only: the tables `pull_authors` (the author of each pull
request that Kentō sees, from now on) and `user_prefs`. `/healthz` gives `"migrations":18`. No new
variable, no new permission: the author comes in the payload of `pull_request` and `issue_comment`.

`/users/:login` shows a member their preferences, the findings that their pull requests received
over 30 days, and the pull requests that Kentō reviewed. The login in the sidebar leads to it. The
preferences change the reviews of a push: automatic review off gives no job on their pull requests
(a command still queues one); a default level replaces the level of the repository. The row of a
repository wins over the row of every repository. A pull request opened before this release has no
author until its next push or command, so it does not show on the screen yet.

Check: on your screen, turn the automatic review off for a test repository and push on your pull
request there: no job, and the delivery says `automatic review is off for the author of the pull
request`. `@kento-review lite` still queues one. The Findings screen takes `?author=<login>&days=30`.

## REV-55: A finding refers to its rule

Migration `0015_findings_rule_fk`. It sets `findings.rule_id` to null when the rule no longer exists,
then adds a foreign key to `rules` (`on delete set null`) and a partial index. `/healthz` gives
`"migrations":16`. No new variable.

## REV-19: Rules of a repository and of its org

Migration `0014_rules`, additive only: the table `rules` and the column `jobs.sent_rules`. No new
variable. Deploy `web` before the runners: a runner of this release sends the feature `rules` in its
claim, and an earlier service refuses it. A runner of an earlier release gets its jobs without rules.

## REV-16: Durable findings

Migration `0013_findings`, additive only: the tables `findings` and `finding_events`, with their two
enum types and their indexes. No new variable.

## REV-38: Retention of the jobs, reviews and resolutions

No migration, no new variable. Each instance deletes, once an hour and once at its start, the jobs
that ended (`done`, `failed`, `cancelled`) and were created more than 180 days ago, 2 000 per
statement. Their review or resolution goes with them (`on delete cascade`). A finding or a finding
event that names such a review keeps its row, with its review set to null (`on delete set null`).

What stays, whatever its age:

- the queued and running jobs;
- for each repository, the jobs of its last 20 published reviews and its last failed job: the Repos
  screen reads them for the streak, its reset and the last review;
- the findings and their events, the rules, the repositories and their settings.

What goes, after 180 days: the summary, the findings JSON, the score, the model and the cost of each
review; the verdicts of each resolution; the config, the rules sent and the failure reason of each job.
The screens read at most a month (costs, cap), a week (dashboard chart) or the last rows above, so
none of them changes. Two things can read further back: the dashboard, for a failed job, shows the
previous score of its pull request and averages the cost of the last 20 reviews of a level; past 180
days they show nothing, as for a new repository.

Volume measured on a local database with 200 000 jobs and 180 000 reviews (150 000 of them older than
180 days): the first purge deletes 150 000 jobs in 13.7 s (75 statements of about 180 ms), the next
one finds nothing in 10 ms. The tables go from 159 MB to 110 MB after `VACUUM` (the space is reused
by the next rows, not given back to the disk), and to 63 MB after `VACUUM FULL`. Steady state: 180
days of reviews, about 200 MB at 1 000 reviews a day.

In the logs: `jobs.purged` with `deleted` and `durationMs` when a run deleted something,
`jobs.purge_failed` (error) when the database refused it; the next run tries again.

```sql
select count(*) filter (where created_at < now() - interval '180 days') as older, count(*) from jobs;
```

## REV-35: Comment of a failed job

The release with REV-35 adds the migration `0012_failure_notice`: the column
`jobs.failure_noticed_at`, additive only. `/healthz` gives `"migrations":13`. No new variable.

A job that fails for good (a failed result, the expired lease of its last attempt, or a job that its
runner gives back at its last attempt) used to leave
no trace on the pull request, except 😕 on the comment of a command. Now the publisher posts one
comment on the pull request for each failed review or resolve job: the level, the commit, the first
line of `jobs.failure_reason` (300 characters at most, the keys and the long tokens masked), the
command that runs it again, and a link to the Config screen of the repository when
`KENTO_PUBLIC_URL` is set. For a command, the comment names its author, and the comment of the
command still gets 😕. The comment carries a hidden `<!-- kento:failure <job id> -->`.

The publisher marks the job before it posts, so a job gets one comment at most, and only one try.
In the logs:

- `job.failure_noticed`: the comment is on the pull request.
- `job.failure_notice_skipped`, with `reason` `closed` or `superseded`: the pull request is closed, or
  a newer push moved its head. The job is marked, with no comment.
- `job.failure_notice_failed` (warn): GitHub refused the token, the pull request or the comment. The
  job is marked and gets no second try.
- `job.failure_commenter_unknown` (warn): the comment of the command is gone; the comment names nobody.

Only a failure of the last 30 minutes gets a comment, so the deploy posts nothing for older failures.
A failed result does not wake the publisher: the comment comes with its next run, within 30 seconds.
A cancelled job, or a job of a suspended installation, gets no comment. The test is
`apps/web/test/db/failure-notice.test.ts`.

Check: on a pull request of a test repository, set a model that the provider does not know on its
Config screen, push a commit, and wait for the failure. The pull request gets « Kentō · review en
échec » with the 404 of the provider, and the logs `job.failure_noticed`.

```sql
select level, state, left(head_sha, 8), left(failure_reason, 80), failure_noticed_at from jobs
where state = 'failed' order by finished_at desc limit 5;
```

## REV-14: The dashboard

The release with REV-14 adds the migration `0011_dashboard_indexes`: three indexes, additive only:
`reviews (repo_id, created_at)`, `resolutions (repo_id, created_at)`, and `jobs (repo_id, finished_at)`
where `state = 'failed'`. `/healthz` gives `"migrations":12`. The migration runs in the transaction of
the migrator and holds a `SHARE` lock on the three tables while it builds them: writes of results and
of new jobs wait until it ends (milliseconds on the tables of today; on a database of 600 000 jobs and
456 000 reviews, the migration took 0.3 s).

The home screen `/` is now the dashboard of the org on screen: a member reads it; an admin can also
« Relancer en <niveau> » the last failed review (`POST /jobs/:id/retry`, under `cop()` and the CSRF
token, logged as `dashboard.retry`).

- A retry queues a review of the same head and base branch, with the config of today.
- Like a command, it skips the trigger, the paths and the monthly limit of the repository. It does
  not skip the cost limit of the org (REV-13): at the limit, nothing is queued.
- It first reads the pull request on GitHub, with an installation token `pull_requests: read`. It
  is refused when the pull request is closed, when its head on GitHub or a newer job is another
  commit, when GitHub does not answer, or when a review of that level is already queued or running
  on the head.

The cost of the day and of the month is the sum of `reviews.cost_usd` and `resolutions.cost_usd` of
the repositories of the org since 00:00 UTC (the first of the month, UTC), per provider of the job.
The limits and the alert threshold are those of the settings of the org (REV-13); the totals are
`readOrgCosts` of `app/db/costs.ts`, the same as the settings screen and the limit at the enqueue.

Check, signed in as an owner of `sakuga-software`:

1. `/`: the reviews of the week, the last reviews, the queue and the runners match the database
   (`select state, count(*) from jobs group by 1;`).
2. The cost of the day equals
   `select sum(cost_usd) from reviews where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';`
   plus the same sum on `resolutions`.
3. Stop the runner twice during a job (REV-10): after the second expired lease, the banner says
   « le bail a expiré deux fois sur <runner> ». « Relancer en balanced » queues a job; the banner says
   « Relance en balanced en file », and goes away when its review is published.

## REV-13: Settings of the org: cost limit, defaults, trusted bots, state of the App

The release with REV-13 adds the migration `0010_org_settings` and removes the variable
`KENTO_TRUSTED_BOTS`. `/healthz` gives `"migrations":11`.

What the migration does:

- `orgs`: `daily_cap_usd` and `monthly_cap_usd` (`numeric(10,2)`, null: no limit), `cap_alert_pct`
  (default 80), `trusted_bots` (`text[]`, default `{sakuga-agent[bot]}`), `settings_version`,
  `settings_updated_by`, `settings_updated_at`, and two checks (limits not negative, alert from 1 to
  100). Every existing org starts with no limit and trusts `sakuga-agent[bot]`: the behaviour of the
  previous release with the default of `KENTO_TRUSTED_BOTS`.
- A new table `webhook_deliveries`: one row per delivery that passed the signature (event, action,
  status, outcome), kept 30 days, for « Dernier événement » and « Échecs sur 24 h ».
- **Data migration**: the level of a repository becomes a key of its config, inherited from the org.
  A repository whose `default_level` is not `lite` gets `config.level` with the same value, so it keeps
  its level. The column stays and is still written: the previous release reads it after a rollback.

What changes for the cost and the rights:

- **Cost limit of the org.** An admin sets, in `/settings`, a limit per UTC day and per UTC month, and
  an alert threshold. The cost is the sum of the reviews and resolutions of every repository of the org.
  At a limit, a new job is not queued: a push answers 202 `capped` and its head gets the neutral check
  « Kentō · plafond » (« Plafond du jour atteint : pas de review », with the cost, the limit, and the
  hour when the reviews start again); a command `@kento-review …` gets 😕 and a reply. A job already queued or
  running finishes. The cost of a job is known only when it ends: the jobs queued just before the limit
  can take the cost a little over it. The daily limit of 10 $ of the OpenRouter key stays a second guard.
  The check has its own name: a required check « Sakuga Review » stays missing, and the pull request
  stays blocked until a review.
- **Trusted bots.** The list is in the database, one per org, edited in `/settings` by an admin.
  `KENTO_TRUSTED_BOTS` is not read any more.
- **Defaults of the org.** The level of a push and the provider and models of each level, inherited by
  the Config screen of each repository (« hérité de l’org »), which can replace them.
- **State of the App.** The screen reads `GET /app`, `GET /app/installations/{id}` and
  `GET /app/hook/config` with the JWT of the App (kept 5 minutes): no new permission.
- Every change is a POST under `cop()` and the CSRF token, for an admin only (a member gets 403 and
  reads the screen), logged as `org_settings.saved` / `org_settings.reset` with the login, the version,
  and for the limits and the bots the values before and after.

Steps:

1. Before the deploy, note the value of `KENTO_TRUSTED_BOTS` in Dokploy > `web` > **Environment** (if
   it is set and differs from `sakuga-agent[bot]`).
2. Deploy `web`. The logs show `startup.migrations_applied`, and `/healthz` gives `"migrations":11`.
   With `KENTO_TRUSTED_BOTS` still set, the log shows `startup.kento_trusted_bots_ignored` with its
   value.
3. Signed in as an owner of `sakuga-software`, `/settings` > « Bots de confiance »: put the bots of
   step 1 (one per line), « Enregistrer les bots ». Then remove `KENTO_TRUSTED_BOTS` from Dokploy >
   `web` > **Environment** and redeploy: `startup.kento_trusted_bots_ignored` is gone.
4. `/settings` > « Plafond de coût »: set the limits (for example 8 $ per day, the ticket's value, and a
   monthly limit), « Enregistrer le plafond ». The log `org_settings.saved` gives `before` and `after`.
5. « App GitHub » must say « Tout est en place ». Otherwise it names what is missing: a permission
   (App settings > **Permissions & events**, then accept it in the org), an event, or another webhook
   URL than `https://review.sakuga.dev/webhooks/github`.
6. The tests of the ticket:
   - Set the daily limit to `0,01`, push a commit on an open pull request of `sakuga-review`: no review,
     Recent Deliveries shows 202 `{"outcome":"capped",…}`, and the pull request has the check
     « Kentō · plafond » with « Plafond du jour atteint ». The settings show the red banner. Set `8`
     again and push: a job, then a review.
   - Add `renovate[bot]` to the trusted bots: the next pull request or push of Renovate on `orchard`
     gets a review (orchard enabled on the Repos screen).
   - « Dernier push ou PR » shows the `pull_request.synchronize` of the last push, with its time.
7. Rollback: the previous release runs on the new schema (the columns only add, `default_level` is
   still written). It reads `KENTO_TRUSTED_BOTS` again, and has no cost limit of the org: put the
   variable back before a rollback if the trusted bots differ from the default.

## REV-11: Providers and encrypted keys

The release with REV-11 adds the migration `0009_providers` (type `provider_kind`, table `providers`,
column `jobs.provider_id` with its index; additive only) and the variables `KENTO_SECRETS_KEY` and
`KENTO_SECRETS_PREVIOUS_KEYS`. `/healthz` gives `"migrations":10`. The threat model is in
[SECURITY.md](../../SECURITY.md).

An org without a provider keeps running on `KENTO_PROVIDER_API_KEY` as before: nothing changes until
an admin adds a provider.

Which provider a job uses: the one that the config of the repository or of the org chose for the
level (REV-12, « Provider et modèles », which lists the providers of the org); `service` there
means `KENTO_PROVIDER_API_KEY`. With no choice in the config, the default provider of the org
(« Mettre par défaut » in `/settings`), else `KENTO_PROVIDER_API_KEY`.

1. **Generate the master key** on your machine: `openssl rand -base64 32`. Keep it in the password
   manager (« Kentō · KENTO_SECRETS_KEY »). Never paste it in a ticket, a chat or a commit.
2. **Dokploy** > `web` > **Environment**: add `KENTO_SECRETS_KEY=<the 44 characters>`. Save, then
   deploy `web`. The log shows `startup.secrets` with a `keyId` (not the key), and
   `startup.migrations_applied`. Without the variable, the log shows `startup.secrets_disabled` and the
   screen stores no key.
3. **Deploy the service before the runners.** A runner of this release sends `features` and
   `ownProvider` in its claim; an earlier service would refuse it. Then update `runners-host` to the
   image of this release (REV-4). A runner of an earlier release keeps running the jobs of the
   orgs without a provider.
4. **Move `KENTO_PROVIDER_API_KEY` into a provider of `sakuga-software`** (optional, recommended):
   - signed in as an owner, `/settings` > « Ajouter un provider »: type OpenRouter, name
     « OpenRouter de Sakuga », the key of `KENTO_PROVIDER_API_KEY` (from the password manager, not
     from a log), models empty (the levels of today). « Ajouter le provider », then « Tester »: « Le
     provider a accepté la clé. » and the state « Valide ».
   - Check that a job runs with it: `@kento-review` on a pull request of `sakuga-review`; the log
     `job.claimed` has `"provider":{"id":…,"kind":"openrouter"}` and `"keyFromService":true`, and the
     provider shows « Valide · dernier appel il y a … ».
   - `KENTO_PROVIDER_API_KEY` then only serves the orgs that have no provider. Remove it from Dokploy
     once every org that should run on Sakuga's key has its own provider (today: only
     `sakuga-software`), and redeploy. Without it, the jobs of an org with no provider wait for a
     runner with its own key.
5. **The test of the ticket**, with an Anthropic key of Sakuga:
   - « Ajouter un provider »: type Anthropic, the key, models empty (Haiku 5.5, Sonnet 5.5, Opus 5.5).
     « Tester » gives « Valide ». « Mettre par défaut » if OpenRouter is the default.
   - `@kento-review balanced` on a pull request of `sakuga-review`: the review is published, and its
     footer gives `claude-sonnet-5-5` and a cost (from the price table, `costSource: "table"`).
   - « Remplacer la clé » with a wrong key (`sk-ant-wrong-0000000000`), then `@kento-review`: the job
     fails with `the provider « … » refused its key (401): …`, the state shows « Refusée · 401 depuis
     9 h 40 » and a banner on top of the settings. Replace it with the right key: the banner goes.
   - `docker exec` into Postgres (or the Dokploy console):
     `select id, kind, key_last4, left(key_ciphertext, 24) from providers;` shows `v1:<key id>:…` and
     4 characters, never a key.
6. **Rotation of the master key**: see [SECURITY.md](../../SECURITY.md#the-master-key).

## REV-12: The Config screen of a repository

The release with REV-12 adds the migration `0008_repo_config`, additive only: `orgs.config` and
`repos.config` (`jsonb`, default `{}`), `repos.config_version` (default 0), `config_updated_by`,
`config_updated_at`, and `jobs.config` (null on a job queued before it). `/healthz` gives one migration
more. No data migration: every repository starts at « config v0 », everything inherited, which is
the behaviour of the previous release (each push, the models of the engine, no limit).

**Deploy `web` before the runners.** A runner of this release sends `features: ['providers',
'models']` in its claim; a service of an earlier release refuses that claim (400). A runner of an
earlier release keeps working with this service: it gets no `models` key, runs the models of the
engine, and the log says `job.models_not_sent`.

What changes for the cost and the rights:

- An admin of the org (not a member) sets, per repository, the provider and the models of each
  level, the default level, the trigger (each push, « Ready for review » only, commands only), the
  paths, and a monthly limit of the automatic reviews. Every change is a POST under `cop()` and the
  CSRF token, logged as `repo_config.saved` / `repo_config.reset` with the login and the version.
- A limit stops only the automatic reviews (webhook outcome `skipped`, reason « monthly cost limit of
  the repository is reached »); a command `@kento-review` still runs: a person with the right to
  write asked for it.
- The paths read the files of the pull request on GitHub with a token `pull_requests: read` (the App
  already has it). When GitHub does not answer, the job is queued anyway.

Check, signed in as an owner of `sakuga-software`, on `orchard` (the tests of the ticket):

1. `/repos` > « Config » of orchard > « Provider et modèles »: set the model of `balanced` to
   `anthropic/claude-sonnet-5.5` (or another one), « Remplacer ici », then « Niveaux et passes » >
   `balanced`. Push a commit: the review that Kentō publishes names the model and OpenRouter in its
   footer.
2. « Revenir à l’org » on `balanced`: the next push takes the value of the org again.
3. « Déclenchement » > « Au passage en « Ready for review » »: a push on a draft creates no job, the
   passage to « Ready for review » creates one, and a later push none (webhook outcome `skipped`,
   « trigger of the config is ready »).

## REV-9: The Repos screen

The release with REV-9 adds the migration `0007_repos_screen` (type `workflow_mode` and six nullable
columns of `repos`: `private`, `default_branch`, `workflow`, `workflow_path`, `workflow_ref`,
`workflow_checked_at`; additive only) and drops the variable `KENTO_REPOS`. `/healthz` gives
`"migrations":8`.

`repos.enabled` keeps its value: a repository that `KENTO_REPOS` enabled stays enabled
(`sakuga-software/sakuga-review` today), and every other one stays disabled. No data migration.

1. Deploy `web`. With `KENTO_REPOS` still set, the log shows `startup.kento_repos_ignored`: remove
   the variable in Dokploy > `web` > **Environment** (it changes nothing any more).
2. The App already has **Contents: Read** (REV-5): the screen reads the list of the repositories
   and their `.github/workflows` with it. No new permission.
3. Check, signed in as an owner of `sakuga-software`:
   - `/repos` lists the repositories of the installation; « Actualiser » gives « Liste à jour. », and
     the log `repos.checked` with the number of repositories. `sakuga-review` shows « App Kentō »;
     a repository with `.github/workflows/sakuga-review.yml` shows `review.yml@stable`, `fruitback`
     and `boo` « copie de review.yml ».
   - The test of the ticket, on `orchard`: « Activer » (log `repos.enabled`), then push a commit on a
     pull request of orchard: a job, then a review « Kentō ». The pull request also gets the review
     of the Action while `review.yml` stays. « Désactiver », confirm (log `repos.disabled`), push
     again: no job, and the review stays on GitHub.
   - A member who is not an owner sees the list under « Lecture seule », with no button; a POST of
     theirs gets 403 (`repos.change_refused`).
   - A job that fails on orchard brings its counter back to 0/20, « remis à zéro après un échec ».

At 20/20, « Retirer review.yml » opens the deletion of the file on GitHub: the person commits it on a
branch and merges it like any change. Kentō never writes the repository itself.

## REV-10: The Runners screen

The release with REV-10 adds the migration `0006_runner_registrations`, additive only: the table
`runner_registrations`, the columns `runners.org_id` and `repos.default_runner_pool`. No new
variable, and no change of the runner protocol: deploy `web`, and the runners keep running.
`/healthz` gives `"migrations":7`.

What changes:

- An admin of the org makes a registration token at `/runners` (« Nouveau runner »): name, labels,
  key mode. The token (`kento_reg_…`) is shown once with its `docker run`, works once, and ends after
  one hour; the database keeps only its SHA-256. The runner gets the org, the name, the labels and
  the trust of the token, whatever its environment says.
- A runner of an org runs the jobs of that org only. A runner registered with
  `KENTO_RUNNER_REGISTRATION_TOKEN` (no org, « Runner du service ») runs the jobs of every org, as
  before; the screen shows it, and only an operator changes it, in the database.
- `repos.default_runner_pool`: when set, the jobs of the repository go only to a runner with that
  label. Null (the default, and every existing row) changes nothing.
- « Marquer de confiance » / « Retirer la confiance »: the trust of a runner of the org, read again
  at each claim. « Révoquer… »: the token stops at the next call, and its running job goes back to
  the queue at once, without spending an attempt.
- A member of the org sees the screen, and no form. Every write needs the session, its CSRF token and
  a same-origin request.

Check, after the deploy :

1. Publish the runner image with its version tag first
   ([apps/runner/DEPLOY.md](../runner/DEPLOY.md#1-publish-the-image)). On `/runners`, click
   « Nouveau runner ». Fill in the name `mac-mini`, the label `macos` and the mode « Clé de l’app »,
   then copy the command and run it on the Mac mini. The card shows « En ligne » within 30 s.
2. Set the pool of `sakuga-review` to its label, then push on a pull request: the job goes to
   `mac-mini` (`job.claimed` with its `runnerId`).

   ```sql
   update repos set default_runner_pool = 'macos' where full_name = 'sakuga-software/sakuga-review';
   ```

3. « Révoquer… » `mac-mini` during a job: the logs show `runner.revoked` with the job in `requeued`,
   then `runner.auth_refused` for its heartbeat and claim. Set the pool back to null (or to a label of
   `runners-host`): the job ends on `runners-host`.
4. Make a token and start nothing: one hour later its card says « Token expiré » with the help and
   « Nouveau token ».

`KENTO_RUNNER_REGISTRATION_TOKEN` is no longer needed for a new runner: remove it once
`runners-host` is registered (it keeps working without it).

## REV-8: GitHub sign-in of the screens

The screens of `review.sakuga.dev` sign in with the **user authorization of the GitHub App** « Sakuga
Review » (the same App, no OAuth App). Deploy the release with REV-8 first: its migration
`0005_users_sessions` adds the tables `users`, `memberships` and `sessions`. Without the variables
below, every screen leads to « Connexion indisponible », and nobody gets in: that is safe.

1. GitHub > organization `sakuga-software` > **Settings > Developer settings > GitHub Apps > Sakuga
   Review > General**:
   - **Callback URL**: add `https://review.sakuga.dev/auth/github/callback`.
   - **Expire user authorization tokens**: on (the default). Kentō uses the user token once and
     keeps none.
   - **Request user authorization (OAuth) during installation**: off.
   - **Client secrets > Generate a new client secret**. Copy it once; keep it only in Dokploy.
   - Note the **Client ID** at the top (`Iv23liesB1xzywavcnv2`).
   - **Save changes**.
2. Same App > **Permissions & events > Organization permissions > Members: Read-only**. Save. An owner
   of `sakuga-software` accepts the new permission (GitHub sends a mail; or **Settings > GitHub Apps >
   Sakuga Review > Review request**). Without it, nobody but the owner of a personal account can sign
   in, and the logs show `auth.sign_in_refused`.
3. Dokploy > `web` > **Environment**, add, then **Deploy**:

   ```sh
   KENTO_PUBLIC_URL=https://review.sakuga.dev
   GITHUB_APP_CLIENT_ID=Iv23liesB1xzywavcnv2
   GITHUB_APP_CLIENT_SECRET=<the client secret of step 1>
   KENTO_SESSION_SECRET=<openssl rand -hex 32>
   ```

   `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (REV-4) are needed too: the service reads the role
   of a person with an installation token. A missing variable of the four stops the start with
   `startup.config_invalid` naming it. The log `startup.listening` shows `"signIn": true`.
4. Check, in this order:
   - Open `https://review.sakuga.dev/` in a private window: it goes to « Se connecter à Kentō ».
   - Click « Continuer avec GitHub ». GitHub asks once to authorize « Sakuga Review », then goes back
     to the dashboard, with `alex` and « Admin » at the bottom of the sidebar. The log has
     `auth.signed_in` with `sakuga-software:admin`.
   - A member of the org who is not an owner sees « Lecture seule » on every screen.
   - An account outside of `sakuga-software` comes back to « Accès refusé », and `users` has no row
     for it.

Rotate the session secret: put the new one first and keep the old one after a comma
(`KENTO_SESSION_SECRET=<new>,<old>`), deploy; remove the old one 7 days later. Removing it at once
signs everybody out, and that is the way to end every session now.

Remove a person: remove them from the org on GitHub. Their access ends within 10 minutes (the role is
read again from GitHub); `delete from users where login = '…'` ends it at once.

## REV-7: Commands in the comments

The release with REV-7 adds two migrations, additive only: `0003_comment_commands` (columns
`jobs.github_comment_id`, unique, and `jobs.command_answered_at`) and `0004_resolutions` (table
`resolutions`). No new variable. The runner protocol gains a job kind `resolve`: a runner says in its
claim which kinds it runs, and a runner of an earlier release, which says nothing, gets review jobs
only. So the order web, then runner, is safe: resolve jobs wait in the queue until the new runner.

A new comment of an open pull request that starts with `@kento-review` or `@sakuga-review` is a command,
for the enabled repositories only (`KENTO_REPOS` before REV-9, the Repos screen since): another
repository keeps its commands in `review.yml`.

| Command | What it does |
| --- | --- |
| `@kento-review [lite\|balanced\|heavy]` | Queues a review of the current head at that level (`lite` by default; `@kento-review` alone is `lite`). |
| `@kento-review heavy force` | The same, even when the head already has a review at that level. |
| `@kento-review resolve [lite\|balanced\|heavy]` | Queues a resolve job: the model reads up to 20 open threads and 150 kB, answers in each, and the service resolves the threads that the code settled. |

The checks, in this order, with the reason in the logs (`webhook.ignored`, `command.not_allowed`,
`command.refused`, `command.accepted`):

- An edited comment, a comment of the App, or of a bot outside the trusted bots of the org: ignored.
- A person without `write`, `maintain` or `admin` on the repository: no job and no answer.
- A pull request from a fork: 😕 and a short reply.
- An unknown command: 😕 and the list of the commands.
- A head that already has a review at that level, queued, running or done (the lite review of the
  push counts): 😕 and a reply that names `force`. A failed or cancelled review does not count.
- A resolve while another resolve of the pull request is queued or running: 😕 and a reply. A
  resolve at a head that a resolve already answered costs nothing: the threads that carry its mark
  wait for a new push, and with no thread left the runner calls no model.
- Otherwise: one job, and 👀. After the publication of its review the comment gets 🚀; when the job
  fails, or a newer push cancels it, 😕.

A comment creates one job at most, whatever its deliveries: GitHub's « Redeliver » and a replay with
a new delivery id give `duplicate`. A reply goes only with a new reaction, so a redelivery posts no
second reply. When GitHub fails during the command (token, permission, pull request), the delivery
answers 500: send it again from **Advanced > Recent Deliveries**.

The resolve job, step by step:

- At the claim, the service reads the open threads with a token `pull_requests: read` of its own,
  and sends them in the job, cleaned. The runner clones with `contents: read` as for a review,
  builds the pack, calls the model, and tells for each thread whether its file changed since the
  thread. It writes nothing on GitHub.
- The publisher replies in each thread, resolves with a token `contents: write` + `pull_requests:
  write` asked for this repository at that moment, and posts the summary with the cost. It marks the
  row before it writes: a failure in the middle never posts twice (`resolve.publication_failed`, 😕).
- A thread of a person closes only when its file changed since the thread; a finding of the bot
  closes when the code fixed it or a reply settled it. Without `contents: write` the reply says that a
  person can resolve the thread (`resolve.write_token_refused`).

1. The App already has **Issue comment** in its events (REV-3) and **Issues: Read and write**
   (REV-5). For `resolve`: **Repository permissions > Contents: Read and write**, then accept the
   change in the organization. Until then resolve answers in each thread and resolves none.
2. Merge REV-7 (both pull requests), then deploy `web` at once: the second pull request removes
   `.github/workflows/sakuga-review.yml`, so between the merge and the deploy a command on this
   repository gets no answer, and never two. `/healthz` gives `"migrations":5`.
3. Publish the runner image of the same commit and recreate the runner
   ([apps/runner/DEPLOY.md](../runner/DEPLOY.md#1-publish-the-image)).
4. Check on a pull request of `sakuga-software/sakuga-review`:
   - `@kento-review heavy`: 👀 at once, then a review « Kentō · Niveau heavy » and 🚀.
   - `@sakuga-review resolve`: 👀, a reply in each open thread, the fixed threads resolved, a comment
     « Kentō · résolution des fils » with the cost, and 🚀.
   - the same comment again: 😕 and the reply about `force`; no second job.
   - `@kento-review frobnicate`: 😕 and the list of the commands.
   - a comment of an account without write access: no job, and `command.not_allowed` in the logs.

```sql
select level, state, left(head_sha, 8), github_comment_id, command_answered_at from jobs
where github_comment_id is not null order by created_at desc limit 5;
select pr_number, left(head_sha, 8), model, cost_usd, published_at from resolutions order by created_at desc limit 5;
```

## REV-6: Expired leases and attempts

The release with REV-6 adds the migration `0002_job_retries` (column `jobs.not_before` and a partial
index on the leases of the running jobs; additive only) and changes the runner protocol: each job
carries an `attempt`, and the heartbeat and the result send it back.

1. Stop the runner first (`docker stop kento-runner` on `runners-host`). A runner of the earlier
   release would claim a job of the new service, refuse its message (`attempt` is a key it does not
   know) and log `runner.claim_failed`: the job would come back only after its lease, and each such
   claim spends one of its 2 attempts. The jobs queued while no runner runs just wait.
2. Deploy `web`. Its logs show `startup.migrations_applied`, and `/healthz` gives `"migrations":3`.
3. Publish the runner image of the same commit and recreate the runner
   ([apps/runner/DEPLOY.md](../runner/DEPLOY.md#1-publish-the-image)).
4. Check, with one runner and one open pull request:
   - push a commit, then `docker stop kento-runner` during the review. About 2 min later the web logs
     show `job.lease_expired` with `"state":"queued"`; start the runner again, and the job ends
     `done` with `attempts = 2`. One row in `reviews`.
   - stop it twice on the same job: the job ends `failed` with `failure_reason = 'lease expired 2 times'`.
   - push twice in a row during a review: the first job ends `cancelled`, the runner logs
     `job.cancelled_by_service` then `job.finished` with `"outcome":"cancelled"`, and only the new head
     gets a review.

## REV-5: Publication of the reviews

The service publishes the review that a runner sends: the review with its score and its inline
comments, the block at the end of the description, the label `review: N/5` and the check
« Sakuga Review ». The format is the one of `review.yml`. No migration, and no new variable: the
publisher runs when `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set (REV-4), and
`startup.listening` shows `"publisher":true`.

1. App settings > **Permissions & events > Repository permissions**:
   - **Contents: Read**, **Pull requests: Read and write**, **Issues: Read and write**: the App has
     them for the Action.
   - **Checks: Read and write**: new. Save, then accept the change of permissions in the
     organization (GitHub sends a request to its owners). Until then the review is published without
     its check, and each review logs `review.check_token_refused`.
2. Deploy the release with REV-5. The repository must be enabled (`KENTO_REPOS` before REV-9, the
   Repos screen since), and a runner must run
   (REV-4).
3. Push a commit on an open pull request of the repository. In the logs, in order: `job.claimed`,
   `job.result`, `review.published` with the GitHub id of the review, its score, the number of inline
   comments and `"check":true`. On the pull request: a review of `kento-review[bot]` whose footer
   starts with `Kentō · Niveau`, its inline comments, the block of the description, the label and the
   check « Sakuga Review ».
4. While `.github/workflows/sakuga-review.yml` still reacts to `pull_request`, the pull request gets
   two reviews per push: the one of the Action and the one of Kentō. Compare them (step 4 of the
   ticket), then merge the pull request that removes the trigger.

What the publisher does not publish, on purpose, with the reason in `review.publication_skipped`:

- `superseded`: the head of the pull request moved since the job. The review of the new head
  replaces it, as a push cancelled the run of the Action.
- `closed`: the pull request is closed or merged.
- `suspended`: the installation of the App is suspended.

A failure before the review is posted (`review.publication_failed`: the token, the pull request,
the list of the threads) is tried again, three times per process, for 30 minutes. An error on one
thread only leaves that thread open (`publish.thread_failed`, or `publish.step_failed` for its
reply). The threads of the findings that are gone are closed only once the review is on GitHub. A failure after it (`publish.step_failed`: the dismissal, the description,
the label or the check) is not: the review is on GitHub, and a second one would repeat it. Each
review carries a hidden `<!-- kento:review <id> -->`: when the row could not be marked (a restart, a
lost connection), the next try finds that review on GitHub, marks the row and posts nothing again
(`publish.already_posted`).

```sql
select pr_number, left(head_sha, 8), score, published_at, github_review_id from reviews order by created_at desc limit 5;
```

`published_at` set with `github_review_id` null: a review that was skipped.

## REV-4: Runner API

The runners call `POST /api/runner/*` on the same domain. Deploy the release with REV-4 first: its
migration `0001_runners` adds the table `runners` and the columns `jobs.base_ref` and
`jobs.runner_id`. Without the variables below the API is closed (register: 401; claim: no job), and
that is safe.

1. The App « Sakuga Review » must have the permission **Repository contents: Read** (it has it for
   the reviews of the Action). The service asks GitHub for tokens with this permission only.
2. App settings > **General > Private keys > Generate a private key**. Keep the downloaded PEM only
   in Dokploy, then delete the file. Note the **App ID** at the top of the page.
3. Dokploy > `web` > **Environment**, add, then **Deploy**:

   ```sh
   KENTO_RUNNER_REGISTRATION_TOKEN=<openssl rand -hex 32>
   GITHUB_APP_ID=<App ID>
   GITHUB_APP_PRIVATE_KEY=<the PEM; on one line, write each new line as \n>
   KENTO_PROVIDER_API_KEY=<the OpenRouter key of the service, for the trusted runners>
   ```

   An invalid key stops the start with `startup.config_invalid` naming `GITHUB_APP_PRIVATE_KEY`,
   never its value.
4. Start the runner: [apps/runner/DEPLOY.md](../runner/DEPLOY.md).

Close the registration once the runners are registered: remove `KENTO_RUNNER_REGISTRATION_TOKEN`.
The registered runners keep working.

## REV-3: GitHub App webhook

The existing App « Sakuga Review » (client id `Iv23liesB1xzywavcnv2`) gets a webhook. No new App.
Deploy the release with REV-3 first: without its secret the route answers 503, and that is safe.

1. Generate the secret on your machine, and keep it only in Dokploy and in the App settings:

   ```sh
   openssl rand -hex 32
   ```

2. Dokploy > `web` > **Environment**, add, then **Deploy**:

   ```sh
   GITHUB_WEBHOOK_SECRET=<the 64 characters>
   ```

   The trusted bots are a setting of each org since REV-13. The logs at startup show
   `startup.listening`, and no `startup.webhook_disabled`. Since REV-9 a repository gets jobs once an
   admin enables it on the Repos screen (REV-9); before REV-9 it was `KENTO_REPOS`.
3. GitHub > organization `sakuga-software` > **Settings > Developer settings > GitHub Apps > Sakuga
   Review > General**:
   - **Webhook > Active**: on.
   - **Webhook URL**: `https://review.sakuga.dev/webhooks/github`
   - **Webhook secret**: the same 64 characters.
   - SSL verification: enabled.
   - **Save changes**.
4. Same App > **Permissions & events > Subscribe to events**: `Pull request`, `Issue comment`
   (`Installation` and `Installation repositories` need no box: GitHub always sends them to an
   App). Save. If GitHub asks the organization to accept a change of permissions, accept it.
5. **Advanced > Recent Deliveries**: the `ping` has the answer 200 `{"outcome":"pong"}`.

### Checks

1. Push a commit on an open pull request of `sakuga-software/sakuga-review`. Recent Deliveries shows
   `pull_request.synchronize` with 202 `{"outcome":"queued",…}`, and in the database:

   ```sql
   select pr_number, left(head_sha, 8), state, github_delivery_id from jobs order by created_at desc limit 5;
   ```

   gives one `queued` row with the head of the push.
2. Push again: the first row is `cancelled`, the new one `queued`.
3. A wrong signature: `curl -i -X POST https://review.sakuga.dev/webhooks/github -H 'X-GitHub-Event: ping' -H 'X-GitHub-Delivery: manual-1' -H 'X-Hub-Signature-256: sha256=00' -d '{}'`
   gives 401 `invalid signature`, and `jobs` has no new row.
4. Recent Deliveries > the delivery of step 2 > **Redeliver**: 202 `{"outcome":"duplicate",…}`, and
   no new row.

Rotate the secret: a new value in Dokploy and in the App settings, one right after the other. The
deliveries in between get 401; redeliver them from Recent Deliveries.

Turn it off: uncheck **Webhook > Active** in the App, or remove `GITHUB_WEBHOOK_SECRET` (503).
