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

Search Google and extract structured results via CDP. Each call opens its own tab and WebSocket session — safe for parallel use.

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

Each `gsearch` call reuses the shared WebSocket but attaches to its own tab with a per-call `sessionId`. Tab-specific CDP calls go through `cdp(sessionId, method, params)`, and `loadEventFired` listeners filter by sessionId. Multiple calls can run concurrently without interfering — no `activeSessionId` clobbering, no tab trampling, no event cross-fire.

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

## Ad-hoc search without the script

If `gsearch` isn't on PATH, the same logic runs directly through `browser-harness-js`:

```bash
browser-harness-js <<'EOF'
if (!session.isConnected()) {
  try { await session.connect({ port: 9222 }) } catch {
    try { await session.connect() } catch (e) { throw new Error("Cannot connect: " + e.message) }
  }
}

const t = await session.Target.createTarget({ url: "about:blank", background: true })
const { sessionId } = await session.Target.attachToTarget({ targetId: t.targetId, flatten: true })

await cdp(sessionId, "Page.enable", {})
await cdp(sessionId, "Page.navigate", { url: "https://www.google.com/search?q=" + encodeURIComponent("your query") + "&num=10" })
await new Promise(r => {
  const off = session.onEvent((m, _p, sid) => { if (m === "Page.loadEventFired" && sid === sessionId) { off(); r() } })
})

const result = await cdp(sessionId, "Runtime.evaluate", {
  expression: 'JSON.stringify([...document.querySelectorAll(".tF2Cxc")].slice(0, 10).map(el => ({ title: el.querySelector("h3")?.textContent?.trim() || "", url: el.querySelector("a[href]")?.href || "", snippet: el.querySelector(".VwiC3b")?.textContent?.trim() || "" })))',
  returnByValue: true
})
try { await session.Target.closeTarget({ targetId: t.targetId }) } catch {}
return JSON.parse(result.result.value)
EOF
```

## How it works

| Step | CDP call | What it does |
|------|----------|--------------|
| 1 | `session.connect()` (once) | Connect shared WebSocket to browser |
| 2 | `Target.createTarget({ background: true })` | Create an isolated background tab |
| 3 | `Target.attachToTarget` | Get per-call `sessionId` for tab-scoped routing |
| 4 | `cdp(sessionId, "Page.navigate", …)` | Go to `google.com/search?q=…&num=N` |
| 5 | Wait for `Page.loadEventFired` (filtered by sessionId) | Ensure the page is fully rendered |
| 6 | `cdp(sessionId, "Runtime.evaluate", …)` | Single DOM query extracts all results |
| 7 | `Target.closeTarget` | Tear down tab |

Each call takes ~0.8–1.1s. The shared WebSocket means no repeated permission popups.

## Why `Runtime.evaluate` over the accessibility tree

Google's AX tree for a search page has 1300+ nodes — walking it requires per-node parent lookups to reconstruct result hierarchy. A single `Runtime.evaluate` with `querySelectorAll('.tF2Cxc')` returns the same data in one CDP call (~5ms vs ~200ms for AX tree traversal). The CSS selectors (`.tF2Cxc` for result containers, `h3` for titles, `.VwiC3b` for snippets) are stable across Google's current HTML structure.

## Traps

- **`Page.enable()` must be called once** on each new tab before `Page.loadEventFired` will fire.
- **Multi-statement heredocs need `return`** — `browser-harness-js` auto-returns single expressions only.
- **Result count may be less than `num=`** — Google sometimes returns fewer results than requested.
- **Google may serve a consent/cookie wall** in some regions. Check with a screenshot if results come back empty.
