FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile --filter @ledger/api...

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/ ./
COPY apps/api/ ./apps/api/
RUN pnpm --filter @ledger/api run build

FROM base AS prod
WORKDIR /app
COPY --from=deps /app/ ./
RUN pnpm deploy --filter @ledger/api --prod --legacy /prod

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod /prod/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/migrations ./migrations
COPY apps/api/package.json ./
EXPOSE 4000
CMD ["node", "dist/index.js"]
