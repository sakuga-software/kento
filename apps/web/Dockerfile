# syntax=docker/dockerfile:1
#
# Image of the Kentō web service (apps/web). Build it from the root of the repository, because the
# pnpm workspace and its lockfile live there:
#
#   docker build -f apps/web/Dockerfile --build-arg APP_COMMIT=$(git rev-parse HEAD) -t kento-web .
#
# The service runs its TypeScript source with `remix/node-tsx`, as Remix 3 recommends: there is no
# build step. It applies the pending migrations at startup (MIGRATE_ON_START, on by default).

ARG NODE_IMAGE=node:26-bookworm-slim

FROM ${NODE_IMAGE} AS deps
# The pnpm store is a BuildKit cache, which stays in the Docker daemon after the build.
# PNPM_CACHE_ID names it: the CI gives the pull requests a cache apart, so the build of a pull
# request does not write into the cache that a build of main reads.
ARG PNPM_CACHE_ID=pnpm-store
WORKDIR /repo
# The Node 25 and later images have no corepack: npm installs it. corepack installs the pnpm
# version of `packageManager` in the root package.json.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g corepack@latest && corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/engine/package.json packages/engine/
# The production dependencies of apps/web and of the workspace packages it uses (packages/protocol
# and packages/engine, which have none). No dev dependency.
RUN --mount=type=cache,id=${PNPM_CACHE_ID},target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @kento-review/web...

FROM ${NODE_IMAGE}
# The service runs with node alone. The npm of the base image only adds the vulnerabilities of its
# own dependencies: remove npm, npx and corepack.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY apps/web/package.json apps/web/tsconfig.json apps/web/server.ts ./apps/web/
COPY apps/web/app ./apps/web/app
COPY apps/web/drizzle ./apps/web/drizzle
# The stylesheet, the fonts and the script of the screens, served under /assets/.
COPY apps/web/public ./apps/web/public
# The messages of the runner API, shared with apps/runner. Node runs its TypeScript as is.
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src
# The engine renders the review that the publisher posts, in the format of the Action. The service
# never calls a model: the prompts stay out of the image.
COPY packages/engine/package.json ./packages/engine/
COPY packages/engine/src ./packages/engine/src

# The commit of the image, shown by /healthz. Dokploy can pass it as a build argument.
ARG APP_COMMIT=""
ENV APP_COMMIT=${APP_COMMIT}

USER node
WORKDIR /repo/apps/web
EXPOSE 3000

# Docker marks the container unhealthy when /healthz fails three times in a row, for example
# when the database is down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--import", "remix/node-tsx", "server.ts"]
