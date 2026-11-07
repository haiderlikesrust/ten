#!/bin/sh
# Entrypoint of the web stage: publish this build's static files, then run Next as PID 1 so it
# receives the stop signal and drains (apps/web/src/instrumentation.ts).
set -e
cd /app/apps/web
NEXT_DEPLOYMENT_ID="$(cat .next/DEPLOYMENT_ID)"
export NEXT_DEPLOYMENT_ID
node /app/deploy/publish-static.mjs
exec node node_modules/next/dist/bin/next start --hostname 0.0.0.0 --port "${PORT:-3010}"
