# Kentō runner: run it on your own machine

The runner is the program that does the reviews of Kentō. It asks `https://review.sakuga.dev` for
a job, clones the pull request, calls the model, and sends the review back. The service then posts
it on GitHub. This page is for an admin of an organization who wants the reviews of that
organization to run on a machine of their own.

The runner only makes outbound calls. It needs no open port, no public address and no domain.

The operator of a Kentō service publishes the image and runs the runners of the service with
[DEPLOY.md](DEPLOY.md).

## Requirements

- **Docker** on a machine that stays awake. A machine that sleeps during a job loses it (see
  [A job fails because its lease expired](#a-job-fails-because-its-lease-expired)).
- **Outbound HTTPS** (port 443) to:
  - `review.sakuga.dev`, the service;
  - `github.com`, where the runner clones the pull request;
  - the model provider: `openrouter.ai` by default, `api.anthropic.com`, or your own server. With
    a local Ollama, no provider outside the machine.
- **An admin account of the organization in Kentō.** Kentō reads the role from GitHub. An admin of
  the GitHub organization is an admin in Kentō. A member sees the Runners screen but cannot create
  a runner.
- **The image** that the Runners screen names in its command: `KENTO_RUNNER_IMAGE` of the service
  (`ghcr.io/sakuga-software/kento-runner` by default), with the version of the service as its tag.
  When its registry is private, ask the operator of the service for read access, then log in once,
  for example on ghcr.io with a GitHub token that has the `read:packages` scope:

  ```sh
  echo <token> | docker login ghcr.io -u <your GitHub login> --password-stdin
  ```

  You can build the image instead, from the root of a checkout at the release of the service, with
  the name and the tag of the command:

  ```sh
  docker build -f apps/runner/Dockerfile --build-arg APP_COMMIT=$(git rev-parse HEAD) \
    -t <image of the command>:<version> .
  ```

  `<version>` is the version that the Runners screen shows in its command (`0.1.0` today).
- **A model key**, unless your organization added a provider whose key Kentō stores (see
  [Key modes](#key-modes)). The key of the service never goes to a runner of an organization. An
  OpenRouter key works with no other setting.
- **Room for the clones.** Each job clones into a `tmpfs` of 2 GB, and removes the clone at the
  end. The runner runs one job at a time.

## 1. Create the runner in the Runners screen

1. Open `https://review.sakuga.dev/runners`, then click **New runner**.
2. **Name**: the name of the machine, for example `runner-1`. Letters, digits, dots, dashes or
   underscores, 100 at most.
3. **Labels**: optional, separated by commas, for example `macos`. A repository with a pool sends
   its jobs only to the runners that have the label of the pool. No screen sets a pool today: the
   operator of Kentō sets it in the database. Without a pool, which is the default, the labels
   change nothing.
4. **Model key**: where the model key is. See [Key modes](#key-modes). Keep "Key on the runner"
   unless the organization stores its provider keys in Kentō and the runner is a machine you control.
5. Click **Create the token**.

The screen shows a registration token (`kento_reg_…`) and a `docker run` command that contains it.
Copy the command now. The screen never shows the token again. The token works once, and for one
hour. The name, the labels and the key mode are fixed in the token. The variables of the machine
cannot change them.

Until a runner uses it, the token stays in **Waiting tokens** with "Waiting for the runner".

## 2. Start the runner

Run the command of the screen on the machine. It looks like this:

```sh
docker run -d --name kento-runner --restart unless-stopped \
  -e KENTO_URL=https://review.sakuga.dev \
  -e KENTO_REGISTRATION_TOKEN=kento_reg_… \
  -e KENTO_RUNNER_NAME=runner-1 \
  -e KENTO_RUNNER_LABELS=macos \
  -e PROVIDER_KIND=openrouter \
  -e PROVIDER_BASE_URL=https://openrouter.ai/api/v1 \
  -e PROVIDER_API_KEY=<your OpenRouter key> \
  -v kento-runner-state:/var/lib/kento-runner \
  --tmpfs /tmp:rw,size=2g --read-only --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/sakuga-software/kento-runner:0.1.0
```

Replace `<your OpenRouter key>` with your key before you run it. The shell reads the `<` as a
redirection, so the command fails if you leave it.

What the parts do:

| Part | Why |
| --- | --- |
| `--restart unless-stopped` | Docker starts the runner again after a crash or a reboot of the machine. |
| `-v kento-runner-state:/var/lib/kento-runner` | The volume keeps `runner.json`, the token of the runner. Without it, the runner cannot start again after the registration token is used. |
| `--tmpfs /tmp:rw,size=2g` | The clones go there, in memory, and leave with the job. |
| `--read-only --cap-drop ALL --security-opt no-new-privileges` | The runner writes only to the volume and to `/tmp`, and has no Linux capability. It never builds or runs the code of a pull request. |

On its first start the runner registers, writes `runner.json` in the volume, and starts asking for
jobs. Check its log:

```sh
docker logs kento-runner
```

```json
{"time":"…","level":"info","event":"runner.registered","runnerId":"…","name":"runner-1","labels":["macos"]}
{"time":"…","level":"info","event":"startup.ready","runnerId":"…","version":"0.1.0","url":"https://review.sakuga.dev","ownKey":true}
```

Reload the Runners screen. The runner is in **Runners** with "Online". The token leaves
**Waiting tokens**.

The command keeps `KENTO_REGISTRATION_TOKEN` in the container. Once `runner.json` exists, the
runner does not read it again, so you can run the same command later (an update, another key) with
the used token in it.

`--name kento-runner` and the volume `kento-runner-state` are fixed names. For a second runner on
the same machine, change both.

## Key modes

The model key is on the runner, or the service sends the key that the organization stored in
Kentō with each job. The admin chooses when creating the token, and can change it later on the
runner's card. The OpenRouter key of the service goes only to the runners of the service, never to
a runner of an organization (REV-130).

| Mode on the screen | Card | What happens |
| --- | --- | --- |
| **Key on the runner** (recommended for a machine outside Sakuga) | "Key on the runner" | The runner calls the model with `PROVIDER_API_KEY`. The service never sends a key to this runner. You pay the provider directly. |
| **Keys stored in Kentō** | "Keys stored in Kentō (trusted)" | The runner is trusted: when it has no key of the kind that a job needs, the service sends the key of the provider of the organization with the job. The key is in the memory of the runner for the length of the job. |

"Mark as trusted" and "Remove the trust" on the card switch between the two. The
service reads the trust again at each claim.

Which jobs a runner takes depends on the provider of the job, which the organization sets in
**Settings → Providers and keys** and in the Config of each repository:

| Provider of the job | The runner takes it when |
| --- | --- |
| None (the organization has no provider) | `PROVIDER_KIND=openrouter` with `PROVIDER_API_KEY`. A runner of the service also takes it when it is trusted and the service has its OpenRouter key. A runner of the organization without its own OpenRouter key never takes it: the Dashboard says that the job waits for a runner with an OpenRouter key. |
| A provider whose key the service holds | The runner has its own key of that kind (`PROVIDER_KIND` and `PROVIDER_API_KEY`), or it is trusted. |
| A provider with "The key stays on the runner" | The runner has `PROVIDER_KIND` of that kind and its key. Trust does not help: the service has no key. |
| Ollama | The runner has `PROVIDER_KIND=ollama`. |
| LM Studio, vLLM or llama.cpp on the network of the runner | The runner has `PROVIDER_KIND=openai_compatible` and the `http://` URL of the server. |

A job that no runner can take stays in the queue. It does not fail.

### Another provider than OpenRouter

Change `PROVIDER_KIND`, `PROVIDER_BASE_URL` and `PROVIDER_API_KEY` in the command:

| `PROVIDER_KIND` | `PROVIDER_BASE_URL` | `PROVIDER_API_KEY` |
| --- | --- | --- |
| `openrouter` | empty or `https://openrouter.ai/api/v1` | an OpenRouter key |
| `anthropic` | empty (`https://api.anthropic.com`) | an Anthropic key |
| `openai_compatible` | required, `https://…`, or `http://…` for a [local server](#lm-studio-vllm-or-llamacpp-on-the-network-of-the-runner) | the key of that server; none for a local server that asks for none |
| `ollama` | see [Ollama](#ollama-on-the-machine-of-the-runner) | none |

`PROVIDER_BASE_URL` must be HTTPS, except for Ollama and a local server of the API of OpenAI. The organization needs a provider of the same
kind in **Settings → Providers and keys**, set "Default" or chosen for a level in the Config of
a repository. Tick "The key stays on the runner" there so that the service never stores the key.

## Ollama on the machine of the runner

The model runs on your machine or on your network. The service has no key, and the review shows a
cost of 0.

1. In Kentō, **Settings → Add a provider**:
   - **Type**: Ollama;
   - **Name**: for example "Ollama of the office machine";
   - **Server URL**: leave it empty, the runner gives it;
   - **Models per level**: Ollama has no default model, so name one for each of `lite`,
     `balanced` and `heavy`, for example `qwen3`. Pull them first on the Ollama server
     (`ollama pull qwen3`).

   Click **Add the provider**. The first provider of the organization becomes "Default";
   otherwise click **Make default**, or choose it for a level in the Config of a repository.
2. Start the runner with these two lines in place of the three `PROVIDER_` lines of the command:

   ```sh
     -e PROVIDER_KIND=ollama \
     -e PROVIDER_BASE_URL=http://host.docker.internal:11434 \
   ```

   Inside the container, `localhost` is the container itself, not your machine. The default of the
   runner, `http://localhost:11434`, therefore fails with Ollama on the host.
   `host.docker.internal` reaches the host on Docker Desktop and OrbStack. On Linux, also add
   `--add-host=host.docker.internal:host-gateway` to the command, and make Ollama listen on more
   than the loopback (`OLLAMA_HOST=0.0.0.0`). For Ollama on another machine of the network, give
   its address, for example `http://gpu.lan:11434`.

The log shows `"ownKey":false` at startup: the runner has no key, and calls Ollama. A finished job
shows the model and `"costUsd":0`:

```json
{"level":"info","event":"job.finished",…,"outcome":"done","durationMs":332,"score":2,"model":"qwen3","costUsd":0}
```

## LM Studio, vLLM or llama.cpp on the network of the runner

These servers speak the API of OpenAI. As with Ollama, the model runs on your machine or on your
network: the service never calls the server, and the review shows a cost of 0. The runner calls it
at its own `PROVIDER_BASE_URL`.

1. Start the server so that it answers with a JSON schema and takes tool calls:

   | Server | Default URL | Start it with |
   | --- | --- | --- |
   | [LM Studio](https://lmstudio.ai/docs/developer/openai-compat) | `http://localhost:1234/v1` | `lms server start --bind 0.0.0.0`, and a model with native tool use (Qwen, Llama 3.1, Mistral) |
   | [vLLM](https://docs.vllm.ai/en/latest/features/tool_calling/) | `http://localhost:8000/v1` | `vllm serve <model> --enable-auto-tool-choice --tool-call-parser <parser of the model>` |
   | [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) | `http://localhost:9931/v1` | `llama-server -m <model.gguf> --jinja --host 0.0.0.0` |

   `--bind 0.0.0.0` and `--host 0.0.0.0` make the server listen on more than the loopback, for a
   runner in a container or on another machine. Without `--enable-auto-tool-choice`, vLLM takes no
   tool calls.
2. In Kentō, **Settings → Add a provider**, choose **LM Studio**, **vLLM** or **llama.cpp server**
   in **Provider**, then **Fill in the form**. The form keeps the key on the runner, and fills the
   name and the default URL. Name the models that the server loaded, for each level.
3. Start the runner with these lines in place of the three `PROVIDER_` lines of the command:

   ```sh
     -e PROVIDER_KIND=openai_compatible \
     -e PROVIDER_BASE_URL=http://host.docker.internal:1234/v1 \
   ```

   Add `-e PROVIDER_API_KEY=…` only when the server asks for a key (`--api-key` of vLLM and of
   llama.cpp, "Require Authentication" of LM Studio). Over `http://`, the key crosses the network
   in clear: keep the server on the machine of the runner or on a network that you trust.
   `host.docker.internal` works as for [Ollama](#ollama-on-the-machine-of-the-runner).

The runner takes the jobs of every provider of the organization that is `openai_compatible` with
"The key stays on the runner", and calls its own server for each. An `https://` URL with no key is
no local server: the runner then holds no provider of its own, as before.

## Update the runner

When the service moves to a newer release, the card shows the new version next to the runner's
version, for example "0.2.0 available". The command of the Runners screen always names the image
of the release of the service.

1. Pull the new image:

   ```sh
   docker pull ghcr.io/sakuga-software/kento-runner:<new version>
   ```

2. Remove the container, and keep the volume:

   ```sh
   docker rm -f kento-runner
   ```

   A job in progress stops, and the service queues it again once its lease ends, within 2
   minutes. To avoid that, wait until "Job in progress" on the card says "none".
3. Run your `docker run` command again with the new tag. The runner reads `runner.json` from the
   volume and does not register again. The card keeps its name and shows the new version.

The same steps change a variable of the runner, for example a new `PROVIDER_API_KEY`.

## Revoke a runner

1. On the card of the runner, click **Revoke…**, then **Revoke <name>**.

   The token of the runner stops working at its next call. Its job in progress goes back to the
   queue at once, for another runner, without counting as an attempt. The runner moves to
   **Revoked**.
2. On the machine, the runner logs `runner.token_refused` once, and then waits without calling the
   service until you stop it. Remove the container and its volume:

   ```sh
   docker rm -f kento-runner
   docker volume rm kento-runner-state
   ```

A revoked runner never comes back. To use the machine again, create a new token
([step 1](#1-create-the-runner-in-the-runners-screen)) and run its command. With the old volume
removed, the runner registers as a new runner.

A runner of the service ("Runner of the service" on its card) has no button. The operator revokes it
in the database ([DEPLOY.md](DEPLOY.md#5-revoke-a-runner)).

## Troubleshooting

Every line of `docker logs kento-runner` is one JSON object with `time`, `level` and `event`. The
runner removes its tokens and keys from every line.

### The registration token expired

The card in **Waiting tokens** says "Token expired" when no runner registered within the hour. A
token that a runner already used fails the same way.

On the machine, the runner logs this line once, then waits without calling the service until you
stop it:

```json
{"level":"error","event":"runner.registration_refused","error":"the service refused the registration token: it expired after one hour, was already used, or was cancelled. Create a new token on the Runners screen, then remove this container and start the command of the new token."}
```

1. On the card, click **New token**. The screen shows a new token and its command, with the same
   name, labels and key mode.
2. On the machine:

   ```sh
   docker rm -f kento-runner
   ```

3. Run the new command.

Check that the machine reaches the service in HTTPS:

```sh
curl -sS https://review.sakuga.dev/healthz
```

### `runner.token_refused` after `startup.ready`

The runner registered, then the service refused its token (401). The runner was revoked, or its
`runner.json` belongs to another service. The log shows these lines, then the runner waits until
you stop it:

```json
{"level":"info","event":"startup.ready",…}
{"level":"error","event":"runner.token_refused","error":"the service refused the runner token: the runner was revoked, or runner.json belongs to another service. Remove this container and its state volume, then register again with a new token from the Runners screen."}
```

Remove the container and the volume, then register again with a new token, as in
[Revoke a runner](#revoke-a-runner).

### The runner stops at startup

| Log | Cause |
| --- | --- |
| `startup.config_invalid` with `KENTO_URL must be an https:// URL` | `KENTO_URL` is missing, or is not `https://`. |
| `startup.config_invalid` with `PROVIDER_KIND must be one of openrouter, anthropic, openai_compatible, ollama` | A typo in `PROVIDER_KIND`. |
| `startup.config_invalid` with `PROVIDER_BASE_URL must be an https:// URL` | An `http://` URL for a provider other than Ollama and `openai_compatible`. |
| `startup.config_invalid` with `KENTO_RUNNER_LABELS must be at most 20 labels…` | A label with a space or another character. |
| `runner.stopped` with `no runner token in /var/lib/kento-runner/runner.json, and KENTO_REGISTRATION_TOKEN is not set: …` | The volume is new or missing, and the command has no registration token. Create a token and use its command. |

### The runner cannot reach the service

```json
{"level":"warn","event":"runner.claim_failed","error":"fetch failed","retryInMs":1000}
```

The runner tries again, waiting twice as long each time, up to one minute. It does not stop. Check
the DNS, the proxy and the firewall of the machine for outbound HTTPS to `review.sakuga.dev`. The
card goes from "Online" to "Late signal" after 90 s without a call, and to "Offline
for …" after one hour.

### The runner is "Online" but takes no job

A job waits in the queue until a runner can take it. Check, in this order:

- **Repos**: the repository is enabled. A push of a disabled repository creates no job.
- If the operator set a pool on the repository, the pool is one of the labels of the runner.
- The provider of the job matches the runner (see the table in [Key modes](#key-modes)). For
  example, an organization whose default provider is Anthropic with a key on the service does not
  give its jobs to an untrusted runner with an OpenRouter key.

### A job fails because its lease expired

The Dashboard shows the failure "the runner stopped answering during the job twice, last <runner>".

The runner holds a job with a lease of 2 minutes, and renews it with a heartbeat every 30 seconds.
When the heartbeats stop (the machine sleeps, the network goes down, someone stops the container),
the service queues the job again after the lease ends, and waits 30 seconds. After the second
expired lease, the job fails.

If the runner comes back during the job, its next heartbeat gets 409 and it drops the job:

```json
{"level":"warn","event":"job.lease_lost",…,"error":"heartbeat: the service answered 409 {\"error\":\"lease_lost\"}"}
{"level":"info","event":"job.finished",…,"outcome":"lost"}
```

Keep the machine awake, and keep the runner running during jobs. To review the pull request again,
an admin clicks "Run again at <level>" on the Dashboard, or anyone with write access
comments `@kento-review` on the pull request.

### A job fails with a model error

The job fails with the answer of the provider, in the log of the runner and on the Dashboard:

```json
{"level":"warn","event":"job.finished",…,"outcome":"failed","reason":"no model gave a usable answer: ProviderError: OpenRouter answered 401: {\"error\":{\"message\":\"User not found.\",\"code\":401}}"}
```

A 401 or 403 means that the provider refused `PROVIDER_API_KEY`. Replace it as in
[Update the runner](#update-the-runner). When the provider has "The key stays on the runner",
**Settings** shows "Refused on the runner" until a job with the new key succeeds.

With Ollama, `Ollama answered 404: {"error":"model 'qwen3' not found"}` names a model that the
server has not pulled, and `fetch failed` an address that the container cannot reach (see
[Ollama](#ollama-on-the-machine-of-the-runner)).

## Variables

The command of the Runners screen sets the first seven. A token of the screen fixes the name, the
labels and the trust, whatever `KENTO_RUNNER_NAME` and `KENTO_RUNNER_LABELS` say.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `KENTO_URL` | yes | | The service, `https://review.sakuga.dev`. HTTPS only (`http://127.0.0.1` or `http://localhost` for a local test). |
| `KENTO_REGISTRATION_TOKEN` | first start | | The token of the Runners screen. Read only while the volume has no `runner.json`. |
| `KENTO_RUNNER_NAME` | no | host name | Letters, digits, dots, dashes or underscores. |
| `KENTO_RUNNER_LABELS` | no | | Up to 20 labels, separated by commas. |
| `PROVIDER_KIND` | no | `openrouter` | `openrouter`, `anthropic`, `openai_compatible` or `ollama`. |
| `PROVIDER_BASE_URL` | no | the URL of the kind | HTTPS, except for Ollama and a local server (`openai_compatible` on `http://`). Required with `openai_compatible`. |
| `PROVIDER_API_KEY` | no | | The key of the runner. Ollama needs none, nor a local server that asks for none. |
| `KENTO_STATE_DIR` | no | `/var/lib/kento-runner` | Holds `runner.json`. |
| `KENTO_WORK_DIR` | no | `/tmp/kento-runner` | Where the jobs clone. |

[DEPLOY.md](DEPLOY.md#what-the-runner-does-with-the-code) describes what the runner does with the code, the leases and
the attempts.
