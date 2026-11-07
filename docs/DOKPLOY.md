# Deploy Tenner on Dokploy (zero-downtime updates)

Tenner runs as three Dokploy **Applications** built from the one [`Dockerfile`](../Dockerfile), plus a Postgres database. Each application picks its part of the Dockerfile with **Docker Build Stage**:

| Dokploy service | Build stage | Port | Domain | What it does |
|---|---|---|---|---|
| **Database** `tenner-db` | PostgreSQL 17 | | none | Listings, drops, orders, the ledger, settings |
| **Application** `tenner-web` | `web` | 3010 | `tenner.trade` | The Next.js site |
| **Application** `tenner-gateway` | `gateway` | 4010 | `api.tenner.trade` | The API and the live stream (websocket) |
| **Application** `tenner-worker` | `worker` | none | none | Drops, Pulse prices, orders, chain sends, ingest |

## Why Applications and not one Compose service

On a Compose deploy, Docker stops the old containers and only then starts the new ones, so the site is down for the restart. A Dokploy Application runs as a Docker Swarm service, and Swarm can start the new version first and stop the old one only once the new one is healthy. The settings in step 5 turn that on.

### What happens on an update

1. **Build.** Dokploy builds the new image while the old version keeps serving. If the build fails, nothing changes.
2. **Start.** The new container starts next to the old one. Gateway and worker run the database migrations (they take turns through a Postgres lock).
3. **Health.** Swarm waits for the new container's health check:
   - **web** and **gateway** are healthy once they answer.
   - **worker**: only one worker may run the loops, because drops, Pulse prices and chain sends must never run twice. The new worker waits as a **standby** for the old one's Postgres lock, and its health check counts standby as healthy.
4. **Hand-over.** Swarm stops the old container:
   - **web** fails its health check and finishes open requests (3 seconds).
   - **gateway** fails its health check, keeps answering for 1.5 seconds, then closes live streams with code 1012. Browsers reconnect straight away and resume from their last event, so no drop or price update is missed. It exits within 9 seconds.
   - **worker** starts no new job runs, lets running ones finish (8 seconds at most), and releases the lock. The standby takes over within a quarter of a second. `pnpm handover` measured 136 ms.
5. **Open pages keep working.** Every web build has its own deployment id. A page from the previous build keeps loading its scripts from the shared static volume (step 6), and reloads into the new build on its next navigation.
6. **Rollback.** If the new version isn't healthy within a minute, Swarm puts the previous one back.

## Set up

1. **Database.** In your Dokploy project, choose **Create Service → Database → PostgreSQL**.
   - Name it `tenner-db`, image `postgres:17`, a long alphanumeric password. Deploy it.
   - Copy its **Internal Connection URL**. That is `DATABASE_URL` for the gateway and the worker.
   - In **Backups**, add an S3 destination and a daily schedule. Do one restore test before launch.
2. **Three applications.** Choose **Create Service → Application** three times: `tenner-web`, `tenner-gateway`, `tenner-worker`. For each:
   - **General:** provider GitHub, repository `haiderlikesrust/ten`, branch `main`.
   - **Build Type:** Dockerfile. **Dockerfile Path** `Dockerfile`, **Docker Context Path** `.`, **Docker Build Stage** `web`, `gateway` or `worker`.
3. **Environment.** Paste the matching block of [`deploy/dokploy.env.example`](../deploy/dokploy.env.example) into each application:
   - `tenner-web` has **Build-time Arguments** (the `NEXT_PUBLIC_` values, which are built into the site) and one runtime variable.
   - Keep `GEMDEX_MODE=paper` and `PAPER_OPEN_ADMIN=false` for the first deploy.
   - Secrets go in **Environment**, never in Build-time Arguments.
4. **Domains.** Point both names' DNS at the VPS first.
   - `tenner-web`: add `tenner.trade`, path `/`, container port **3010**, HTTPS with Let's Encrypt. For `www.tenner.trade`, add it the same way and a www-to-non-www redirect under **Advanced → Redirects**.
   - `tenner-gateway`, either way works:
     - **Path on the site's domain (live now, no extra DNS):** add `tenner.trade`, path `/gateway`, **Strip Path** on, container port **4010**, HTTPS. Then `NEXT_PUBLIC_GATEWAY_URL=https://tenner.trade/gateway`.
     - **Own subdomain:** add an A record for `api.tenner.trade`, then the domain `api.tenner.trade`, path `/`, container port **4010**, HTTPS. Then `NEXT_PUBLIC_GATEWAY_URL=https://api.tenner.trade`.
     - Websockets go through Traefik either way.
   - `tenner-worker`: no domain.
   - Before you own the domains, Dokploy's generated `traefik.me` domains work for testing. Set `NEXT_PUBLIC_GATEWAY_URL` and `WEB_ORIGIN` to match.
