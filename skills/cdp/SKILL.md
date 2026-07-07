---
name: cdp
description: >-
  Drive any Chromium-based browser via the DevTools Protocol from JavaScript.
  Run JS snippets through the `browser-harness-js` CLI — it auto-spawns a
  long-lived Node HTTP server holding a fully-typed CDP `Session`, and every call
  (`browser-harness-js 'await session.Page.navigate(...)'`) executes against the
  same persistent connection. Session, active target, and globals survive across
  calls. Use when the user wants to automate, script, or inspect a
  Chromium-based browser via CDP — single tab or multi-tab, attach to an
  existing browser or launch a new one with --remote-debugging-port.
setup: bash <skill-dir>/scripts/setup
---

# CDP — `browser-harness-js` skill

> ⚠️ **Required before first use:** run `bash <skill-dir>/scripts/setup` to put the
> `browser-harness-js` CLI on PATH. Nothing works until this is done.

Custom codegen'd CDP SDK (every method from browser_protocol.json + js_protocol.json gets a typed wrapper) plus a tiny HTTP server that holds one persistent CDP `Session`. The `browser-harness-js` CLI auto-starts the server on first use and forwards JS snippets to it.

The SDK lives in the skill's `sdk/` directory. In the rest of this doc, `<skill-dir>` refers to wherever `npx skills add` installed the skill (Claude Code: `~/.claude/skills/cdp`; Cursor: `~/.cursor/skills/cdp`; other agents vary). The CLI should be on PATH as `browser-harness-js`.

## Setup (once, first use)

`npx skills add` drops the skill into your agent's skills directory but does NOT put the CLI on PATH. Run the setup script:

```bash
bash <skill-dir>/scripts/setup
```

The script creates `~/.local/bin` if needed, adds it to your PATH in `~/.zshrc` (or `~/.bashrc`), and symlinks the CLI. After running it, verify:

```bash
browser-harness-js --status
```

Or symlink manually:

```bash
mkdir -p ~/.local/bin
ln -sf <skill-dir>/sdk/browser-harness-js ~/.local/bin/browser-harness-js
```

The CLI requires `node` on PATH (the server is Node-native — TypeScript type stripping is on by default from Node 23.6). It prints a clear error if `node` is missing; no runtime is auto-installed.

## How to use

Just run `browser-harness-js '<JS>'`. The first call spawns the server in the background; subsequent calls hit the same process and so reuse the same `session`, the same WebSocket to the browser, and any globals you set.

```bash
browser-harness-js 'await session.connect()'
browser-harness-js 'await session.Page.navigate({url:"https://example.com"})'
browser-harness-js '(await session.Runtime.evaluate({expression:"document.title",returnByValue:true})).result.value'
```

Output is the **raw result content** — no `{ok,result}` envelope.

| Result type | stdout |
|---|---|
| string                       | bare text, no JSON quotes (e.g. `Example Domain`) |
| number / boolean             | `42`, `true` |
| object / array (non-empty)   | compact JSON (e.g. `{"frameId":"..."}`, `[1,2,3]`) |
| `undefined` / `null` / `""` / `{}` / `[]` | empty (no output) |

**Errors** go to **stderr**, exit code `1`. The CDP error message and JS stack are printed verbatim, e.g.:
```
Error: CDP -32602: invalid params
    at _call (.../session.ts:117:33)
    ...
```
Detect failure with `if browser-harness-js '...'; then ...; else handle_error; fi` or by checking `$?`.

**Multi-line snippets via stdin (heredoc).** Important: a multi-statement snippet does NOT auto-return the last expression — write `return X` explicitly. Single-expression snippets passed as the first argument DO auto-return.

```bash
browser-harness-js <<'EOF'
const tabs = await listPageTargets();
globalThis.tid = tabs[0].targetId;
await session.use(globalThis.tid);
return globalThis.tid;
EOF
```

## CLI commands

| Command | Behavior |
|---|---|
| `browser-harness-js '<js>'`     | Auto-start server if needed, eval the JS, print result. |
| `browser-harness-js <<EOF…EOF`  | Same, code from stdin. |
| `browser-harness-js --status`   | Print health JSON (uptime, connected, sessionId) or exit 1 if down. |
| `browser-harness-js --start`    | Explicit start (no-op if already running). |
| `browser-harness-js --stop`     | Graceful shutdown. Drops session state. |
| `browser-harness-js --restart`  | Stop + start fresh. |
| `browser-harness-js --logs`     | `tail -f` the server log (`/tmp/browser-harness-js.log`). |

Env vars: `CDP_REPL_PORT` (default `9876`), `CDP_REPL_LOG` (default `/tmp/browser-harness-js.log`).

