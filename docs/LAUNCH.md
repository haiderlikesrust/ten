# Launch checklist

Everything here is for you to run. Nothing on this list has been done for you, and nothing in this repo has ever touched mainnet.

## 1. Before anything else

- [ ] Get a lawyer to review the packs, Pulse, cashback and token together. Replace the draft in `/terms`.
- [ ] Set `BLOCKED_COUNTRIES` from that advice. It reads a header set by Vercel or Cloudflare, and a VPN gets past it.
- [ ] Ask Collector Crypt on Discord for an API key, and whether buying packs and reselling them at a discount fits their terms.
- [ ] Run a real trademark check on the name. "Tenner" and $TENR had only a web search: no app, company or token was found using them, and tenner.trade, tenner.trading and tenner.cards were unregistered on 2026-11-07. Register the domains before announcing. Names live in `packages/core/src/brand.ts`.

## 2. Finish devnet

- [ ] Create a Privy app for devnet. Do not reuse it for mainnet.
- [ ] Turn on Server-side access and create an authorization key.
- [ ] Fill in `.env.local` from `.env.example`, with `GEMDEX_MODE=devnet`.
- [ ] Request 1 devnet SOL from https://faucet.solana.com for a test wallet, then USDC-Dev from https://spl-token-faucet.com/?token-name=USDC-Dev.
- [ ] Confirm the checks in the table below.

| Must confirm on devnet | Why it is not proven yet |
|---|---|
| Privy signs a transaction that already carries other signatures | Their docs mostly show `signAndSendTransaction`. Settlement needs three signers. |
| `altPlayerAddress` delivers to the connected wallet | Needs funded devnet USDC. CC documents it, but it has not been run. |
| A real pack through both drop types | Same. Everything else about it is tested. |
| Sign-in, one-click delegation and key export in a real browser wallet | Needs your Privy app. The code typechecks against their real types, but has never run. |
| Selling back a won card from the connected wallet | The wallet popup flow has the same gap. The USDC goes to the trading wallet and arrives through deposit sync. |

## 3. Trading wallet policy

Set this in Privy under Wallet infrastructure, then Policies. Default is deny.

| Allow | Limit |
|---|---|
| USDC `TransferChecked` to the Drops token account | Up to 100 USDC |
| USDC `TransferChecked` to the CC gacha token account | Up to your highest pack price |
| Program IDs: Memo, ComputeBudget, Associated Token, MPL Core, CC marketplace `CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr` | Instruction allowlist |

- Do **not** allow transfers to arbitrary addresses. Withdrawals are approved by the user in their own browser and never pass through the server.
- Privy Solana policies have no cumulative limits, so the worker enforces daily caps.
- CC builds its own pack transactions. Check that they contain no lookup tables, because address conditions can fail on those. The devnet pack transaction had none.

## 4. Treasury wallets

Each wallet is either a private key or a Privy server wallet. Set one of the two variables per wallet, and mix them as you like.

| Private key | Or Privy wallet | Wallet | Holds |
|---|---|---|---|
| `TREASURY_KEY_DROPS` | `PRIVY_WALLET_DROPS` | Drops | A capped float of USDC |
| `TREASURY_KEY_VAULT` | `PRIVY_WALLET_VAULT` | Vault | Revealed cards while listed |
| `TREASURY_KEY_CASHBACK` | `PRIVY_WALLET_CASHBACK` | Cashback | The cashback pool |
| `TREASURY_KEY_FEE` | `PRIVY_WALLET_FEE` | Fee | $CARDS, swept every run |
| `TREASURY_KEY_FEE_PAYER` | `PRIVY_WALLET_FEE_PAYER` | Fee Payer | SOL only |

