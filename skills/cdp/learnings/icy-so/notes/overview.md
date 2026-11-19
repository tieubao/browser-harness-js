# icy.so swap: end-to-end test

The swap UI (dwarvesf/foundation-apps `apps/icy-swap`, Worker `df-treasury-icy-swap`) moves real ICY on Base and pays real sats. Any change to it gets this test, run by the agent, before merge.

## Flow under test

```
connect wallet -> amount + BTC address -> approve ICY (ERC-20 tx)
  -> EIP-712 SwapRequest sign -> backend signature (/api/swap-signature)
  -> swap() on the swapper (tx) -> backend queues the BTC payout -> sats land
```

## Test kit

| Piece | Where |
|---|---|
| Base test wallet (key + address) | 1Password `op://Toolkit/icy-swap-test-wallet-base` |
| Bitcoin test address (raw hex key + bc1q address) | 1Password `op://Toolkit/icy-swap-test-wallet-btc` |
| Browser test | `learnings("icy-so", "run_swap_test", {url, amount, swap})` |
| Fund, preview upload, payout watch | ops-toolkit `experiments/explore-distill-replay/code/icy-swap-e2e/` |

## Run it

1. Upload a preview version from the PR branch (`preview-upload`). It never takes traffic.
2. Check the test wallet holds at least `amount` ICY and some ETH; top up with `fund` (from the FlipSuite burner).
3. `run_swap_test({url: <preview>, swap: false})` proves connect and approve. Add `swap: true` to submit the swap.
4. After a swap, `watch-btc` waits for the sats on the test address.

## Gotchas

- Minimum swap is 3 ICY. The service fee is 1% with a 3,000-sat floor, so 3 ICY pays out about 1,800 sats.
- The address textbox reads as personal data to the guard; the tool attaches with `allowSensitive` and `maskSensitive`.
- Rabby and other extension wallets need a human unlock; the injected "Test Wallet" avoids that and keeps keys out of the page.
- Before foundation-apps #442, the button stayed "Approve ICY" after approval until window focus; `secondsToSwapButton` now catches a regression.
- Preview URLs follow `https://<first 8 of version id>-df-treasury-icy-swap.infras.workers.dev`.
