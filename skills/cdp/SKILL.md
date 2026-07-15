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
| `browser-harness-js --status`   | Print health JSON (version, uptime, connected, sessionId) or exit 1 if down. |
| `browser-harness-js --version`  | Print the SDK version from the on-disk files (no daemon needed). |
| `browser-harness-js --start`    | Explicit start (no-op if already running). |
| `browser-harness-js --stop`     | Graceful shutdown. Drops session state. |
| `browser-harness-js --restart`  | Stop + start fresh. |
| `browser-harness-js --logs`     | `tail -f` the server log (`/tmp/browser-harness-js.log`). |
| `browser-harness-js --auto-allow '<js>'` | Set `session.autoAllow = true` on the daemon, then eval the JS. Auto-dismisses Dia's "Allow debugging connection?" prompt on connect (macOS). |

Env vars: `CDP_REPL_PORT` (default `9876`), `CDP_REPL_LOG` (default `/tmp/browser-harness-js.log`).

## API surface inside snippets

These globals are pre-loaded — no imports needed:

- `session` — the persistent `Session`. Has every CDP domain mounted: `session.Page`, `session.DOM`, `session.Runtime`, `session.Network`, … 56 domains, 652 methods total.
- `listPageTargets()` — list real page targets via CDP's `Target.getTargets` (works on Chrome 144+ too), with `chrome://` and `devtools://` URLs filtered out. No args — uses the connected session.
- `detectBrowsers()` — scan OS-specific profile dirs for running Chromium-based browsers with remote debugging on. Returns `[{name, profileDir, port, wsPath, wsUrl, mtimeMs}]`, sorted by most recently launched.
- `resolveWsUrl(opts)` — resolve a WS URL from `{wsUrl}` | `{port, host?}` | `{profileDir}`. For the no-args auto-detect flow, call `session.connect()` directly instead.
- `CDP` — the generated namespaces (`CDP.Page`, `CDP.Runtime`, …) for type-name reference.
- `axView(nodes, opts?)` — compressed accessibility-tree view: a pure projection over a raw `Accessibility.getFullAXTree`/`queryAXTree` result. Drops ~96% structural noise, assigns `[n]` refs → `backendDOMNodeId`. Options: `{ interactive, refs, maxDepth, redactSensitive }`. See `interaction-skills/snapshot.md`.
- `axDiff(prev, next)` / `parseAxRefs(view)` / `axClick(ref, refs)` / `axType(ref, refs, text)` — multi-step snapshot helpers (diff, ref map, click/type by ref). See `interaction-skills/snapshot.md`.
- `cdp(sessionId, method, params)` — call any CDP method on an **explicit** `sessionId` without touching the active-session pointer: `cdp(sid, 'Page.enable', {})`. The multi-tab primitive: the one-tab-per-call skills route every call this way so concurrent tabs never race `session.use`. Equivalent to `session._call(method, params, { sessionId })`.
- `session.closeTab(targetId, sessionId?)` — close a tab and detach: `window.close()` on the session, then `Target.closeTarget`. Fire-and-forget in a `finally` (`.catch(() => {})`) so cleanup is guaranteed and never blocks the return. Closes are serialized.

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

`interaction-skills/` holds pure-CDP recipes for mechanics that aren't obvious from the method list alone — dropdowns, drag-and-drop, OOPIFs, network waits, screenshots, recording cross-tab user actions, navigating + waiting for load, reading a JSON URL, recording media. The set grows, so **look, don't recall**: when a task isn't a straight method call (a framework that swallows clicks, a shadow-DOM trap, a wait-with-timeout, multi-tab anything), browse before improvising.

Start here for the patterns every skill shares: [`lifecycle-readiness.md`](interaction-skills/lifecycle-readiness.md) (navigate + wait for load, the one-tab-per-call shape), [`json-navigation.md`](interaction-skills/json-navigation.md) (read a JSON URL), [`media-capture.md`](interaction-skills/media-capture.md) (record `MediaSource` / hook a native API before navigate).

```bash
ls <skill-dir>/interaction-skills/
grep -l <keyword> <skill-dir>/interaction-skills/*.md
```

Each recipe leads with the shortest CDP call that works, then the trap — in `session.Domain.method(...)` form, no wrapped helpers — so it drops straight into a snippet. If the mechanic you need isn't there, that's a gap worth filing as a new recipe.

### Finding elements: accessibility tree over selectors