5. **Zero-downtime settings.** For each application, in **Advanced → Cluster Settings**:
   - **Replicas:** `1`. For the worker it must stay at 1; more replicas would only wait in standby.
   - **Swarm Settings → Update Config:**
     ```json
     { "Parallelism": 1, "Delay": 0, "FailureAction": "rollback", "Monitor": 60000000000, "MaxFailureRatio": 0, "Order": "start-first" }
     ```
   - **Swarm Settings → Rollback Config:**
     ```json
     { "Parallelism": 1, "Delay": 0, "FailureAction": "pause", "Monitor": 60000000000, "MaxFailureRatio": 0, "Order": "start-first" }
     ```
   - **Health Check:** the same checks are built into the image. Paste them anyway, so an update never starts without one. Durations are in nanoseconds (5000000000 = 5 s).
     - `tenner-web`:
       ```json
       { "Test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:3010/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"], "Interval": 5000000000, "Timeout": 3000000000, "StartPeriod": 60000000000, "Retries": 3 }
       ```
     - `tenner-gateway`:
       ```json
       { "Test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:4010/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"], "Interval": 5000000000, "Timeout": 3000000000, "StartPeriod": 60000000000, "Retries": 3 }
       ```
     - `tenner-worker`:
       ```json
       { "Test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:4020/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"], "Interval": 5000000000, "Timeout": 3000000000, "StartPeriod": 60000000000, "Retries": 3 }
       ```
6. **Shared static files** (`tenner-web` only). In **Advanced → Volumes**, add a **Volume Mount**: volume `tenner-web-static`, mount path `/app/apps/web/.next/static`.
   - Each new container adds its build's scripts and styles there, next to earlier builds'. Files no build has used for 30 days are removed.
   - Without it, updates still don't go down, but someone who opened a page just before an update may need to refresh when they next load more code.
   - Optional: a second volume `tenner-web-cache` at `/app/apps/web/.next/cache` keeps resized card photos across updates.
7. **Deploy** in this order: `tenner-db`, then `tenner-worker` and `tenner-gateway`, then `tenner-web`.
   - `https://tenner.trade/gateway/health` should show `"ok": true` and `"mode": "paper"`.
   - The worker's log shows `active: this worker holds the lock`.
   - The first start backfills listings and the card pool, so give drops a minute or two.
8. **Optional:** turn on **Autodeploy** on all three, so every push to `main` deploys the same way.

## Check an update yourself

Leave this running while you click **Deploy** on the gateway. It should print only `200`, with an occasional slower response during the hand-over:

```bash
while true; do curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://tenner.trade/gateway/meta; sleep 0.5; done
```

When you redeploy the worker, the new container's log shows `standby: another worker is running`, then `active: this worker holds the lock`. The old one logs `released the worker lock`.

Locally, `pnpm handover` runs the same hand-over against a temporary database, with no Docker needed.

## Rules that keep updates seamless

- **Database changes must be additive.** Add tables and columns; don't rename or drop them in the release whose code stops using them. During an update, and after a rollback, the other version runs against the new schema.
- **The worker stays at one replica.** A second one can't help: it only waits in standby.
- **Changing an environment variable needs a redeploy.** It goes through the same hand-over. `NEXT_PUBLIC_` values need a rebuild of `tenner-web`.
- **The static volume belongs to `tenner-web`.** Never mount `tenner-web-static` in another app.
- **Nothing here moves real money.** Devnet and mainnet need the steps in [`LAUNCH.md`](LAUNCH.md) first, and mainnet stays locked until `ALLOW_MAINNET` is set.

## Local check of the images

With Docker running:

```sh
docker build --target gateway -t tenner-gateway .
docker build --target worker -t tenner-worker .
docker build --target web -t tenner-web --build-arg NEXT_PUBLIC_GATEWAY_URL=http://localhost:4010 .
docker network create tenner-test
docker run -d --name tenner-db --network tenner-test -e POSTGRES_PASSWORD=localTestOnly postgres:17-alpine
docker run -d --name tenner-worker --network tenner-test -e DATABASE_URL=postgres://postgres:localTestOnly@tenner-db:5432/postgres tenner-worker
docker run -d --name tenner-gateway --network tenner-test -p 4010:4010 -e DATABASE_URL=postgres://postgres:localTestOnly@tenner-db:5432/postgres -e PAPER_OPEN_ADMIN=false tenner-gateway
docker run --rm --name tenner-web -p 3010:3010 tenner-web
```

Reference: [Dokploy zero downtime](https://docs.dokploy.com/docs/core/applications/zero-downtime), [Dokploy advanced settings](https://docs.dokploy.com/docs/core/applications/advanced), [Dokploy build types](https://docs.dokploy.com/docs/core/applications/build-type).
