# Verification -- icy-so swap test learning

New learning `icy-so` with node tool `run_swap_test`: an end-to-end test of the icy-swap UI using a throwaway test wallet from 1Password, signing through `cast`.

## Green run
```
Command: runSwapTest(ctx, { url: 'https://icy.so/', amount: '3', swap: true, timeoutSec: 150 })
Exit: ok
Output:
  steps.addressFilled=true, firstButton="Swap 3 ICY for Bitcoin"
  log: eth_signTypedData_v4, eth_sendTransaction, tx swapper 0x2afa8252…80283131
  latestSwap: "3 ICY→1,838 sats QUEUED 8 seconds ago"
  swap receipt status=0x1; test wallet ICY 3 -> 0
Verdict: PASS (live production swap through the tool)
```

## Connect path (fresh origin)
```
Command: runSwapTest(ctx, { url: 'https://icy.so/', amount: '3', swap: false, timeoutSec: 60 })
Output: {"connected":true,"firstButton":"Amount exceeds your balance"}
Verdict: PASS (explicit Connect Wallet -> Test Wallet; 0-ICY wallet shows the balance guard)
```

## Negative control
```
Before the explicit connect step, the same call returned {"connected":false,"firstButton":""}:
wagmi only auto-reconnects on an origin that connected before.
Verdict: RED as expected; restored by the connect step above.
```

## Approve path (via the learnings runner shape, no sensitive grant)
```
Command: runSwapTest(ctx, { url: 'https://icy.so/', amount: '3', swap: false, timeoutSec: 120 })
Output: connected=true, addressFilled=true, firstButton="Approve ICY",
  approveTx=0xabad883b…ad4626f0, buttonAfterApprove="Swap 3 ICY for Bitcoin", secondsToSwapButton=2
Verdict: PASS (address set by native setter + input event; React accepted it; #442 refetch confirmed on production)
```

## Not proven
- A run on a Worker version preview through `learnings()` after this change (previews were exercised by the session-local bridge earlier).