## API surface inside snippets

These globals are pre-loaded — no imports needed:

- `session` — the persistent `Session`. Has every CDP domain mounted: `session.Page`, `session.DOM`, `session.Runtime`, `session.Network`, … 56 domains, 652 methods total.
- `listPageTargets()` — list real page targets via CDP's `Target.getTargets` (works on Chrome 144+ too), with `chrome://` and `devtools://` URLs filtered out. No args — uses the connected session.
- `detectBrowsers()` — scan OS-specific profile dirs for running Chromium-based browsers with remote debugging on. Returns `[{name, profileDir, port, wsPath, wsUrl, mtimeMs}]`, sorted by most recently launched.
- `resolveWsUrl(opts)` — resolve a WS URL from `{wsUrl}` | `{port, host?}` | `{profileDir}`. For the no-args auto-detect flow, call `session.connect()` directly instead.
- `CDP` — the generated namespaces (`CDP.Page`, `CDP.Runtime`, …) for type-name reference.
- `axView(nodes, opts?)` — compressed accessibility-tree view: a pure projection over a raw `Accessibility.getFullAXTree`/`queryAXTree` result. Drops ~96% structural noise, assigns `[n]` refs → `backendDOMNodeId`. See `interaction-skills/snapshot.md`.

### Calling a CDP method

Every method takes a single object argument matching the CDP wire params; it resolves to the typed return value (no `result` envelope, no `id` correlation — handled for you).

```js
// no params
await session.DOM.enable()

// required params
await session.Page.navigate({ url: 'https://example.com' })

// all-optional params (object also optional)
await session.Page.captureScreenshot()
await session.Page.captureScreenshot({ format: 'png', quality: 80 })

// returns are stripped to the typed shape
const { root } = await session.DOM.getDocument()
const { nodeId } = await session.DOM.querySelector({ nodeId: root.nodeId, selector: 'h1' })
```

### Interaction skills (recipes) — explore the folder

`interaction-skills/` holds pure-CDP recipes for mechanics that aren't obvious from the method list alone — dropdowns, drag-and-drop, OOPIFs, network waits, screenshots, recording cross-tab user actions. The set grows, so **look, don't recall**: when a task isn't a straight method call (a framework that swallows clicks, a shadow-DOM trap, a wait-with-timeout, multi-tab anything), browse before improvising.

```bash
ls <skill-dir>/interaction-skills/
grep -l <keyword> <skill-dir>/interaction-skills/*.md
```

Each recipe leads with the shortest CDP call that works, then the trap — in `session.Domain.method(...)` form, no wrapped helpers — so it drops straight into a snippet. If the mechanic you need isn't there, that's a gap worth filing as a new recipe.

### Finding elements: accessibility tree over selectors

