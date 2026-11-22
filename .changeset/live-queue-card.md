---
"@kento-review/web": patch
---

pr: #53

**Live card of the dashboard** (KNT-189): the card "Queue and runners" follows a stream of
server-sent events, `GET /dashboard/live`, for a signed-in member, for the org of the session. A
proxy in front of the service must not buffer `text/event-stream` answers (Traefik does not by
default) and must keep an idle connection open 30 s at least: the stream sends a comment every
25 s and ends after 2 minutes, then the browser opens another one. A stream checks its session and
its org again every 20 s, and ends at once at a sign-out or a switch of org. Each session holds 4
streams at most (429 beyond), the service 200 (503 beyond), and a client that reads nothing for 5 s
is cut. While the service shuts down it answers 503 with `Retry-After`, and the open pages come back
by themselves after a deploy. The card also says how many runners are ready: online, with no job in
progress. A request that the client leaves before the answer is logged at `info` with status 499,
no longer as an error. No migration, no new variable.