For a named element (a button, link, textbox, heading), prefer the accessibility tree over CSS selectors — it finds by semantic role + accessible name (Playwright's `getByRole`/`getByText` model) and crosses shadow boundaries. Two tools, by task:

- **Targeted find** (you know the role/name): `session.Accessibility.queryAXTree` — ~30 tokens. Needs a DOM `nodeId` (from `session.DOM.getDocument`) and the active session (`session.use` first; the bare `{role, accessibleName}` form errors, and the `cdp(sessionId, …)` route hangs). No `Accessibility.enable` needed.
- **Explore an unfamiliar page** (don't know what to ask for, pick from many, summarize layout): `axView(nodes, { interactive: true })` first over `session.Accessibility.getFullAXTree({})`, then full `axView(nodes)` if needed — compressed snapshot with `[n]` refs. Multi-step: keep the previous string and use `axDiff(prev, next)`.

```js
await session.use(targetId)
const { root } = await session.DOM.getDocument({})
// Targeted: find a button labeled "Submit"
const { nodes } = await session.Accessibility.queryAXTree({ nodeId: root.nodeId, role: 'button', accessibleName: 'Submit' })
const node = nodes.find(n => !n.ignored)   // node.backendDOMNodeId → DOM.getBoxModel → Input.dispatchMouseEvent

// Explore: interactive-first compressed snapshot
const { nodes: ax } = await session.Accessibility.getFullAXTree({})
return axView(ax, { interactive: true })
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

**Auto-dismissing Dia's Allow prompt (macOS).** Dia gates the debugging connection behind an `Allow debugging connection?` prompt whose default button is **Return** — and among Chromium browsers, *only* Dia shows it. Pass `autoAllow: true` and the SDK fires a Return at the Dia process via `osascript` the moment the WS-open stalls, so connect completes with no manual click:

```js
await session.connect({ autoAllow: true })
```

Or set it persistently on the daemon so every connect (and auto-heal reconnect) inherits it:

```bash
browser-harness-js --auto-allow 'await session.connect()'
```

`autoAllow` is a no-op for non-Dia browsers and on non-macOS. It needs **macOS Accessibility** for the process running `browser-harness-js` (the `node` binary). If it's missing, the keystroke is dropped — `osascript` errors `-25211: not allowed assistive access` and `connect` stalls to `timeoutMs` instead of finishing in ~1s. Grant it once: System Settings → Privacy & Security → Accessibility → add/toggle `node` (the grant is per binary path, so mise/nvm/asdf need a re-grant per version; Homebrew's stable path persists). Tunable via `autoAllowDelayMs` (default 600ms — a live WS opens in ~100ms, so 'still connecting at 600ms' reliably means the prompt is up).

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

For a fresh tab per call (the skill pattern — safe to run in parallel), route each call to an explicit `sessionId` with the `cdp(sessionId, method, params)` global and clean up with `session.closeTab(...)` in `finally`, without ever calling `session.use`. See [`lifecycle-readiness.md`](interaction-skills/lifecycle-readiness.md) (One tab per call).

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

1. **Try `await session.connect()` first** (see [Connecting](#connecting)). If it fails with `No running browser with remote debugging detected`, turn remote debugging on — open the inspect page in a running Chromium browser:
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
2. **Tick "Discover network targets"** in the browser's inspect page, then click **Allow** when the browser prompts.
3. Retry `await session.connect()`. If it picks the wrong browser, use `detectBrowsers()` + `{ profileDir }`; if it's still waiting on the Allow click, pass `timeoutMs: 30000` — see [Connecting](#connecting).

## Working with targets (tabs)

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

Reinstalling (`npx skills add`) updates the files on disk but not the long-lived daemon — a newly-documented global then throws `ReferenceError: <global> is not defined` until you `--restart`. Compare `browser-harness-js --version` (disk) to the `version` in `--status` (daemon memory) to detect it; see [Connection: Stale daemon](interaction-skills/connection.md).

## Files

All paths are relative to `<skill-dir>` (the install path — see top of this doc).

- `/usr/local/bin/browser-harness-js` → `<skill-dir>/sdk/browser-harness-js` (the CLI)
- `sdk/repl.ts` — HTTP server (`node:http` on `127.0.0.1:9876`)
- `sdk/session.ts` — `Session` class (transport, connect, target routing, events)
- `sdk/axview.ts` — `axView` / `axDiff` / `parseAxRefs`: compressed accessibility-tree projection + helpers, injected as globals (see `interaction-skills/snapshot.md`)
- `sdk/generated.ts` — codegen output: every CDP method as a typed wrapper
- `sdk/gen.ts` — codegen script
- `sdk/{browser,js}_protocol.json` — upstream protocol (vendored)
- `interaction-skills/` — CDP how-to guides (screenshots, tabs, network requests, lifecycle readiness, JSON navigation, media capture, etc.)
