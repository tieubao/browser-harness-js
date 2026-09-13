# alchemy-dashboard

The Alchemy dashboard reads its own numbers from a tRPC API at `https://app-api.alchemy.com/trpc/`.
This registry exists because the free plan's `@alchemy/cli` refuses `--group-by` and `--filters`, so
there is no CLI route to per-app, per-method or per-network usage. The dashboard's tRPC is the only
source, and the questions it answers ("which app burned the compute units", "which RPC method", "which
chain") are the ones a billing spike raises.

```js
await learnings("alchemy-dashboard")
await learnings("alchemy-dashboard", "apps")                       // { sid: name }
await learnings("alchemy-dashboard", "usageBreakdown", { groupBy: "appId", start, end })
await learnings("alchemy-dashboard", "summarize", { series })      // { key: total }
await learnings("alchemy-dashboard", "captureAuth", { force: true })
```

`start` and `end` are ISO UTC strings. `groupBy` is `appId`, `method` or `network`. The shell entry
that prints these as tables is ops-toolkit
`experiments/explore-distill-replay/code/alchemy-dashboard/`.

## Gotchas

- **Cookies are not enough.** The API authorizes on an `Authorization: Bearer` header. A
  `credentials: "include"` replay from the same logged-in tab returns 401. `captureAuth` sniffs the
  header off a live request: subscribe to `Network.requestWillBeSent`, `Page.reload`, take the first
  `app-api.alchemy.com/trpc` request that carries the header.
- **The header is short-lived.** A capture reused about 5 minutes later returned
  `Invalid or expired auth token`; reused 100 seconds later it still worked. Capture per run. On a
  401 the tools raise and drop the cached header, so the next call sniffs afresh. They never retry:
  a retry replays the same dead header, and a silent re-capture would hide a signed-out tab.
- **The page fetch needs an `AbortController`.** A page-side fetch under `awaitPromise` with no
  timeout wedges the whole REPL; recover with `browser-harness-js --restart` then `harness-connect`.
  The timeout here is 45s because the first breakdown after a reload has taken over 20s.
- **`apps.getApps` carries live API keys.** Every app object holds an `authToken`. The `apps` tool
  returns `sid` to name only, so no credential leaves the page.
- **Errors are masked, aggressively.** Every string leaving the module through an `Error` passes a
  mask that rewrites a Bearer value and any 32-plus-character opaque run as `first4…last4`. It also
  catches long procedure names (`usage.getB…ries`), which is deliberate: over-masking an error is
  cheaper than leaking a token through a stack trace.
- **The daily series lags.** Queried on 2026-09-13 with `end` set to now, the last bucket was
  2026-09-12. Treat the final bucket as partial or missing and reconcile against the dashboard's own
  Total Usage rather than expecting an exact match on today.
- **The REPL is a persistent server.** Shell env vars never reach a snippet, and its stdout is
  unreliable for long JSON: pass parameters through a file and write results to a file.
- Procedure names, if they ever change: re-sniff with `performance.getEntriesByType("resource")` in
  the page, filtered to fetch initiators, or watch `Network.requestWillBeSent` across a reload.
- A `usageBreakdown` call sends two requests for one query, a CORS preflight `OPTIONS` and the `GET`.
  That pair is not a retry.

## Verification (2026-09-13, live tab, `dashboard.alchemy.com/usage`)

Green run, window `2026-09-01T00:00:00.000Z` to now:

```js
await learnings("alchemy-dashboard", "apps")
await learnings("alchemy-dashboard", "usageBreakdown", { groupBy: "appId", start, end })
await learnings("alchemy-dashboard", "summarize", { series })
```

| Check | Observed |
|---|---|
| `apps` | 3 apps: `dfoundation`, `mochi-dev`, `mochi-prod` |
| `appId` totals | mochi-prod 29,729,992; dfoundation 600,462 |
| `method` totals | `alchemy_getAssetTransfers` 20,326,320; `getSignaturesForAddress` 8,896,320; `eth_call` 794,534 |
| `network` totals | `BASE_MAINNET` 21,165,752; `SOLANA_MAINNET` 8,980,220; `ETH_MAINNET` 182,802 |
| Cross-check | all three dimensions sum to 30,330,454 |
| Buckets | 12 daily rows, first 2026-09-01, last 2026-09-12 |
| Keys | the `appId` keys are exactly the `sid` values `apps` returned |

Negative control, the captured header with its last character flipped:

| Check | Observed |
|---|---|
| Outcome | `usageBreakdown` raised `usage.getB…ries 401: {"error":{"message":"Invalid or expired auth token." ...}}` |
| Retries | none; requests seen were one `GET` plus its `OPTIONS` preflight |
| Cached header | untouched, because the bad value was supplied by the caller |

## Provenance

2026-09-13 mochi CU-burn investigation (console-labs
`docs/investigations/2026-09-13-alchemy-cu-burn-mochi-payment.md`): the question was which app and
which RPC method burned 29.7M compute units in twelve days. Driven by hand first as scratch REPL
snippets (a header sniffer, a one-call-per-run fetcher, a Performance API lister), then distilled
here. Related: `[[browser-harness-connect-via-harness-connect]]`, `[[browser-harness-js-priority]]`.
