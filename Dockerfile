# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/workflow-postgres ./packages/workflow-postgres
RUN npm ci

FROM dependencies AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ARG EVE_WORKFLOW_PROVIDER=default
RUN EVE_WORKFLOW_PROVIDER="$EVE_WORKFLOW_PROVIDER" npm run build:local

FROM build AS production-artifacts
# Turbopack's build cache is for future builds, not for serving this artifact.
RUN find .next/cache -mindepth 1 -delete

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-artifacts --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/.eve ./.eve
COPY --from=build --chown=node:node /app/agent ./agent
COPY --from=build --chown=node:node /app/lib ./lib
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/next.config.ts /app/tsconfig.json /app/app.config.ts ./
RUN mkdir -p /app/.data /app/.eve /app/.backup && chown -R node:node /app/.data /app/.eve /app/.backup
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/start-local.mjs"]