- **Private key:** the base58 string a wallet exports (Phantom's "Show private key"), or a `solana-keygen` file's `[1,2,...]` array. Make a new wallet for each role; never reuse your personal one.
- **Privy wallet:** `walletId:address`, from the Privy dashboard.
- Only the worker gets these. The gateway and the site never sign.
- Privy is still required on mainnet either way, because users' trading wallets sign through it.
- At startup the worker logs each wallet's address and how it signs, never the key. Check that line after every change.

**What a private key gives up.** A Privy wallet only signs what its policy allows (sections 3 and 8). A private key signs anything, so anyone who can read the worker's environment (a Dokploy login, a server breach, a leaked backup) can empty that wallet at once. The worker's own limits still apply: the daily cap, the wallet floor, the kill switch and arming. If you use private keys:

- [ ] Keep only a working float in Drops and Cashback, and sweep the rest to a Squads multisig often.
- [ ] Give Dokploy access to as few people as possible, with two-factor sign-in.
- [ ] Back each key up offline. Losing the server without a backup loses the wallet.
- [ ] If a key may have leaked, turn on the kill switch, move the funds to a new wallet, and replace the variable.

Keep long-term funds in a Squads multisig, not in these.

## 5. Launch the token

- [ ] Open pump.fun's launch screen and **check that $CARDS is listed as a Custom Pair** before doing anything. The only source I found is a DefiLlama PR. The pairing is permanent.
- [ ] Note the creator fee range the screen offers. Sources disagree (0.05-1% in pump's FAQ, 0.01-3% elsewhere).
- [ ] Launch so the creator is the Fee wallet. With `TREASURY_KEY_FEE`, import that key into Phantom and launch from pump.fun's site as usual. With a Privy Fee wallet, confirm first that the launch can be signed from it. If you want a Squads creator, the worker cannot sweep from it automatically, so you would move $CARDS to the Fee wallet by hand.
- [ ] Do not turn on pump.fun fee sharing. It breaks these collect instructions, and the worker halts if it sees it.
- [ ] Set `GEMDEX_TOKEN_MINT`, and update `tokenTicker` in `brand.ts`.

## 6. First mainnet run

Use a new database and a separate Privy app.

- [ ] `GEMDEX_MODE=mainnet`, plus `SOLANA_RPC_URL`, `SESSION_SECRET`, `ADMIN_WALLETS`, `JUPITER_API_KEY`, `CC_API_KEY`, `NEXT_PUBLIC_SOLANA_RPC`.
- [ ] `ALLOW_MAINNET=I_UNDERSTAND_THIS_MOVES_REAL_MONEY`. Nothing starts without it.
- [ ] Set tight limits in Admin first: daily cap $50, one cheap machine, wallet floor near zero.
- [ ] Two different admins each POST `/admin/arm` within 15 minutes. The arm lasts 2 hours, then signing stops by itself.

**Canary, in order, watching Admin the whole time:**

1. Fund Drops with $100, Cashback with $20, and Fee Payer with 0.2 SOL.
2. Open one pack as a normal user.
3. Let one revealed drop go unsold, and confirm the Vault sells it back.
4. Buy one revealed card on Pulse, and confirm the card reaches the connected wallet.
5. Buy one hidden card on Pulse.
6. Wait for a small fee run. **This is the first real test of `collect_creator_fee_v2`, the Jupiter swap, and the split.**
7. Confirm Reconciliation says "Books match".

Stop at the first thing that looks wrong. The kill switch is at the top of Admin.

## 7. Deploy

Tenner runs on Dokploy: see [DOKPLOY.md](DOKPLOY.md).

| Piece | Notes |
|---|---|
| Web | `NEXT_PUBLIC_GATEWAY_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_PRIVY_SIGNER_ID`, `NEXT_PUBLIC_USDC_MINT` |
| Gateway | Set `WEB_ORIGIN` to your site, so CORS is not open. Holds no signing keys. On devnet and mainnet it needs `SOLANA_RPC_URL` and `GEMDEX_TOKEN_MINT` to read $TENR balances for the access minimum. |
| Worker | One instance. It alone holds Privy secrets and any `TREASURY_KEY_*`. |
| Database | Managed Postgres. Backups on. |

## 8. The $TENR flywheel

See [FLYWHEEL.md](FLYWHEEL.md).

- [ ] **Legal review of gift draws.** A random prize that needs a token purchase to enter can be a lottery. Get counsel's sign-off, and add a free way to enter if they require one, before draws run with real money. Until then, keep `giftsEnabled` off on mainnet in Admin → Flywheel.
- [ ] Put the team's wallets in Admin → Flywheel → "Wallets that can never win".
- [ ] If Drops is a Privy wallet, its policy must allow Jupiter's swap program and SPL Token `Burn` on the $TENR mint (buyback and burn of Pulse sales). A private-key Drops wallet needs nothing here.
- [ ] Check the access minimum on devnet with a wallet just under and just over 0.1% of supply.

A public paper demo must set `PAPER_OPEN_ADMIN=false`, or anyone can open Admin.

## Known limits

- Bots will win many drops. You chose first click. The levers are the win cooldown, machine mix and price band in Admin.
- A revealed drop priced below the buyback value is instant profit for whoever wins it. See the plan for the numbers.
- New listings can lag up to 30s, because CC caches that endpoint. A Helius webhook on the marketplace program would close the gap.
- Sales history starts from your launch date. CC publishes none.
