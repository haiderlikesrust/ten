# syntax=docker/dockerfile:1
# Tenner: one Dockerfile, three Dokploy applications. Each one picks its stage with "Docker Build Stage":
#   web      the Next.js site, port 3010
#   gateway  the API and the live stream, port 4010
#   worker   drops, Pulse, orders and chain sends; no port, and only one runs its loops at a time
# All three update start-first: the new container is healthy before the old one stops (docs/DOKPLOY.md).
FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1 CI=true
RUN npm install -g pnpm@10.11.0 --no-audit --no-fund
WORKDIR /app

# Packages first, from the lockfile alone, so a code change doesn't download them again.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline

FROM deps AS web-build
# NEXT_PUBLIC_ values are built into the site's scripts. Set them as Build-time Arguments in Dokploy.
ARG NEXT_PUBLIC_GATEWAY_URL
ARG NEXT_PUBLIC_PRIVY_APP_ID
ARG NEXT_PUBLIC_PRIVY_SIGNER_ID
ARG NEXT_PUBLIC_SOLANA_RPC
ARG NEXT_PUBLIC_USDC_MINT
# A new id per build: a browser still on the previous build reloads on its next navigation instead of
# mixing old and new code. Pass the commit as DEPLOYMENT_ID if you like; the build time is the fallback.
ARG DEPLOYMENT_ID
ENV NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL \
    NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID \
    NEXT_PUBLIC_PRIVY_SIGNER_ID=$NEXT_PUBLIC_PRIVY_SIGNER_ID \
    NEXT_PUBLIC_SOLANA_RPC=$NEXT_PUBLIC_SOLANA_RPC \
    NEXT_PUBLIC_USDC_MINT=$NEXT_PUBLIC_USDC_MINT
WORKDIR /app/apps/web
RUN id="${DEPLOYMENT_ID:-$(date +%s)}" \
 && NEXT_DEPLOYMENT_ID="$id" node node_modules/next/dist/bin/next build \
 && echo "$id" > .next/DEPLOYMENT_ID \
 && rm -rf .next/cache \
 && mv .next/static static-build

FROM deps AS gateway
# TRUST_PROXY: Traefik is the only way in, so its X-Forwarded-For is the visitor's real address.
ENV NODE_ENV=production GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=4010 DRAIN_DELAY_MS=1500 TRUST_PROXY=true
USER node
EXPOSE 4010
HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4010/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Node itself is PID 1, so it receives the stop signal and drains (apps/gateway/src/index.ts).
CMD ["node", "--import", "tsx", "apps/gateway/src/index.ts"]

FROM deps AS worker
ENV NODE_ENV=production WORKER_HEALTH_PORT=4020
USER node
# Healthy includes "standby": during an update the new worker waits for the old one to hand over.
HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4020/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "apps/worker/src/index.ts"]

FROM deps AS web
COPY --from=web-build /app/apps/web/.next ./apps/web/.next
COPY --from=web-build /app/apps/web/static-build ./apps/web/static-build
# .next/static is filled at start (deploy/publish-static.mjs); a Dokploy volume there keeps earlier
# builds' files. .next/cache holds resized card photos.
RUN mkdir -p apps/web/.next/static apps/web/.next/cache && chown -R node:node apps/web/.next
ENV NODE_ENV=production PORT=3010 NEXT_MANUAL_SIG_HANDLE=true DRAIN_DELAY_MS=3000
USER node
EXPOSE 3010
HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3010/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["sh", "deploy/web-start.sh"]
