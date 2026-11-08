# $TENR flywheel

How Tenner's money is meant to feed back into $TENR: an access minimum, buyback and burn from outside revenue, and gift packs every 30 minutes. Decided with the founder on 2026-11-07. Every number below is a default that lives in the `flywheel` settings and can be changed in Admin.

> **Legal review first.** A random prize that needs a token purchase to enter can count as a lottery (prize, chance, consideration). Gift draws need counsel's sign-off, and probably a free way to enter, before they run with real money. This is on the [launch checklist](LAUNCH.md).

## The loop

```
trading fees ($CARDS → USDC) ──► Pulse drops + cashback + gift pool ──► users and attention
Pulse sales (half of what winners pay) ──► buyback and burn of $TENR                      │
            ▲                                                                     ▼
            └──────────── $TENR volume ◄── holding $TENR to use Tenner and win gifts
```

## 1. Access minimum

- **Rule:** a user must hold at least **0.1% of $TENR's current supply** (`accessBps: 10`) to act on Tenner.
- **Counted:** the user's connected wallet plus their Tenner trading wallet, added together.
- **Checked live** at the moment of each action, with no holding period. Supply is read live too (cached for 60 seconds), so burns lower the bar in tokens.
- **Gated actions:**
  - claiming a Pulse drop, including limit orders when they fire
  - opening Gacha packs
  - Market and Scanner buys, including auto-buy rules when they fire
  - claiming a gift
- **Not gated:** browsing everything, the tour, Portfolio, Wallet, selling back, listing, withdrawing. People must always be able to get their money and cards out.
- **When the check fails:** the action is refused with "Hold 0.1% of $TENR to buy", plus the shortfall and a link to buy. Limit orders and auto-buys wait instead of failing, and fire once the balance is there.
- **Modes:**
  - **Mainnet:** enforced.
  - **Devnet:** enforced only if `GEMDEX_TOKEN_MINT` is set.
  - **Paper (testing):** enforced against paper balances and a fixed 1B paper supply. The Rewards page faucet gives testers paper $TENR.
- **Where it lives:**
  - The rule is `accessFrom` in `packages/core/src/flywheel.ts`.
  - Reads go through a read-only module, `packages/venues/src/holdings.ts`: `getParsedTokenAccountsByOwner` per wallet, and `getTokenSupply` cached for 60 seconds. Paper reads paper balances against a 1B supply.
  - The gateway checks before a Pulse claim, a Market buy, a pack open and a gift claim (`accessRefusal` in `apps/gateway/src/server.ts`).
  - The worker checks before a limit order or an auto-buy fires (`mayBuy` in `apps/worker/src/access.ts`).
  - `/me` reports `access` (held, needed, ok), reusing a reading for up to 10 seconds. Buys always read fresh.
  - If the chain can't be read, the buy is refused with "try again in a moment" rather than let through.

## 2. Pulse sales → buyback and burn

- **Source: half of every dollar winners pay on Pulse** (`saleBuybackBps: 5000`), for revealed cards and sealed packs alike. The other half goes back into the drops pool, alongside its 50% share of trading fees and what Collector Crypt pays for cards nobody bought.
- **When it counts:** a revealed card's sale is final at settlement, so it's split there (`revenue` and `drops`). A sealed pack's payment waits in `drops` until the pack is delivered, so a pack that fails can still be refunded, then the buyback share moves to `revenue`. Paper stand-in buyers split the same way.
- **Where it sits:** `revenue` is held in the Drops wallet, where winners' payments land. Reconciliation counts it there.
- **Loop (`apps/worker/src/buyback.ts`, checked every minute, a run at most every 15 minutes):**
  1. If `revenue` holds at least $25 (`buybackMinUsd`) and there's a market, set it all aside (`revenue` → `buyback_inflight`).
  2. Swap it to $TENR through Jupiter from the Drops wallet, with a fresh quote each attempt and `buybackMaxSlippageBps` (1.5%) as the limit.
  3. Burn every $TENR the Drops wallet holds.
  4. Book the USDC as gone (`buyback_inflight` → `world`) and record the run: USDC in, $TENR bought, swap and burn signatures.
- **Each step resumes:** stages are PENDING → SWAPPED → DONE, every transaction goes through `sendOnce`. A swap that can't go through in 6 hours returns its money to `revenue` (SKIPPED).
- **Privy policy:** the Drops wallet needs Jupiter's swap and SPL Token `Burn` on the $TENR mint. On the [launch checklist](LAUNCH.md).
- **Price-blind:** it buys on the schedule whatever the price, never more than what has come in.
- **What this means for Pulse:** sales used to refill the drops pool in full. Now half comes back, so how often cards drop leans more on trading fees. Change the share in Admin → Treasury.

