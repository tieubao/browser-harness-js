---
name: gsearch
description: >-
  Search the web via Google through CDP. Returns structured results (title, URL,
  snippet) in under 1 second. Use when the user asks to search the web, look
  something up, find a link, or research a topic. Requires browser-harness-js
  on PATH and a Chromium-based browser with remote debugging enabled.
compatibility: Requires browser-harness-js on PATH and a running Chromium browser with remote debugging (port 9222 or chrome://inspect).
---

# Google Search

Search Google and extract structured results via CDP. Reuses one dedicated tab across calls — no browser churn.

## Setup (once)

The `browser-harness-js` CLI must be on PATH and a Chromium-based browser must be running with remote debugging. See the `cdp` skill for browser setup.

Run the setup script to symlink `gsearch` onto your PATH:

```bash
bash <skill-dir>/scripts/setup
```

Or symlink manually:

```bash
# macOS (Apple Silicon + Homebrew)
command -v gsearch >/dev/null || ln -sf <skill-dir>/scripts/gsearch /opt/homebrew/bin/gsearch

# macOS (Intel) / most Linux — may need sudo
command -v gsearch >/dev/null || ln -sf <skill-dir>/scripts/gsearch /usr/local/bin/gsearch

# Linux without sudo (ensure ~/.local/bin is on PATH)
command -v gsearch >/dev/null || ln -sf <skill-dir>/scripts/gsearch ~/.local/bin/gsearch
```

## Quick search

```bash
gsearch "your query"            # pretty-printed, up to 10 results
gsearch "your query" 5          # 5 results, pretty-printed
gsearch --json "your query" 3   # raw JSON
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

if (!globalThis.__gsearch_target) {
  const t = await session.Target.createTarget({ url: "about:blank" })
  globalThis.__gsearch_target = t.targetId
  await session.use(globalThis.__gsearch_target)
  await session.Page.enable()
} else {
  await session.use(globalThis.__gsearch_target)
}

const url = "https://www.google.com/search?q=" + encodeURIComponent("your query") + "&num=10"
await session.Page.navigate({ url })
await new Promise(r => {
  const off = session.onEvent((m) => { if (m === "Page.loadEventFired") { off(); r() } })
})

const result = await session.Runtime.evaluate({
  expression: 'JSON.stringify([...document.querySelectorAll(".tF2Cxc")].slice(0, 10).map(el => ({ title: el.querySelector("h3")?.textContent?.trim() || "", url: el.querySelector("a[href]")?.href || "", snippet: el.querySelector(".VwiC3b")?.textContent?.trim() || "" })))',
  returnByValue: true
})
return JSON.parse(result.result.value)
EOF
```

## How it works

| Step | CDP call | What it does |
|------|----------|--------------|
| 1 | `session.connect({ port: 9222 })` | Connect to browser (fallback: auto-detect) |
| 2 | `Target.createTarget` (once) | Create a dedicated search tab |
| 3 | `session.use(targetId)` | Route subsequent calls to that tab |
| 4 | `Page.navigate` | Go to `google.com/search?q=…&num=N` |
| 5 | Wait for `Page.loadEventFired` | Ensure the page is fully rendered |
| 6 | `Runtime.evaluate` | Single DOM query extracts all results |

Warm path (steps 3–6) takes 0.8–1.1s per search. Cold start (steps 1–2) adds ~1.3s once.

## Why `Runtime.evaluate` over the accessibility tree

Google's AX tree for a search page has 1300+ nodes — walking it requires per-node parent lookups to reconstruct result hierarchy. A single `Runtime.evaluate` with `querySelectorAll('.tF2Cxc')` returns the same data in one CDP call (~5ms vs ~200ms for AX tree traversal). The CSS selectors (`.tF2Cxc` for result containers, `h3` for titles, `.VwiC3b` for snippets) are stable across Google's current HTML structure.

## Traps

- **`Page.enable()` must be called once** on the search tab before `Page.loadEventFired` will fire.
- **Multi-statement heredocs need `return`** — `browser-harness-js` auto-returns single expressions only.
- **Result count may be less than `num=`** — Google sometimes returns fewer results than requested.
- **Google may serve a consent/cookie wall** in some regions. Check with a screenshot if results come back empty.
- **The search tab is reused** — if you navigate it elsewhere, delete `globalThis.__gsearch_target` and close it with `Target.closeTarget`.
