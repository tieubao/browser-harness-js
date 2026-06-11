# Google Search

Search Google and extract structured results (title, URL, snippet) in a single CDP round-trip. Reuses one dedicated tab across calls — no browser churn.

## Quick search

```bash
browser-harness-js <<'EOF'
if (!session.isConnected()) {
  try { await session.connect({ port: 9222 }) } catch {
    try { await session.connect() } catch (e) { throw new Error("Cannot connect to browser: " + e.message) }
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

const query = "your search query here"
const count = 10
const url = "https://www.google.com/search?q=" + encodeURIComponent(query) + "&num=" + count
await session.Page.navigate({ url })
await new Promise(r => {
  const off = session.onEvent((m) => { if (m === "Page.loadEventFired") { off(); r() } })
})

const result = await session.Runtime.evaluate({
  expression: 'JSON.stringify([...document.querySelectorAll(".tF2Cxc")].slice(0, ' + count + ').map(el => ({ title: el.querySelector("h3")?.textContent?.trim() || "", url: el.querySelector("a[href]")?.href || "", snippet: el.querySelector(".VwiC3b")?.textContent?.trim() || "" })))',
  returnByValue: true
})
return JSON.parse(result.result.value)
EOF
```

## How it works

| Step | CDP call | What it does |
|------|----------|--------------|
| 1 | `session.connect({ port: 9222 })` | Connect to browser (fallback: auto-detect) |
| 2 | `Target.createTarget` (once) | Create a dedicated search tab, store in `globalThis.__gsearch_target` |
| 3 | `session.use(targetId)` | Route subsequent calls to that tab |
| 4 | `Page.navigate` | Go to `google.com/search?q=…&num=N` |
| 5 | Wait for `Page.loadEventFired` | Ensure the page is fully rendered |
| 6 | `Runtime.evaluate` | Single DOM query extracts all results |

The hot path (steps 3–6) takes **0.8–1.1s** per search. Cold start (steps 1–2) adds ~1.3s once.

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

## Parameterized search function

For repeated searches, define a helper on the server:

```bash
# One-time setup: store the search function
browser-harness-js <<'EOF'
globalThis.googleSearch = async (query, count = 10) => {
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
  const url = "https://www.google.com/search?q=" + encodeURIComponent(query) + "&num=" + count
  await session.Page.navigate({ url })
  await new Promise(r => {
    const off = session.onEvent((m) => { if (m === "Page.loadEventFired") { off(); r() } })
  })
  const result = await session.Runtime.evaluate({
    expression: 'JSON.stringify([...document.querySelectorAll(".tF2Cxc")].slice(0, ' + count + ').map(el => ({ title: el.querySelector("h3")?.textContent?.trim() || "", url: el.querySelector("a[href]")?.href || "", snippet: el.querySelector(".VwiC3b")?.textContent?.trim() || "" })))',
    returnByValue: true
  })
  return JSON.parse(result.result.value)
}
return "googleSearch ready"
EOF

# Then call it
browser-harness-js 'return await globalThis.googleSearch("your query", 5)'
```

## Shell wrapper (`sdk/gsearch`)

A CLI script ships at `<skill-dir>/sdk/gsearch`. Symlink it into your PATH the same way as `browser-harness-js`:

```bash
# macOS (Apple Silicon + Homebrew)
command -v gsearch >/dev/null || ln -sf <skill-dir>/sdk/gsearch /opt/homebrew/bin/gsearch

# macOS (Intel) / most Linux
command -v gsearch >/dev/null || ln -sf <skill-dir>/sdk/gsearch /usr/local/bin/gsearch

# Linux without sudo
command -v gsearch >/dev/null || ln -sf <skill-dir>/sdk/gsearch ~/.local/bin/gsearch
```

```bash
gsearch "your query"            # pretty-printed, up to 10 results
gsearch "your query" 5          # 5 results, pretty-printed
gsearch --json "your query" 3   # raw JSON
```

## Why `Runtime.evaluate` over the accessibility tree

Google's AX tree for a search page has 1300+ nodes — walking it requires per-node parent lookups to reconstruct result hierarchy. A single `Runtime.evaluate` with `querySelectorAll('.tF2Cxc')` returns the same data in one CDP call (~5ms vs ~200ms for AX tree traversal). The CSS selectors (`.tF2Cxc` for result containers, `h3` for titles, `.VwiC3b` for snippets) are stable across Google's current HTML structure.

## Traps

- **`Page.enable()` must be called once** on the search tab before waiting for `loadEventFired`. Without it, the event listener is never registered.
- **Multi-statement heredocs need `return`** — the `browser-harness-js` server auto-returns single expressions, but multi-line snippets require an explicit `return` statement.
- **Result count may be less than `num=`** — Google sometimes returns fewer results than requested (e.g. `num=10` may yield 6–9 results). The `&num=` URL param sets the upper bound, not a guarantee.
- **Google may serve a consent/cookie wall** in some regions. If results come back empty, check the page with a screenshot first.
- **The search tab is reused** — if you navigate it elsewhere, subsequent searches will still try to use it. Call `Target.closeTarget` and delete `globalThis.__gsearch_target` to reset.
