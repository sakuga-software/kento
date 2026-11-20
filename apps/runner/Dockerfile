# syntax=docker/dockerfile:1
#
# Image of the Kentō runner (apps/runner): ghcr.io/sakuga-software/kento-runner. Build it from the
# root of the repository, because the pnpm workspace and its lockfile live there:
#
#   docker build -f apps/runner/Dockerfile --build-arg APP_COMMIT=$(git rev-parse HEAD) -t kento-runner .
#
# Node runs the TypeScript source as is: there is no build step. The runner, the engine
# (packages/engine) and the protocol (packages/protocol) have no npm dependency; pnpm only links
# the workspace packages.

ARG NODE_IMAGE=node:26-bookworm-slim

FROM ${NODE_IMAGE} AS deps
# The pnpm store is a BuildKit cache, which stays in the Docker daemon after the build.
# PNPM_CACHE_ID names it: the CI gives the pull requests a cache apart, so the build of a pull
# request does not write into the cache that a build of main reads.
ARG PNPM_CACHE_ID=pnpm-store
WORKDIR /repo
# The Node 25 and later images have no corepack: npm installs it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@latest && corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/runner/package.json apps/runner/
COPY packages/engine/package.json packages/engine/
COPY packages/protocol/package.json packages/protocol/
RUN --mount=type=cache,id=${PNPM_CACHE_ID},target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @kento/runner...

FROM ${NODE_IMAGE}
# The runner runs with node and git alone. The npm of the base image only adds the vulnerabilities
# of its own dependencies: remove npm, npx and corepack.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# git reads the pull request; ca-certificates lets it and Node speak HTTPS. Nothing else: the runner
# never builds or runs the code of a pull request.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    KENTO_STATE_DIR=/var/lib/kento-runner \
    KENTO_WORK_DIR=/tmp/kento-runner
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/runner/node_modules ./apps/runner/node_modules
COPY packages/engine/package.json ./packages/engine/
COPY packages/engine/src ./packages/engine/src
COPY packages/engine/prompts ./packages/engine/prompts
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src
COPY apps/runner/package.json ./apps/runner/
COPY apps/runner/src ./apps/runner/src

# The state directory keeps runner.json (the runner token) across restarts: mount a volume on it.
RUN mkdir -p /var/lib/kento-runner && chown node:node /var/lib/kento-runner
VOLUME /var/lib/kento-runner

ARG APP_COMMIT=""
ENV APP_COMMIT=${APP_COMMIT}
LABEL org.opencontainers.image.source="https://github.com/sakuga-software/kento" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.description="Kentō runner: claims review jobs from a Kentō service"

USER node
WORKDIR /repo/apps/runner
CMD ["node", "src/main.ts"]