For a named element (a button, link, textbox, heading), prefer the accessibility tree over CSS selectors — it finds by semantic role + accessible name (Playwright's `getByRole`/`getByText` model) and crosses shadow boundaries. Two tools, by task:

- **Targeted find** (you know the role/name): `session.Accessibility.queryAXTree` — ~30 tokens. Needs a DOM `nodeId` (from `session.DOM.getDocument`) and the active session (`session.use` first; the bare `{role, accessibleName}` form errors, and the `cdp(sessionId, …)` route hangs). No `Accessibility.enable` needed.
- **Explore an unfamiliar page** (don't know what to ask for, pick from many, summarize layout): `axView(nodes)` over `session.Accessibility.getFullAXTree({})` — a compressed snapshot with `[n]` refs, 7–22K tokens.

```js
await session.use(targetId)
const { root } = await session.DOM.getDocument({})
// Targeted: find a button labeled "Submit"
const { nodes } = await session.Accessibility.queryAXTree({ nodeId: root.nodeId, role: 'button', accessibleName: 'Submit' })
const node = nodes.find(n => !n.ignored)   // node.backendDOMNodeId → DOM.getBoxModel → Input.dispatchMouseEvent

// Explore: compressed whole-page snapshot
const { nodes: ax } = await session.Accessibility.getFullAXTree({})
return axView(ax)
```

Use DOM queries (`DOM.querySelector`, `Runtime.evaluate` with `querySelector`) for structural context, when the tree returns nothing (canvas, non-semantic divs), or when you already have a stable selector. Full guides: [`accessibility-tree.md`](interaction-skills/accessibility-tree.md) (queryAXTree) and [`snapshot.md`](interaction-skills/snapshot.md) (axView).

### Connecting

**Preferred: just call `session.connect()` with no args.** It auto-detects the browser, the port, and the host — no hardcoded port to keep in sync, no guessing which browser. Always try this first:

```js
await session.connect()   // auto-detect: browser + port + host (loopback)
```

Auto-detect scans OS-specific browser-data dirs for running Chromium-based browsers (Chrome, Chromium, Edge, Brave, Arc, Vivaldi, Opera, Comet, Canary, Dia, Aside, and any other Chromium fork) by looking for a `DevToolsActivePort` file. Each browser picks its own debug port (Chrome often 9222, but Aside uses an ephemeral one like 52860, etc.) — auto-detect reads the actual port from that file instead of assuming 9222. The host is always loopback (`127.0.0.1`) for a locally-running browser. Candidates are ordered by most-recently-launched, and the first one whose WebSocket accepts wins. OS-agnostic — works on macOS, Linux, Windows.

Use `detectBrowsers()` first if you want to see what's available (or let the user pick) before connecting:

```js
const found = await detectBrowsers()
// [{ name: 'Dia', profileDir, port, wsPath, wsUrl, mtimeMs }, ...]
```

**Explicit forms** — use these only when auto-detect picks the wrong browser, or when you already know where to connect:

| Form | When to use |
|---|---|
| `{ port, host? }` | You launched the browser with a known `--remote-debugging-port`. Default host `127.0.0.1`. |
| `{ profileDir }` | Target a specific browser when several are running. Reads `<profileDir>/DevToolsActivePort` directly. |
| `{ wsUrl }` | You already have `ws://…/devtools/browser/<uuid>` (e.g. a remote browser over SSH). |

```js
await session.connect({ port: 9222 })                                        // a specific port you set
await session.connect({ profileDir: '/Users/<you>/Library/Application Support/Dia' })
await session.connect({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/<uuid>' })
```

Profile paths by OS — use these with `{ profileDir }`:
- macOS: `~/Library/Application Support/<Browser>` (e.g. `Dia/User Data`, `Google/Chrome`, `Comet`, `BraveSoftware/Brave-Browser`, `Arc/User Data`, `Aside`)
- Linux: `~/.config/<browser>` (e.g. `dia`, `google-chrome`, `chromium`, `BraveSoftware/Brave-Browser`, `aside`)
- Windows: `%LOCALAPPDATA%\<Browser>\User Data` (e.g. `Dia\User Data`, `Google\Chrome`, `Microsoft\Edge`, `BraveSoftware\Brave-Browser`, `Aside`)

Per-candidate WS-open timeout defaults to **5s** — live browsers answer with open/close within ~100ms, so 5s is already generous. The only case where 5s is too short is when the browser is showing the **Allow** popup and waiting for the user to click. If you expect that, pass `timeoutMs: 30000`:

```js
await session.connect({ timeoutMs: 30_000 })
```

**If you see `No detected browser accepted a connection`** — the browsers have `DevToolsActivePort` files but none are currently serving WS. Most common cause: remote-debugging is enabled but the user hasn't clicked **Allow** on the prompt yet. Tell them to click Allow, then retry (or bump `timeoutMs`).

### Picking a target (tab)

After `connect()`, call `session.use(targetId)` once; subsequent page-level calls (Page/DOM/Runtime/Network/etc.) auto-route to that target's sessionId. `Browser.*` and `Target.*` calls always hit the browser endpoint.

```js
const tabs = await listPageTargets()                     // no args; uses the connected session
const sid  = await session.use(tabs[0].targetId)
await session.Page.enable()
await session.Page.navigate({ url: 'https://example.com' })
```

`listPageTargets()` uses CDP's `Target.getTargets` (not `/json`), so it works on Chrome 144+ too. It already filters out `chrome://` and `devtools://` URLs. Equivalent raw call:

```js
const { targetInfos } = await session.Target.getTargets({})
const tabs = targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://'))
```

To switch tabs: `session.use(otherTargetId)`. To detach: `session.setActiveSession(undefined)`.

### Events

```js
// Subscribe (returns an unsubscribe fn)
const off = session.onEvent((method, params, sessionId) => { ... })

// Or wait for a single matching event with optional predicate + timeout
await session.Network.enable()
const ev = await session.waitFor(
  'Page.frameNavigated',
  (p) => p.frame.url.includes('example.com'),
  10_000
)
```

### Persisting state across calls

Each snippet runs inside its own async wrapper, so its `let`/`const` declarations vanish when it returns. To carry data forward, attach to `globalThis`:

```bash
browser-harness-js '(await listPageTargets()).forEach((t,i)=>globalThis["tab"+i]=t.targetId)'
browser-harness-js 'await session.use(globalThis.tab0)'
browser-harness-js 'await session.Page.navigate({url:"https://example.com"})'
```

`session` itself, the active sessionId, and event subscribers are already preserved by the server — globals are only needed for ad-hoc data.

## Connecting to a running browser (inspect flow)

When attaching to the user's already-running browser:

1. **Try `await session.connect()` first** — no-args auto-detect handles every Chromium-based browser via `DevToolsActivePort` (any port, loopback host). If it returns, you're done.
2. **If that fails** with `No running browser with remote debugging detected`, the user needs to turn it on. Navigate to the inspect page in a running Chromium browser:
   ```bash
   # macOS — `open location "chrome://..."` alone fails (-10814) when the default
   # browser isn't a Chromium that registers the chrome:// scheme, and `open -a
   # <browser>` triggers the profile picker. So target a running Chromium by name
   # via AppleScript: it picks the frontmost one (the browser you're in) or the
   # first running candidate, and reuses the active profile. No browser hardcoded.
   osascript \
     -e 'set inspectURL to "chrome://inspect/#remote-debugging"' \
     -e 'set apps to {"Dia","Google Chrome","Chromium","Microsoft Edge","Brave Browser","Arc","Vivaldi","Opera","Comet","Aside","Google Chrome Canary"}' \
     -e 'set target to ""' \
     -e 'tell application "System Events"' \
     -e 'set frontApp to name of first application process whose frontmost is true' \
     -e 'if frontApp is in apps then' \
     -e 'set target to frontApp' \
     -e 'else' \
     -e 'repeat with appName in apps' \
     -e 'if exists process appName then' \
     -e 'set target to appName' \
     -e 'exit repeat' \
     -e 'end if' \
     -e 'end repeat' \
     -e 'end if' \
     -e 'end tell' \
     -e 'if target is not "" then' \
     -e 'tell application target to open location inspectURL' \
     -e 'end if'

   # Linux — replace with the detected browser binary name
   # e.g. dia, google-chrome, chromium, brave-browser
   <browser-binary> 'chrome://inspect/#remote-debugging'

   # Windows (PowerShell)
   Start-Process <browser-binary> 'chrome://inspect/#remote-debugging'
   ```
   Only macOS's AppleScript path auto-detects the running browser and avoids the profile picker; Linux/Windows need the binary name and may prompt the user to pick a profile first.
3. **Tick "Discover network targets"** in the browser's inspect page, then click **Allow** when the browser prompts.
4. **If auto-detect picks the wrong browser** (multiple running, you want a specific one): list them with `await detectBrowsers()`, then `await session.connect({ profileDir: <the one you want> })`.
5. **If `session.connect()` returns `No detected browser accepted a connection`**, the user has remote-debugging on but hasn't clicked **Allow** yet. Tell them to click it and retry, or pass `timeoutMs: 30000` to wait for the click.

## Working with targets (tabs)

- **Filter browser internals.** `listPageTargets()` already drops `chrome://` and `devtools://` URLs. If you call `Target.getTargets()` directly, filter manually.
- **CDP target order ≠ visible tab-strip order.** When the user says "the first tab I can see", use a screenshot or page title to identify it — `Target.activateTarget` only switches to a known targetId.

## Looking up a method

The full typed surface is in `<skill-dir>/sdk/generated.ts` (~655 KB, only loaded if you read it). Each method has its CDP description as a JSDoc comment plus typed `*Params` / `*Return` interfaces in per-domain namespaces.

```bash
grep -n "navigate" <skill-dir>/sdk/generated.ts | head
```

## Regenerating the SDK

When the upstream protocol JSONs change, replace `sdk/browser_protocol.json` and/or `sdk/js_protocol.json` and re-run:

```bash
cd <skill-dir>/sdk && node gen.ts
browser-harness-js --restart   # pick up the new bindings
```

## Files

All paths are relative to `<skill-dir>` (the install path — see top of this doc).

- `/usr/local/bin/browser-harness-js` → `<skill-dir>/sdk/browser-harness-js` (the CLI)
- `sdk/repl.ts` — HTTP server (`node:http` on `127.0.0.1:9876`)
- `sdk/session.ts` — `Session` class (transport, connect, target routing, events)
- `sdk/axview.ts` — `axView(nodes, opts)`: compressed accessibility-tree projection, injected as a global (see `interaction-skills/snapshot.md`)
- `sdk/generated.ts` — codegen output: every CDP method as a typed wrapper
- `sdk/gen.ts` — codegen script
- `sdk/{browser,js}_protocol.json` — upstream protocol (vendored)
- `interaction-skills/` — CDP how-to guides (screenshots, tabs, network requests, etc.)
