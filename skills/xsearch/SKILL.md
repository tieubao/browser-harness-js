---
name: xsearch
description: >-
  Search X (Twitter) via CDP. Returns structured results (author, handle, text,
  URL, timestamp) for any query. Requires browser-harness-js on PATH, a
  Chromium-based browser with remote debugging, and an active X session (logged in).
setup: bash <skill-dir>/scripts/setup
compatibility: Requires browser-harness-js on PATH, a running Chromium browser with remote debugging (port 9222 or chrome://inspect), and an active X (Twitter) login in the browser.
---

# X Search

> ⚠️ **Required before first use:** run `bash <skill-dir>/scripts/setup` to put the
> `xsearch` and `browser-harness-js` CLIs on PATH. Nothing works until this is done.

> ⚠️ **You must be logged in to X in the browser.** X's search page does not show results to logged-out visitors — it redirects to a login wall. The browser session used by `browser-harness-js` must have an active X login.

Search X (Twitter) and extract structured results via CDP. No external dependencies beyond `browser-harness-js` (which provides the CDP session). Each call opens its own tab and WebSocket session — safe for parallel use.

## Setup (once)

The `browser-harness-js` CLI must be on PATH and a Chromium-based browser must be running with remote debugging. See the `cdp` skill for browser setup.

Run the setup script to symlink `xsearch` (and `browser-harness-js`, if missing) onto your PATH:

```bash
bash <skill-dir>/scripts/setup
```

Or symlink manually:

```bash
mkdir -p ~/.local/bin
ln -sf <skill-dir>/scripts/xsearch ~/.local/bin/xsearch
```

## Quick search

```bash
xsearch "your query"             # pretty-printed, up to 10 results
xsearch "your query" 5           # 5 results, pretty-printed
xsearch --json "your query" 3   # raw JSON
```

## Parallel use

Each `xsearch` call reuses the shared WebSocket but attaches to its own tab with a per-call `sessionId`. Tabs are closed fire-and-forget via `Target.closeTarget` so the caller isn't blocked waiting for cleanup.

```bash
xsearch "rust async" 3 &
xsearch "go channels" 3 &
wait
```

## Result shape

Each result is `{ author, handle, text, url, time }`:

```json
[
  {
    "author": "Zane Chee",
    "handle": "@injaneity",
    "text": "people of pi, i'm excited to finally introduce browser use in pi-computer-use!",
    "url": "https://x.com/injaneity/status/2065110712511500620",
    "time": "2026-06-11T16:35:36.000Z"
  }
]
```

## How it works

| Step | CDP call | What it does |
|------|----------|--------------|
| 1 | `session.connect()` (once) | Connect shared WebSocket to browser |
| 2 | `Target.createTarget({ background: true })` | Create an isolated background tab |
| 3 | `Target.attachToTarget` | Get per-call `sessionId` for tab-scoped routing |
| 4 | `cdp(sessionId, "Page.enable", …)` | Subscribe to page events |
| 5 | `cdp(sessionId, "Page.navigate", …)` | Go to `x.com/search?q=…&src=typed_query&f=top` |
| 6 | `session.waitFor('Page.loadEventFired', …, 30_000)` | Wait for page load (30s timeout) |
| 7 | `setTimeout(4000)` | Wait for React hydration and tweet rendering |
| 8 | Scroll loop (if count > 6) | Scroll to load more tweets (~3 per scroll) |
| 9 | `cdp(sessionId, "Runtime.evaluate", …)` | Single DOM query via `data-testid` selectors |
| 10 | `closeTab` (fire-and-forget) | Tear down tab without blocking the response |

## DOM selectors used

X's search page uses stable `data-testid` attributes:

| Selector | Purpose |
|----------|---------|
| `[data-testid="tweet"]` | Tweet container |
| `[data-testid="tweetText"]` | Tweet body text |
| `[data-testid="User-Name"]` | Author name/handle block |
| `a[role="link"]` within User-Name | Links: [0]=name, [1]=handle, [2]=permalink+timestamp |
| `time` | ISO timestamp via `datetime` attribute |

## Traps

- **You must be logged in.** X shows no search results to logged-out visitors — it redirects to a sign-in prompt. The browser session must have an active X login.
- **React hydration delay.** The page fires `loadEventFired` before tweets render. A 4s wait after load is required for the initial batch (~6 tweets) to appear.
- **Scroll-to-load for more results.** X uses infinite scroll. The initial view contains ~6 tweets. For `count > 6`, the script scrolls down (each scroll loads ~3 more tweets with a 1.5s delay).
- **`Page.enable()` must be called once** on each new tab before `Page.loadEventFired` will fire.
- **Result count may be less than requested** — X may not have enough matching tweets, or the scroll loop may not load them in time.
- **Tweet text may be truncated** — X renders "Show more" buttons for long tweets. The extracted `text` is what's visible without clicking "Show more".
- **No `jq` dependency** — URI encoding uses `encodeURIComponent()` in JS and output formatting is done via `.map().join()` in the heredoc.
