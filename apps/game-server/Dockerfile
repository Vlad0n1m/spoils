# Build from repository root: docker build -f apps/game-server/Dockerfile .
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
# @colyseus/uwebsockets-transport installs uWebSockets.js via git; slim image has no git.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared ./packages/shared
COPY apps/game-server ./apps/game-server
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @extract/shared build
RUN pnpm --filter game-server build
RUN pnpm --filter game-server deploy /out --prod --legacy

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/ .
# Not root (security audit): the game server parses untrusted traffic and writes nothing to disk.
USER node
EXPOSE 2567
CMD ["node", "dist/index.js"]
