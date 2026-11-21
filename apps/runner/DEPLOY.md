# Deploy the Kentō runner

How the operator of a Kentō service publishes the runner image and runs the **runners of the
service**: the runners that take the jobs of every organization, and that can use the provider key
of the service. An admin of an organization who runs a runner for that organization only, on their
own machine, follows [README.md](README.md) instead.

The examples use `https://kento.example.com` for the service and `registry.example.com/kento-runner`
for the image: put your own in their place.

The runner speaks to the service in HTTPS, outbound only. It needs no open port.

## 0. Before: the web service (once)

Deploy the web service first ([apps/web/DEPLOY.md](../web/DEPLOY.md)). For the runners of the
service, add these variables to its environment and deploy (details in
[apps/web/DEPLOY.md](../web/DEPLOY.md#4-environment-variables)):

```sh
KENTO_RUNNER_REGISTRATION_TOKEN=<openssl rand -hex 32>
GITHUB_APP_ID=<the App ID of your GitHub App>
GITHUB_APP_PRIVATE_KEY=<the PEM of the App, on one line with \n>
KENTO_PROVIDER_API_KEY=<the provider key of the service, for a trusted runner>
KENTO_RUNNER_IMAGE=registry.example.com/kento-runner
```

`KENTO_RUNNER_IMAGE` is the image that the Runners screen puts in its `docker run`, with the version
of the service as the tag.

## 1. Publish the image

The releases of Kentō publish `ghcr.io/sakuga-software/kento-runner:<version>` (see "Publish a
release" below). Use that image, or publish your own: from a checkout of the release to publish, on
a machine logged in to your registry:

```sh
IMAGE=registry.example.com/kento-runner
COMMIT=$(git rev-parse HEAD)
docker buildx build --platform linux/amd64,linux/arm64 \
  -f apps/runner/Dockerfile --build-arg APP_COMMIT=$COMMIT \
  -t $IMAGE:$COMMIT \
  -t $IMAGE:$(node -p "require('./apps/runner/package.json').version") \
  -t $IMAGE:latest \
  --push .
```

The Runners screen gives `<KENTO_RUNNER_IMAGE>:<version of the service>`: publish that tag for each
release of the service. Whoever runs a runner of your service pulls this image, so give them read
access to it, or make it public.

## 2. Start a runner of the service

**Never run the runner in a Docker that CI jobs can reach.** On a host that also runs CI jobs, a
job could `docker exec` into the runner, or mount its volume, and read its token. A trusted runner
gets the provider key and an installation token with each job. Give the runner its own user, with
its own rootless Docker and a home that only this user can read, and keep the users of the CI out
of its Docker socket.

Write the environment in a file that only this user can read, `~/kento-runner/env` (`chmod 600`):

```sh
KENTO_URL=https://kento.example.com
KENTO_REGISTRATION_TOKEN=<the value of KENTO_RUNNER_REGISTRATION_TOKEN of the web service>
KENTO_RUNNER_NAME=runner-1
KENTO_RUNNER_LABELS=linux,x64
PROVIDER_KIND=openrouter
# Key mode "app": the key stays on the service. For a runner with its own key, set
# PROVIDER_API_KEY here instead, and the service never sends its key to this runner.
```

Start it:

```sh
docker run -d --name kento-runner --restart unless-stopped \
  --env-file ~/kento-runner/env \
  -v kento-runner-state:/var/lib/kento-runner \
  --tmpfs /tmp:rw,size=2g \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 2g --cpus 2 \
  --stop-timeout 30 \
  registry.example.com/kento-runner:latest
```

- The volume `kento-runner-state` keeps `runner.json`, the runner token (mode 600). Without the
  volume, each restart registers a new runner.
- Each job clones into `/tmp/kento-runner/job-*`, and removes it at the end.
- The first start registers: `docker logs kento-runner` shows `runner.registered` then
  `startup.ready`. After that, remove `KENTO_REGISTRATION_TOKEN` from the env file and recreate the
  container: the runner no longer needs it.

## 3. Trust the runner (key mode "app")

A registration never makes a trusted runner. A runner with no key of its own uses the provider key
of the service, so mark it trusted in the database of the web service. Until then it takes no job:
the jobs stay queued for it, they do not fail:

```sql
select id, name, labels, trusted, created_at, last_seen_at from runners order by created_at;
update runners set trusted = true where id = '<id of the runner>';
```

## 4. Check the runner

1. Push a commit on an open pull request of an enabled repository. Within 30 s,
   `docker logs kento-runner` shows `job.started`, then `job.finished` with `"outcome":"done"`, the
   score, the model and the cost. In the database:

   ```sql
   select j.state, j.attempts, r.score, r.model, r.cost_usd, jsonb_array_length(r.result->'findings') as findings
   from jobs j join reviews r on r.job_id = j.id order by j.created_at desc limit 1;
   ```

2. The log of the runner holds no token:

   ```sh
   docker logs kento-runner 2>&1 | grep -E 'ghs_|kento_rt_|sk-or-|x-access-token' && echo LEAK || echo clean
   ```

3. A runner without a valid token gets 401:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://kento.example.com/api/runner/jobs/claim \
     -H 'Authorization: Bearer kento_rt_wrong' -H 'Content-Type: application/json' -d '{"hasProviderKey":false}'
   # 401
   ```

## Another runner: the Runners screen

An admin of an org adds a runner from `https://kento.example.com/runners`, with no change to the web
service: "New runner" → a name, labels and the key mode → a registration token shown once, valid
one hour and one use, and a `docker run` to copy. The runner gets the name, the labels and the trust
of the token, and runs the jobs of that org only. The image of the command is
`<KENTO_RUNNER_IMAGE>:<version of the service>`: publish that tag (section 1).

The runners registered with `KENTO_RUNNER_REGISTRATION_TOKEN` stay runners of the service ("Runner
of the service" on their card): they run the jobs of every org, the screen shows them, and only an
operator trusts or revokes them, in the database, as below.

## 5. Revoke a runner

A runner of the screen: "Revoke…" on its card. Its token stops at the next call, and its
running job goes back to the queue at once, without spending an attempt.

A runner of the service:

```sql
update runners set revoked_at = now() where id = '<id>';
```

The next call of the runner gets 401 (a claim in progress ends within 30 s). The runner logs
`runner.token_refused` and waits until it is stopped; it does not register again on its own, and a
restart policy does not start it in a loop. A job that it held goes back to the queue when its lease
ends (at most 2 min after the last heartbeat, see [Leases and attempts](#leases-and-attempts)).

To start it again as a new runner: remove the volume (`docker volume rm kento-runner-state`), put
`KENTO_REGISTRATION_TOKEN` back in the env file, recreate the container, and trust the new row if
needed.

## Variables

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `KENTO_URL` | yes | | The web service. HTTPS only (`http://127.0.0.1` or `localhost` for a local test). |
| `KENTO_REGISTRATION_TOKEN` | first start | | Registers the runner when the state volume has no `runner.json`. A secret. |
| `KENTO_RUNNER_NAME` | no | host name | Shown in `runners.name`. A token of the Runners screen sets the name itself. |
| `KENTO_RUNNER_LABELS` | no | | Comma-separated labels, kept in `runners.labels`. A token of the Runners screen sets them itself. A repository with a `default_runner_pool` gives its jobs only to a runner that has that label. |
| `PROVIDER_KIND` | no | `openrouter` | The provider of the runner's own key or server: `openrouter`, `anthropic`, `openai_compatible` or `ollama`. The runner calls it for the jobs whose provider has this kind; for the others it needs the key of the job (a trusted runner). |
| `PROVIDER_BASE_URL` | no | the URL of the kind | Another server with the same API. HTTPS only, except for `ollama` (HTTP allowed: a server on this machine or the private network; default `http://localhost:11434`). Required with `openai_compatible`. |
| `PROVIDER_API_KEY` | no | | The key of the runner (key mode "runner"). With it, the service never sends its key for this kind. Ollama needs none. A secret. |
| `KENTO_STATE_DIR` | no | `/var/lib/kento-runner` | Holds `runner.json`. |
| `KENTO_WORK_DIR` | no | `/tmp/kento-runner` | Where the jobs clone. |

The service must be deployed before a runner of the same release: the runner sends `features` and
`ownProvider` with each claim, and an earlier service refuses them (400).

## What the runner does with the code

- It fetches the head commit and the base branch into a bare repository: every commit and tree, and
  the blobs of the head (`--filter=blob:none`, then one batch). There is no checkout: no file of the
  pull request is written, and no hook, script or build of the pull request runs. The engine only
  reads the objects with git.
- The installation token goes to git in an HTTP header through the environment, never in a URL, a
  command line or a file. GitHub limits it to the repository of the job, with `contents: read`, for
  one hour. The private key of the App stays in the web service.
- A stop of the runner (`docker stop`, a redeploy) in the middle of a job sends no result: the
  failure comes from the stop, not from the pull request. The job stays `running` until its lease
  ends, then goes back to the queue for another attempt. A review already finished is still sent.
- A service that answers a claim at once with no job (no GitHub App configured) holds it for the
  whole wait anyway, and the runner waits at least 5 s between two such claims.
- Every log line goes through a filter that removes the tokens and keys that the runner knows, and
  any `ghs_…`, `kento_rt_…` or URL credential.

## Leases and attempts

- A claim gives the runner a lease of 2 min on the job, and each heartbeat (every 30 s) extends it.
  Each claim is one **attempt**: the job carries its number, and the heartbeat and the result send it
  back.
- The web service sweeps the expired leases every 15 s. A `running` job whose lease ended goes back
  to `queued`, and waits 30 s (the backoff) before a runner can claim it again. After its second
  attempt it becomes `failed` with the reason `lease expired 2 times`.
- A runner whose attempt is over gets 409 `lease_lost` on its next heartbeat: it stops the job
  (`job.lease_lost`, then `job.finished` with `"outcome":"lost"`) and sends nothing. A result that
  arrives after another attempt began gets 409 too, and the service stores nothing.
- A job cancelled while it runs (a newer push, a close, a suspension): the next heartbeat answers
  `cancel: true`, the runner stops its model call and sends nothing (`"outcome":"cancelled"`), and a
  late result gets 409.

To see the attempts of the last jobs:

```sql
select left(head_sha, 8), state, attempts, failure_reason, not_before, lease_expires_at
from jobs order by created_at desc limit 10;
```

## Resolve jobs

A runner claims `review` and `resolve` jobs (`kinds` in the claim). A resolve job holds the open
review threads, which the service read on GitHub: the runner clones the pull request as for a
review, builds the pack of the threads, calls the model, and tells for each thread whether its file
changed since the thread. It never calls GitHub, and its token stays `contents: read`. With no
thread to answer, it clones nothing and calls no model.

A runner of an earlier release that sends no `kinds` gets review jobs only. Deploy `web` first, then
the runners; the resolve jobs wait in the queue meanwhile.

## Publish a release

For the maintainers of `sakuga-software/kento`. A tag `vX.Y.Z` starts the Release workflow
(`.github/workflows/release.yml`). The workflow:

1. checks that `apps/web/package.json` and `apps/runner/package.json` have the version `X.Y.Z`, and
   that `apps/web/CHANGELOG.md` has a section `## X.Y.Z`;
2. builds the image, checks that it starts, then publishes `ghcr.io/sakuga-software/kento-runner` with the tags `X.Y.Z`, the commit and `latest`,
   for `linux/amd64` and `linux/arm64`;
3. creates the GitHub release with the notes of that section.

The tag comes from the changesets (CONTRIBUTING.md, "Changesets"). Each push to `main` updates
the pull request "chore: version packages": it sets the version `X.Y.Z` in the two `package.json`
files, writes the section `## X.Y.Z` of the CHANGELOG and removes the changesets. GitHub runs no
check by itself on that pull request, which the token of a workflow opened: close and reopen it to
run the CI. Merge it, and the job "Tag the release" of `.github/workflows/changesets.yml` tags the
merge commit `vX.Y.Z` (an annotated tag, not signed) and starts the Release workflow on it.

When the Release workflow fails on a cause outside the code (the access to the package, an outage
of GitHub), fix it and start the workflow again on the tag: Actions, Release, "Run workflow", with
the tag as "Use workflow from". A GitHub release that already exists makes its last job fail.

The package `kento-runner` must be public, and the repository `kento` must have write access to it
(package settings, "Manage Actions access").
