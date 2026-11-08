# Tenner

A trading terminal for Collector Crypt graded cards, with live-priced cards funded by token creator fees.

- **Pulse:** a real pulled card opens at its insured value with a live price chart for 5 minutes. Most cards run up, then simmer or crash 60-90%. Some keep climbing. The first click on Buy pays that price and gets the card
- **Scanner:** live new listings, cards below insured value and fresh pulls
- **Gacha Desk, Market, Portfolio, Tracker, Rewards, Admin**

## Run it

```bash
pnpm install
```

```bash
pnpm dev
```

Then open http://localhost:3010. No accounts, keys or Docker needed.

This runs in **paper mode**: live Collector Crypt prices, cards and odds, with simulated money. You start with $500.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Postgres, gateway, worker and web together |
| `pnpm test` | All tests, on a real throwaway Postgres |
| `pnpm smoke` | Boots the real backend against live data and checks the main paths |
| `pnpm handover` | Checks the zero-downtime update hand-over: a standby worker taking over, and the gateway draining |
| `pnpm typecheck` | Types across every package |
| `pnpm verify` | All of the above plus both production builds. Run this before shipping, because bundling problems pass both types and tests. |

`LIVE=1 pnpm test` adds read-only simulations against real chains. They send nothing.

## How it fits together

```
apps/web         Next.js UI, holds no secrets
apps/gateway     REST and WebSocket, decides who wins a drop, never signs
apps/worker      Drop lifecycle, all signing, data ingest, fee pipeline
packages/core    Pricing, budget, state machines (pure)
packages/db      Schema, ledger, orders
packages/venues  paper / devnet / mainnet behind one interface
```

Business logic only ever talks to a `Venue`, so paper mode runs the same drop, order and fee code that moves real money.

## Rules worth knowing

- All money is integer micro-USDC.
- `sendOnce` in `apps/worker/src/chain-tx.ts` is the only way to send a transaction. It saves signed bytes first, so a retry can never double-send.
- `packages/venues/src/solana.ts` is the only file allowed to touch a chain. A test enforces that.
- The ledger is double-entry, and the database itself refuses a negative balance.

## Deploy

See [docs/DOKPLOY.md](docs/DOKPLOY.md): three Dokploy applications from one Dockerfile, updated start-first so the site never goes down.

## Going live

See [docs/LAUNCH.md](docs/LAUNCH.md). Mainnet is locked behind an env flag, a genesis check, and an admin arm that expires after 2 hours. [docs/SPIKE.md](docs/SPIKE.md) records what has been proven against real chains and what has not.
