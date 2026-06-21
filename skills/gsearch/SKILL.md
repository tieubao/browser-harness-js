---
name: gsearch
description: >-
  Search the web via Google through CDP. Returns structured results (title, URL,
  snippet) in under 1 second. Use when the user asks to search the web, look
  something up, find a link, or research a topic. Requires browser-harness-js
  on PATH and a Chromium-based browser with remote debugging enabled.
setup: bash <skill-dir>/scripts/setup
compatibility: Requires browser-harness-js on PATH and a running Chromium browser with remote debugging (port 9222 or chrome://inspect).
---

# Google Search

> ⚠️ **Required before first use:** run `bash <skill-dir>/scripts/setup` to put the
> `gsearch` and `browser-harness-js` CLIs on PATH. Nothing works until this is done.

Search Google and extract structured results via CDP. No external dependencies beyond `browser-harness-js` (which provides the CDP session). Each call opens its own tab and WebSocket session — safe for parallel use.

## Setup (once)

The `browser-harness-js` CLI must be on PATH and a Chromium-based browser must be running with remote debugging. See the `cdp` skill for browser setup.

Run the setup script to symlink `gsearch` (and `browser-harness-js`, if missing) onto your PATH:

```bash
bash <skill-dir>/scripts/setup
```

The script creates `~/.local/bin` if needed, adds it to your PATH in `~/.zshrc` (or `~/.bashrc`), and symlinks the CLI. After running it, verify:

```bash
gsearch "test" 1
```

Or symlink manually:

```bash
mkdir -p ~/.local/bin
ln -sf <skill-dir>/scripts/gsearch ~/.local/bin/gsearch
```

## Quick search

```bash
gsearch "your query"            # pretty-printed, up to 10 results
gsearch "your query" 5          # 5 results, pretty-printed
gsearch --json "your query" 3   # raw JSON
```

## Parallel use

Each `gsearch` call reuses the shared WebSocket but attaches to its own tab with a per-call `sessionId`. Tab-specific CDP calls go through `cdp(sessionId, method, params)`. Multiple calls can run concurrently without interfering — no `activeSessionId` clobbering, no tab trampling, no event cross-fire. Tabs are closed fire-and-forget via `Target.closeTarget` so the caller isn't blocked waiting for cleanup.

```bash
gsearch "rust async" 3 &
gsearch "go channels" 3 &
wait
```

## Result shape

Each result is `{ title, url, snippet }`:

```json
[
  {
    "title": "TypeScript 5.8",
    "url": "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html",
    "snippet": "TypeScript 5.8 introduces a stable --module node18 flag..."
  }
]
```

## Following a result link

Open a result `url` directly through `browser-harness-js` — no need to re-search or route through Google. Same connect/create-tab/evaluate flow as ad-hoc search, but navigate to the link and extract page text:

```bash
browser-harness-js <<'EOF'
if (!session.isConnected()) {
  try { await session.connect({ port: 9222 }) } catch {
    try { await session.connect() } catch (e) { throw new Error("Cannot connect: " + e.message) }
  }
}

const url = "https://example.com/some-article"
const t = await session.Target.createTarget({ url: "about:blank", background: true })
const { sessionId } = await session.Target.attachToTarget({ targetId: t.targetId, flatten: true })

try {
  await cdp(sessionId, "Page.enable", {})
  await cdp(sessionId, "Page.navigate", { url })
  await session.waitFor({ method: 'Page.loadEventFired', sessionId, timeoutMs: 30_000 })
  const result = await cdp(sessionId, "Runtime.evaluate", {
    expression: 'document.querySelector("article, main")?.innerText || document.body.innerText',
    returnByValue: true
  })
  return result.result.value
} finally {
  session.closeTab(t.targetId, sessionId).catch(() => {})
}
EOF
```

- `article, main` skips nav/footer chrome; `document.body.innerText` is the fallback.
- For JS-rendered pages, add a short `await new Promise(r => setTimeout(r, 1000))` before the evaluate — `loadEventFired` fires on initial load, not after client fetches.

## Ad-hoc search without the script

If `gsearch` isn't on PATH, the same logic runs directly through `browser-harness-js`:

```bash
browser-harness-js <<'EOF'
if (!session.isConnected()) {
  try { await session.connect({ port: 9222 }) } catch {
    try { await session.connect() } catch (e) { throw new Error("Cannot connect: " + e.message) }
  }
}

const count = 10
const t = await session.Target.createTarget({ url: "about:blank", background: true })
const { sessionId } = await session.Target.attachToTarget({ targetId: t.targetId, flatten: true })

try {
  await cdp(sessionId, "Page.enable", {})
  await cdp(sessionId, "Page.navigate", {
    url: "https://www.google.com/search?q=" + encodeURIComponent("your query") + "&num=" + count
  })
  await session.waitFor({ method: 'Page.loadEventFired', sessionId, timeoutMs: 30_000 })

  const result = await cdp(sessionId, "Runtime.evaluate", {
    expression: 'JSON.stringify([...document.querySelectorAll(".tF2Cxc")].slice(0, 10).map(el => ({ title: el.querySelector("h3")?.textContent?.trim() || "", url: el.querySelector("a[href]")?.href || "", snippet: el.querySelector(".VwiC3b")?.textContent?.trim() || "" })))',
    returnByValue: true
  })
  const results = JSON.parse(result.result.value)
  return results.map(r => r.title + "\n  " + r.url + "\n  " + r.snippet).join("\n\n")
} finally {
  session.closeTab(t.targetId, sessionId).catch(() => {})
}
EOF
```

## How it works

| Step | CDP call | What it does |
|------|----------|--------------|
| 1 | `session.connect()` (once) | Connect shared WebSocket to browser |
| 2 | `Target.createTarget({ background: true })` | Create an isolated background tab |
| 3 | `Target.attachToTarget` | Get per-call `sessionId` for tab-scoped routing |
| 4 | `cdp(sessionId, "Page.enable", …)` | Subscribe to page events |
| 5 | `cdp(sessionId, "Page.navigate", …)` | Go to `google.com/search?q=…&num=N` (URI-encoded via `encodeURIComponent` in JS) |
| 6 | `session.waitFor('Page.loadEventFired', …, 30_000)` | Wait for page load (30s timeout) |
| 7 | `cdp(sessionId, "Runtime.evaluate", …)` | Single DOM query extracts all results |
| 8 | `closeTab` (fire-and-forget) | Tear down tab without blocking the response |

Each call takes ~0.8–1.1s. The shared WebSocket means no repeated permission popups. URI encoding and output formatting happen in JS — no `jq` dependency.

## Why `Runtime.evaluate` over the accessibility tree

Google's AX tree for a search page has 1300+ nodes — walking it requires per-node parent lookups to reconstruct result hierarchy. A single `Runtime.evaluate` with `querySelectorAll('.tF2Cxc')` returns the same data in one CDP call (~5ms vs ~200ms for AX tree traversal). The CSS selectors (`.tF2Cxc` for result containers, `h3` for titles, `.VwiC3b` for snippets) are stable across Google's current HTML structure.

## No `jq` dependency

URI encoding uses `encodeURIComponent()` in JS and output formatting is done via `.map().join()` in the heredoc. The raw query is escaped for JS string interpolation with `sed` (backslashes, `$`, backticks for bash; single quotes for JS). The REPL's `renderResult` passes string returns through raw — no JSON wrapping — so bash just prints.

## Traps

- **Tab cleanup uses `try/finally` with fire-and-forget `closeTab`** — `closeTab` does `window.close()` + `Target.closeTarget` for thorough cleanup, wrapped in `finally` so it runs even on errors. The call is not awaited so it doesn't block the response. Under rapid parallel calls the close operations serialize in the session's `closeQueue`, but they don't block results.
- **`Page.enable()` must be called once** on each new tab before `Page.loadEventFired` will fire.
- **`Page.loadEventFired` wait has a 30s timeout** — uses `session.waitFor()` instead of a raw promise, so a hung page load doesn't leak the tab forever.
- **Result count may be less than `num=`** — Google sometimes returns fewer results than requested.
- **Google may serve a consent/cookie wall** in some regions — this returns 0 results, same as the old approach. Check with a screenshot if results come back empty.
- **Multi-statement heredocs need `return`** — `browser-harness-js` auto-returns single expressions only.
