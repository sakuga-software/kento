---
"@kento-review/web": patch
---

pr: #53

**Live card of the dashboard** (KNT-189): the card "Queue and runners" follows a stream of
server-sent events, `GET /dashboard/live`, for a signed-in member, for the org of the session. A
proxy in front of the service must not buffer `text/event-stream` answers (Traefik does not by
default) and must keep an idle connection open 30 s at least: the stream sends a comment every
25 s and ends after 2 minutes, then the browser opens another one, which checks the session and
its org again. Each session holds 4 streams at most. The card also says how many runners are
ready: online, with no job in progress. A request that the client leaves before the answer is
logged at `info` with status 499, no longer as an error. No migration, no new variable.
