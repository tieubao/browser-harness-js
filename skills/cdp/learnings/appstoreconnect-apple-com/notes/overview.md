# appstoreconnect-apple-com

App Store Connect's React app calls the same `/iris/v1` (and `/iris/v2`) JSON:API it renders from,
authenticated by the session cookie instead of a token. This registry exists because the removal
flow needed about fifteen hand-written one-off scripts across one session before the working
recipe held; port that recipe here so it does not get re-derived.

```js
await learnings("appstoreconnect-apple-com")
await learnings("appstoreconnect-apple-com", "status")
await learnings("appstoreconnect-apple-com", "inventory")
await learnings("appstoreconnect-apple-com", "appState", { id: "1671424812" })
await learnings("appstoreconnect-apple-com", "agreements")
```

`takeOffSale`, `clearFutureTerritories`, and `removeApp` are WRITE tools. They change live App
Store listings. Call them only when the task calls for the change, never to test the learning.

## Gotchas (learned porting the removal flow)

The page only says "This app is unable to be removed right now." The real reason sits in the
PATCH response body, not the UI: `STATE_ERROR.CANNOT_REMOVE_WITH_APP_STORE_AVAILABILITY`. Capture
the failing response before forming a theory. Three guesses (a draft review submission, an
external TestFlight group, a rejected version state) were all wrong and cost more than one network
capture would have.

Removal needs all territories off AND `availableInNewTerritories` false. The API refuses to change
that flag directly: a PATCH to `/iris/v2/appAvailabilities/<id>` returns 403, and a POST returns
409. The pricing page's own checkbox, under Manage -> Manage Availability, is the only path that
works. `clearFutureTerritories` drives it with a real `click()` plus `userGesture: true`.

A rejected or developer-rejected version does not block removal once availability is off, despite
Apple's own help page listing those states as blockers.

`appStoreState` `READY_FOR_SALE` does not mean the app is live. Two apps showed "Removed from App
Store" on the page while carrying that state. Judge "live" from the page badge or from territory
availability, never from `appStoreState` alone.

The Apps page lazy-loads cards as you scroll, so read the inventory through the `iris` call, not
the DOM.

A deep link opened in a fresh tab fails auth (`authResult=FAILED`). Open `/apps` first in the
signed-in browser context, then navigate from there. `ensureTab()` in `tools/asc.mjs` does this by
always creating its background tab at `/apps`.

Apple web sessions expire after about an hour idle. A tool returning `{stop: "not-signed-in"}`
usually means the tab needs a fresh human sign-in, not a retry.

Removed apps can be restored from Removed Apps, but the bundle ID (once a build has been uploaded)
and the SKU cannot be reused. A removed dev or staging record also loses its TestFlight channel.

The daemon is shared by every session. Open a dedicated tab, attach with
`Target.attachToTarget({flatten: true})`, and route calls through `cdp(sid, ...)` or
`session.use(tabId)` plus `session.<Domain>.<method>`. Never attach to the tab a human is looking
at.

## Why every fetch and every evaluate carries its own timeout

A page-side `fetch` without an `AbortController` timeout wedged the shared daemon for ten minutes
during the session this learning was ported from, because one hung request blocked every other
caller's `Runtime.evaluate` behind it. Every `/iris` call in `tools/asc.mjs` builds its own
`AbortController` (`FETCH_TIMEOUT_MS`, 20s) and every `Runtime.evaluate` call passes a CDP-level
`timeout` (`evaluate()`'s default, 25s, 8s for synchronous DOM reads). Do not add a call here
without one.

## Provenance

2026-09-17 App Store Connect cleanup: inventory read, a removal run across ~20 apps (about 15
one-off scripts before the recipe held), and an agreements/tax-forms read. Ground truth for this
port: `apps-page.js`, `verify-page.js`, `why-page.js`, `fix3.js` + `flag.js` (the removal fix),
`pod5.js` (the network capture that found `CANNOT_REMOVE_WITH_APP_STORE_AVAILABILITY`), `agr.js`,
`pod-page.js` (the last removal variant), all in the originating session's scratchpad.
