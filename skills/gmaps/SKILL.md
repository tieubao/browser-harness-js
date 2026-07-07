---
name: gmaps
description: >-
  Local business search via Google Maps through CDP. Returns structured results
  (name, rating, review count, price, category, address, hours, coordinates,
  place ID, Maps URL) for any query — the data the metered Google Places API
  sells, sourced directly from the live Maps page. No API key, no quota. Use
  when the user asks to find local businesses, nearby places, shops/restaurants,
  or to search Google Maps. Requires browser-harness-js on PATH and a running
  Chromium-based browser with remote debugging.
setup: bash <skill-dir>/scripts/setup
compatibility: >-
  Requires browser-harness-js on PATH and a running Chromium browser with remote
  debugging (chrome://inspect or --remote-debugging-port). No API key. Results
  come from the live google.com/maps page rendered through your own browser.
---

# gmaps — local business search via Google Maps (CDP)

> ⚠️ **Required before first use:** run `bash <skill-dir>/scripts/setup` to put the
> `gmaps` and `browser-harness-js` CLIs on PATH. Nothing works until this is done.

Free, keyless local business search scraped from the live Google Maps page via CDP — the same data the metered **Google Places API** sells, sourced directly from the rendered page. No API key, no quota, no `jq`. Each call opens its own tab and WebSocket session — safe for parallel use.

## Setup (once)

The `browser-harness-js` CLI must be on PATH and a Chromium-based browser must be running with remote debugging. See the `cdp` skill for browser setup.

```bash
bash <skill-dir>/scripts/setup
gmaps "coffee shops in Austin TX"        # verify
```

## Commands

```bash
gmaps "coffee shops in Austin TX"            # up to 10 results, pretty
gmaps "sushi near Times Square" 5            # 5 results
gmaps "pharmacy open now Berlin" 20          # 20 (scrolls the feed)
gmaps --json "coffee shops in Austin TX" 5   # raw JSON
```

| Flag | Meaning |
|------|---------|
| `--json` | Emit raw JSON instead of pretty-printed text |
| `<query>` | A Google Maps search, e.g. `coffee shops in Austin TX` |
| `[count]` | Number of results (default 10, capped at 30 — the feed is scrolled to load more) |

### Examples

```bash
gmaps "coffee shops in Austin TX"
gmaps "sushi near Times Square" 5
gmaps "24 hour pharmacy Brooklyn" 10
gmaps --json "hardware store Portland OR" 20

# Parallel — each call uses its own tab
gmaps "coffee Austin" 5 &  gmaps "coffee Seattle" 5 &  wait
```

## Result shape

**Pretty** (default):
```
coffee shops in Austin TX  ·  5 results

1. Jo's Coffee – South Congress   ★4.4 (1972)   $1–10   Coffee shop
   1300 S Congress Ave   ·   Open · Closes 7 PM
   30.2510458, -97.7493717   ·   ChIJ1S_Bov20RIYRe7MiR8
   https://www.google.com/maps/place/Jo%27s+Coffee...
```

**`--json`**:
```json
{
  "query": "coffee shops in Austin TX",
  "count": 5,
  "results": [
    {
      "name": "Jo's Coffee – South Congress",
      "rating": 4.4,
      "review_count": 1972,
      "price": "$1–10",
      "category": "Coffee shop",
      "address": "1300 S Congress Ave",
      "hours": "Open · Closes 7 PM",
      "lat": 30.2510458,
      "lng": -97.7493717,
      "place_id": "ChIJ1S_Bov20RIYRe7MiR8",
      "url": "https://www.google.com/maps/place/Jo%27s+Coffee…"
    }
  ]
}
```

Each result carries: `name, rating, review_count, price, category, address, hours, lat, lng, place_id, url`. Missing fields are `null` (or `-` in pretty mode) — e.g. a place with no price tier or no street address.

## How it works

| Step | What happens |
|------|---------------|
| 1 | `session.connect()` (once) — shared WebSocket to the browser |
| 2 | `Target.createTarget({ background: true })` + `attachToTarget` — isolated background tab + per-call `sessionId` |
| 3 | `Page.navigate` to `https://www.google.com/maps/search/<query>` (URI-encoded; spaces as `+`) |
| 4 | **Poll for `a[href*='/maps/place/']` count > 0** — the real readiness signal. Chrome never fires `networkIdle` for Maps (continuous XHR polling keeps the 500ms quiet window from ever opening), so waiting on lifecycle events times out. Polling the feed is both faster and reliable. |
| 5 | **Scroll the feed** to load up to `count` results. The feed renders ~7 cards up front; more stream in as the feed is scrolled to its bottom. Stops at `count`, after two consecutive no-growth scrolls (end of results), or after a 25-scroll cap. |
| 6 | **One `Runtime.evaluate`** parses every result card and returns a JSON array. |
| 7 | Fire-and-forget `closeTab` in `finally` — cleanup without blocking the response. |

Per call: ~2–3 s for the default 10 results (dominated by the feed render + a couple of scrolls). Background tabs keep it unobtrusive (unlike `ytdl`, Maps needs no playback/poToken).

## Why a real browser for Maps

- **The Google Places API is metered and gated** — a key, a billing account, and per-call cost. The Maps web page renders the same data for free; driving your own browser reads it with no key and no quota.
- **A real browser renders the feed.** Maps is a heavy SPA: results stream into `div[role=feed]` as it scrolls, with class names that are obfuscated and rotate. A single `Runtime.evaluate` after scrolling extracts every card in one CDP call — no HTML fetching, no proxy, no Cloudflare wall (the page is rendered as you, in your own browser).
- **Per-query use, not bulk harvest.** This is the agent-call shape: one query, up to 30 results, returned as structured JSON or text. It is *not* a bulk scraper (that needs proxy rotation + rate management, which a real-browser-per-call approach doesn't scale to).

## Traps

- **`networkIdle` never fires for Maps.** Continuous XHR polling holds the network busy, so the lifecycle-event wait gsearch/findata use would time out every time. `gmaps` polls `a[href*='/maps/place/']` count instead — the actual readiness signal.
- **No class-name selectors.** Google's class names are obfuscated (`.Nv2PK`, `.bfdHYd`, `.MW4etd`, …) and rotate across releases. The parser relies only on **stable signals**: the result link's `aria-label` (name), the card's leaf-text DOM order (rating/reviews/price/category/address/hours), and the `href` (`!3d<lat>!4d<lng>` for coords, `!19sChIJ…` / `!1s0x..:0x..` for the place id). If Maps changes the card text order, the address/hours heuristics are the first things to revisit.
- **`?query=` URL form does not render the feed** (returns a redirect shell with no results) — only the path form `/maps/search/<query>` does. Spaces are sent as `+`.
- **Address is a heuristic.** It's the first leaf starting with a street number (`^\d{1,5}[-A-Za-z]*\s`). A place with no street address (an area/region result, or a named building) yields `address: null` rather than a guess.
- **Hours is a heuristic.** It's the `Open` / `Closed` / `Open 24 hours` / `Temporarily closed` leaf, plus the following `· Closes/Opens …` leaf when present. `Open 24 hours` rendered as two leaves (`Open` + `24 hours`) would be read as just `Open`.
- **Phone, website, and full weekly hours are NOT in the feed card** — they live on the place-detail page and need a per-place navigation to read. Not implemented (would be a `--details` mode); for now use `url` to open a place.
- **Sponsored results** may appear (Maps sometimes shows one ad, which is also a `/maps/place/` link). They are not filtered out — check the data if it matters.
- **Consent / cookie wall** (rare in an already-warmed browser) returns zero results. If results come back empty, open the search URL in the browser once to clear it.
- **No `jq` dependency** — parsing and pretty-printing are done in-page / in JS.
