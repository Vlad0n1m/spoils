# Build from repository root: docker build -f apps/web/Dockerfile .
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile

FROM deps AS builder
ARG NEXT_PUBLIC_GAME_SERVER_URL=ws://localhost:2567
ARG NEXT_PUBLIC_SOLANA_RPC_URL=https://api.devnet.solana.com
ARG NEXT_PUBLIC_SOLANA_CLUSTER=devnet
ARG NEXT_PUBLIC_WALLET_DEV_TOPUP=0
ARG NEXT_PUBLIC_GUEST_PLAY=
ARG NEXT_PUBLIC_MARKET_CURRENCY=
ENV NEXT_PUBLIC_GAME_SERVER_URL=$NEXT_PUBLIC_GAME_SERVER_URL
ENV NEXT_PUBLIC_SOLANA_RPC_URL=$NEXT_PUBLIC_SOLANA_RPC_URL
ENV NEXT_PUBLIC_SOLANA_CLUSTER=$NEXT_PUBLIC_SOLANA_CLUSTER
ENV NEXT_PUBLIC_WALLET_DEV_TOPUP=$NEXT_PUBLIC_WALLET_DEV_TOPUP
ENV NEXT_PUBLIC_GUEST_PLAY=$NEXT_PUBLIC_GUEST_PLAY
ENV NEXT_PUBLIC_MARKET_CURRENCY=$NEXT_PUBLIC_MARKET_CURRENCY
# Build-time placeholder; runtime DATABASE_URL comes from Compose / orchestrator.
ENV DATABASE_URL=postgres://postgres:postgres@localhost:5432/extract
RUN pnpm --filter @extract/shared build && pnpm --filter web build

FROM deps AS migrate
WORKDIR /repo
# Fail migrate if Compose forgot to inject DATABASE_URL; --force avoids interactive prompts in headless containers.
ENV DRIZZLE_REQUIRE_DB=1
CMD ["pnpm", "--filter", "web", "run", "db:push:ci"]

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public
# Boot check: refuses to start in production without CRON_SECRET & co (names only, never values).
COPY --chown=nextjs:nodejs deploy/web-preflight.mjs ./deploy/web-preflight.mjs
USER nextjs
EXPOSE 3000
CMD ["sh", "-c", "node deploy/web-preflight.mjs && exec node apps/web/server.js"]
