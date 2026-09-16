# Anna's Archive: title to MD5 through a real tab

Why this learning exists: `annas-fetch search` (ops-toolkit) hits the site's HTML search over plain HTTP and every mirror answers with a 403 anti-bot challenge (seen 2026-09-17, all six mirrors, not an outage). The member JSON API that downloads by MD5 keeps working. So the browser does only the discovery step: load the search page in Helium, read the result cards, hand back MD5s. The download stays in `annas-fetch fetch <md5>` with the member key under `op run`. No credential ever enters this module.

## Tools

| Tool | What it does |
|---|---|
| `search {query, ext?, lang?, limit?}` | One search page, returns `{state, rows: [{md5, ext, size, year, downloads, text}]}` |
| `resolve {titles: [string | {query, match?, ext?}]}` | One MD5 per title: best matching epub by download count, else first epub, else first row; carries 3 alternatives per title |
| `probe {query, seconds?}` | Diagnostic: samples the page once a second after navigation |

Run from the REPL: `await learnings("annas-archive", "resolve", {titles: [...]})`. From a shell, `annas-fetch resolve` (ops-toolkit) wraps the same call.

## Page facts (all seen live)

- Search URL: `/search?q=<words>&ext=epub&lang=en`. The site redirects through an anti-bot check and lands on the same URL with `&check=1` appended. Helium clears the check on its own within a second; a fresh tab needs no manual solve.
- The check interstitial is itself a page full of real-looking result cards with random books. "Cards exist" is therefore not "results exist". Ready means a card mentions a query word, or the page says no results.
- A "recent downloads" ticker (`.js-recent-downloads-scroll`) carries `/md5/` anchors on every page, including before results render. Skip it.
- A result card is `div.border-b` holding the cover anchor and a text column. The text column's meta line reads `English [en] · EPUB · 0.9MB · 2011 · 📕 Book · 🚀/lgli/zlib · Save · 38,650 · 42 · 1`; the first number after "Save" is the lifetime download count. Some cards truncate the meta, so the parser falls back to the source path's extension.
- `Page.navigate` returns before the old document is gone. A `Runtime.evaluate` in that window returns undefined or throws "Execution context was destroyed"; both count as loading.
- The tab is reused across calls so the check cookie carries. 18 sequential searches took about 90 seconds.

## Harness trap that cost an hour

The REPL daemon imports a learning module once and caches it for its lifetime. `browser-harness-js --restart` reported a fresh daemon while the old `repl.ts` process kept running with the stale module, so three rounds of fixes never loaded and the tool kept returning the same garbage. After editing a tool: `pkill -f 'skills/cdp/sdk/repl.ts'`, then `harness-connect`, then confirm with `--status` that `uptime` is small.

## Not done here

- No download through the browser. The member API route in `annas-fetch` is the download path.
- No pagination: the first page of results has been enough for known-item lookups.