## 3. Gift packs every 30 minutes

### Funding
- **New split of trading fees:** cashback 30%, **gift pool 20%**, drops 50% (`giftBps: 2000`, taken from the drops share).
- The gift pool is a new ledger account, `gifts`, held on-chain by the Drops wallet like the Drops pool, so it doesn't need a new role.
- Reconciliation counts `drops + gifts` against that wallet.

### Prize
- Pack tiers match Collector Crypt machine prices: **$500, $250, $100, $50**.
- Each draw may spend up to **1/12 of the pool** (`giftSpendBps: 833`), so a pool with no new money lasts about six hours.
- The prize is the biggest tier that fits. The machine is an open CC machine at that price, preferring the drops `machineMix`, and the next tier down if none is open.
- **Rollover:** if even $50 doesn't fit, nobody wins that draw and the pot keeps growing. The page shows "rolling over".

### Who can win
The groups take turns, one per draw: **active → long holders → top blasters**. A group with nobody eligible passes to the next one; if all three are empty, the draw rolls over.

| Group | Must hold (live, at draw time) | Eligible if | Entries |
|---|---|---|---|
| Active | 0.1% | at least **10 packs in the past hour**: Gacha opens (`cc_packs` with `drop_id is null`) plus Pulse wins (`claims` won or settled) | one per pack in that hour |
| Long holders | **2%** | they hold 2% now | one per full day held at 2% or more without a break |
| Top blasters | **2%** | among the **top 10 by spend** over 7 days (packs + Pulse + Market) | one per $10 spent |

- **Hold streaks:** a loop every 10 minutes reads the live balances of users at or near 2% and stores `above_since`. It resets when someone drops under 2%. Live checks catch new holders, and the draw re-checks everyone.
- **Never eligible:**
  - Tenner's own role wallets, the trading pool and the bonding curve.
  - Any wallet in `excludedWallets`, which is where the team's wallets go.
  - Admins.
  - Anyone who won in the last 24 hours.

### Fair draws
1. At draw time the worker freezes the entry list, publishes its hash and the target Solana slot (current slot + 32), and stores the draw.
2. Once that slot exists, `seed = sha256(drawId + entriesHash + blockhash(slot))`. The winner is the entry the seed lands on, counting entries in order.
3. The draw, entries, seed and winner are public, so anyone can recompute the result. Paper mode uses a server seed instead and labels the draw "paper".

### Claiming
- The winner gets a notification and a **Claim** button. Claiming opens the pack through the normal Gacha flow, paid by `gifts`, with the card delivered to their connected wallet.
- The access minimum is checked again at claim time.
- The prize amount is set aside at the draw (`gifts` → `gift_reserved`). If it isn't claimed within 24 hours, it returns to the pool.

## 4. Public Treasury page (`/treasury`)

- Live pools: drops, cashback, gifts, revenue waiting for buyback.
- Recent draws: group, prize, winner (short wallet), entries and seed, plus a "verify" link.
- Buybacks and burns: USDC spent, $TENR burned, signatures, total burned, and supply now.
- The rules on this page, in plain words.

## 5. Data

| Table | Columns |
|---|---|
| `gift_draws` | id, at, group, prize, machine_code, state (`committed`, `drawn`, `claimed`, `expired`, `rolled`), entries (jsonb), entries_hash, target_slot, blockhash, seed, winner_user_id, winner_wallet, claim_memo, expires_at |
| `holder_streaks` | user_id, wallet_total, above_since, checked_at |
| `buybacks` | id, stage, usdc_in, tenr_out, swap_sig, burn_sig, created_at, updated_at |

The ledger gains four accounts: `gifts`, `gift_reserved`, `revenue` and `buyback_inflight`, all held in the Drops wallet.

## 6. Build order

1. Read supply and balances, plus the access check, wired into Pulse, Gacha, Market and auto-buys. UI: a hint on the Buy buttons when the user is short, and a banner.
2. The fee split with the gift pool, and the `flywheel` settings with their Admin editing.
3. Gift draws: eligibility, streaks, commit and reveal, claim, expiry, and the user notification.
4. Pulse sales into `revenue`, then the buyback and burn steps (chain ops plus paper versions).
5. The `/treasury` page.
6. Tests for each, plus a paper-mode run of the whole loop.

## Open items

- Legal review of the gift draws (above).
- How many wallets can ever pass the gate: at most 1,000 can hold 0.1% each.
