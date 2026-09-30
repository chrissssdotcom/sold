# syntax=docker/dockerfile:1.7
# One codebase, two deployables (Section 8A.3): build once, run as `web` or `worker`.
#   docker build --target web    -t sold-web    .
#   docker build --target worker -t sold-worker .
# The image is built ONCE per commit and the same digest is promoted dev -> stage -> prod (Section 8C.6).

ARG NODE_VERSION=22

# ---- deps + build -----------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# `pnpm fetch` needs only the lockfile, so this layer caches until dependencies change.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

COPY . .
# The whole workspace, not just @sold/web: the build imports the configured extensions (extensions/*), which have
# their own dependencies, and `sold.config.ts` at the root resolves @sold/core. A filtered install would not link them.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile

# Identifies the build; must match at runtime so every replica of a release shares one cache namespace.
ARG SOLD_BUILD_ID=dev
ENV SOLD_BUILD_ID=$SOLD_BUILD_ID
# All replicas of a release must decrypt each other's Server Function payloads. Supplied by CI as a BuildKit secret.
RUN --mount=type=secret,id=next_actions_key,required=false \
    if [ -f /run/secrets/next_actions_key ]; then export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/next_actions_key)"; fi; \
    pnpm --filter @sold/web build

# ---- web --------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS web
ARG SOLD_BUILD_ID=dev
ARG SOLD_VERSION=0.0.0+dev.0
LABEL org.opencontainers.image.title="sold-web" org.opencontainers.image.version=$SOLD_VERSION
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 SOLD_ROLE=web SOLD_BUILD_ID=$SOLD_BUILD_ID SOLD_VERSION=$SOLD_VERSION \
    PORT=3000 HOSTNAME=0.0.0.0 NEXT_MANUAL_SIG_HANDLE=true
WORKDIR /app
# Stateless: nothing is written to local disk at runtime (scale gate d), so the filesystem can be read-only.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# ---- worker -----------------------------------------------------------------
# The worker is a single self-contained bundle: no node_modules, no Next.
FROM node:${NODE_VERSION}-bookworm-slim AS worker
ARG SOLD_BUILD_ID=dev
ARG SOLD_VERSION=0.0.0+dev.0
LABEL org.opencontainers.image.title="sold-worker" org.opencontainers.image.version=$SOLD_VERSION
ENV NODE_ENV=production SOLD_ROLE=worker SOLD_BUILD_ID=$SOLD_BUILD_ID SOLD_VERSION=$SOLD_VERSION WORKER_PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.generated/worker.cjs ./worker.cjs
USER node
EXPOSE 3001
CMD ["node", "worker.cjs"]
