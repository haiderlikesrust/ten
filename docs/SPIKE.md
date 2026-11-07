# Devnet spike results

Scripts live in `tools/spike`. All of them are read-only or devnet-only.

| Question | Result | Evidence |
|---|---|---|
| Can a CC card and USDC move in one atomic transaction? | **Yes.** 12 of 12 simulations passed (6 mainnet cards, 6 devnet cards). | `02-simulate-settlement.ts` |
| Do royalty rules block it? | **No.** CC Core cards carry no Royalties plugin, so the marketplace fallback is not needed. | Same |
| Size and compute | 587 bytes and about 19k compute units with 2 signers. A third signer adds about 96 bytes. | Same |
| What does a pack transaction look like? | Legacy, no lookup tables, CC is the fee payer, buyer signs second. Contains ComputeBudget, memo `<prefix>-<uuid>:open`, and one USDC TransferChecked. | `01-decode-pack.ts` |
| Does `altPlayerAddress` leak on-chain? | **No.** It is not in the transaction. The recipient is held by CC. | Same |
| Which USDC does CC devnet use? | `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr` (USDC-Dev from spl-token-faucet). | Same |

## Pump fee collection

`tools/spike/03-simulate-pump.ts` simulates both collect instructions against the live programs. Nothing is sent.

| Check | Result |
|---|---|
| Discriminators | Computed with the Anchor rule. Two known values matched, so `collect_creator_fee_v2` (207,17,138,242,4,34,19,56) is trustworthy. |
| Recognized by the programs | **Yes.** Logs show `Instruction: CollectCreatorFeeV2` and `Instruction: CollectCoinCreatorFee`. |
| Account order | Passes validation up to the point where the vault is checked. |
| $CARDS token program | Plain SPL Token. |

Both simulations then fail, as expected, because a random address has no fee vault. **So a real collection is still unproven.** That first happens in the mainnet canary.

This found a real bug: each program fails if its vault does not exist, and one failure sinks the whole transaction. Collection now includes only the side whose vault exists.

## Found along the way

- Every CC card has a `permanentFreezeDelegate` plugin, so CC can freeze a card. Settlement must treat a frozen card as a void, not a retry.
- Some cards also carry a `transferDelegate` plugin. A stale listing delegate does not block the owner.
- CC's published treasury address is a program-derived address, so it cannot be used as a fee payer in simulations.

## Still open

**Live delivery through `altPlayerAddress` has not been run.** It needs USDC-Dev, and the faucet needs a SOL fee payer. Devnet RPC airdrops are closed, and faucet.solana.com has a CAPTCHA, which has to be done by a person. CC's docs state the behaviour, and the hidden-drop design does not depend on who can call `openPack`.

To finish it, request 1 devnet SOL for a throwaway address at https://faucet.solana.com, then run the live check in milestone 6.
