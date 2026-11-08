# Porting learnings to the Page API

Contract for moving a `learnings/<domain>/tools/*.mjs` node-tool from the legacy singleton session (`ctx.session`, `session.use`, `listPageTargets`, `attachTab`, `ctx.cdp`) to the Page API. A port changes **how the tool reaches its tab**, never **what the tool does**. Check a folder with `node skills/cdp/learnings/check-port.mjs <domain>`.

Reference ports: `example/tools/get-outline.mjs` (default page) and `localhost-dev-page/tools/click-and-verify.mjs` (own `Browser` against another browser).

## 1. The ctx contract

`learnings(domain, tool, args)` builds one ctx per node-tool call. Everything the old ctx had is still there for unported tools. New fields:

| Field | Meaning |
|---|---|
| `ctx.page` | `Page` or `null`. Resolved before the tool runs: `args.targetId` if given, else the tab the REPL's `session.use()` last selected, else `null`. Never throws. |
| `ctx.pageError` | Why `ctx.page` is `null` (attach failed, no http(s) origin), else `undefined`. |
| `ctx.requirePage()` | Returns `ctx.page` or throws a clear error naming `pageError`. Use it in tools that act on "the current tab". |
| `ctx.findPage(match, opts?)` | `match` is a URL **prefix** string or a `RegExp` (tested anywhere in the URL; `g`/`y` flags ignored). Polls open page targets for up to `opts.waitMs` (default 2000), takes the **first** match, attaches it, returns the `Page`. Throws `findPage: no open page matches ...` listing the open URLs. |
| `ctx.attachPage(targetId, opts?)` | Attaches an explicit target (for example one you just made with `ctx.session.Target.createTarget`). |
| `ctx.browser` | The upstream `browser` global: `ctx.browser.tabs()` lists page targets, `ctx.browser.session` carries events and `waitFor`. For a different browser, build your own `Browser` (section 5). |

`opts` for `findPage` / `attachPage`: `allowedOrigins` (extra exact origins), `timeoutMs` (per-call Page timeout, 1..60000, runner default **60000**, not the Page default of 10s), `waitMs` (findPage only).

Rules the runner applies, so tools do not:

- **Origin allowlist.** Derived as: the tab's own http(s) origin, plus `opts.allowedOrigins`, plus `https://<d>` for every manifest `domains` entry. It only gates `page.info()`, `page.snapshot()`, `page.goto()` and locators. `page.cdp(...)` is the raw escape hatch and is not origin-checked. A tool that must read a page after it redirects to another origin (login, SSO) passes that origin in `allowedOrigins`, or sticks to `page.cdp`.
- **Lifetime.** Every Page the runner hands out (`ctx.page`, `findPage`, `attachPage`) is disposed when the tool returns or throws: the attachment is detached, the tab stays open. Never keep a Page in module state across calls; call `ctx.findPage` again.
- **No pointer.** None of this touches `session.use` or the active session. Do not call `ctx.session.use`, `getActiveSession`, `setActiveSession` in a ported tool.
- **Serialized.** Calls on one `Page` run one at a time, in order. Two awaited `page.cdp` calls started together run back to back, not in parallel. A call that blocks until a second call on the same Page fires would deadlock; restructure it into one in-page expression.
- **Ceiling.** A single `page.cdp` call is capped at 60 s. A longer in-page wait is split into a loop of shorter evaluates.

`browserTools` (JS strings in `browser-tools/`) are unchanged by this work; they still evaluate on the REPL's active session. Do not touch them.

## 2. Mapping table

| Before | After |
|---|---|
| `const t = (await ctx.listPageTargets()).find(t => t.url.startsWith(X)); await ctx.session.use(t.targetId)` | `const page = await ctx.findPage(X)` |
| `.find(t => t.url.includes("a.b"))` | `ctx.findPage(/a\.b/)` (escape dots) or a real prefix `"https://a.b/"` when that is what the filter meant |
| `.find(t => new URL(t.url).origin === DASH)` | `ctx.findPage(DASH + "/")` |
| `.filter(...)[n]`, "pick by title", "is my saved tabId still open" | `const tabs = await ctx.browser.tabs()` (same objects as `listPageTargets`), choose, then `await ctx.attachPage(tab.targetId)` |
| `const { targetId } = await ctx.session.Target.createTarget({ url, background: true }); await ctx.session.use(targetId)` | keep the `createTarget` line verbatim, replace `use` with `const page = await ctx.attachPage(targetId, { allowedOrigins: [<origin>] })` |
| `await ctx.session.Target.closeTarget({ targetId })` in `finally` | **unchanged** |
| `ctx.session.Domain.method(params)` | `await page.cdp("Domain.method", params)` |
| `ctx.session.domains.Domain.method(params)` | same as above |
| `attachTab(ctx, id)` returning `{ sid, send }` plus `ctx.cdp(sid, m, p)` | `const page = await ctx.attachPage(id)`; `send = (m, p = {}) => page.cdp(m, p)` |
| global `attachTab(match)` / `waitForUrl` / `evalFile` / `deepQuery` (explicit sessionId) | `ctx.findPage(match)`; the helper body becomes `page.cdp("Runtime.evaluate", ...)` |
| `ctx.session.onEvent(fn)` | `ctx.browser.session.onEvent((method, params, sessionId) => { if (sessionId !== page.scope.sessionId) return; ... })` |
| `ctx.session.closeTab(targetId, sessionId)` | `ctx.session.closeTab(targetId, page.scope.sessionId)` |
| `ctx.session._call("Target.x", ...)` | **unchanged** (browser-level) |

Stays on `ctx.session` because it is browser-level and never reads the pointer: every `Target.*` (`createTarget`, `closeTarget`, `getTargets`, `activateTarget`, `createBrowserContext`), every `Browser.*` (`setDownloadBehavior`, window bounds), and `closeTab`. `check-port.mjs` allows exactly these.

Everything else goes through `page.cdp`: `Runtime`, `Page`, `DOM`, `Input`, `Network`, `Emulation`, `Fetch`, `Accessibility`, `Overlay`. The return value is the same object the typed wrapper returned (`const { result, exceptionDetails } = await page.cdp("Runtime.evaluate", {...})`), so destructuring does not change.

Do not replace `Page.navigate` with `page.goto`, or `Input.dispatchMouseEvent` with `locator.click`. They add origin checks, snapshots and different waits. Same CDP method, same params, through `page.cdp`.

### Before / after: find an existing tab

```js
// before
const targets = await ctx.listPageTargets();
const tab = targets.find((t) => t.url.startsWith("https://dashboard.example.com/"));
if (!tab) throw new Error("no dashboard tab open; open one and sign in first");
await ctx.session.use(tab.targetId);
await ctx.session.Network.enable({});
const { result } = await ctx.session.Runtime.evaluate({ expression: "location.href", returnByValue: true });

// after
const page = await ctx.findPage("https://dashboard.example.com/");   // throws when absent
await page.cdp("Network.enable", {});
const { result } = await page.cdp("Runtime.evaluate", { expression: "location.href", returnByValue: true });
```

Keep the tool's own "no tab open" message when it is part of the documented behavior: wrap `findPage` in `try/catch` and rethrow the old message.

### Before / after: a tab the tool opens

```js
// before
const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
try {
  await ctx.session.use(targetId);
  await wait(7000);
  const r = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
} finally {
  try { await ctx.session.Target.closeTarget({ targetId }); } catch { /* already gone */ }
}

// after
const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
try {
  const page = await ctx.attachPage(targetId, { allowedOrigins: [new URL(url).origin] });
  await wait(7000);
  const r = await page.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
} finally {
  try { await ctx.session.Target.closeTarget({ targetId }); } catch { /* already gone */ }
}
```

On Helium a tab created with a URL sits at `about:blank` for about 150 ms and then navigates, sometimes twice. That is why the contract uses `createTarget` + `attachPage` (attaching does not navigate or check the URL) and the tool's own wait, and **not** `ctx.browser.open(url, ...)`, which creates `about:blank` and then `goto`s and fails on Helium with `Navigation outcome_unknown: net::ERR_ABORTED` or `origin_denied`. Never loop on a `browser.open` failure. Attach to existing tabs with `ctx.findPage`, which waits for the URL to match instead of failing at once.

### Before / after: local helper shim (preferred for big files)

When a file funnels every call through one local helper, port the helper once and leave the call sites alone:

```js
// before (mail-google-com)
async function attachTab(ctx, targetId) {
  const { sessionId } = await ctx.session._call("Target.attachToTarget", { targetId, flatten: true });
  return { sid: sessionId, send: (method, params = {}) => ctx.cdp(sessionId, method, params) };
}

// after
async function attachTab(ctx, targetId) {
  const page = await ctx.attachPage(targetId);
  return { page, send: (method, params = {}) => page.cdp(method, params) };
}
```

If call sites read `tab.sid`, replace those reads with `tab.page.scope.sessionId`.

## 3. Domains, enables and events

- `Page.enable` is already done on every attached Page. `DOM.enable`, `Network.enable`, `Fetch.enable`, `Log.enable`, `Runtime.enable` are per attachment: call them through `page.cdp` exactly where the old code called them, and `DOM.getDocument` before `DOM.querySelector*` as before. Each `ctx.attachPage` / `findPage` is a fresh attachment, same as the old `session.use`.
- `Page` has **no event waiter**. `page.signals()` only returns a fixed, drained set (dialog open/close, file chooser, download start/progress, window open, frame navigated, crash). For anything else, listen on the shared session and filter by the Page's sessionId:

```js
const sid = page.scope.sessionId;
let found = null;
const off = ctx.browser.session.onEvent((method, params, sessionId) => {
  if (sessionId !== sid || found || method !== "Network.requestWillBeSent") return;
  found = params.request.headers.authorization ?? null;
});
try {
  await page.cdp("Network.enable", {});
  await page.cdp("Page.reload", {});
  const deadline = Date.now() + 25000;
  while (!found && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
} finally { off(); }
```

  One-shot waits: `await ctx.browser.session.waitFor({ method: "Page.loadEventFired", sessionId: sid, timeoutMs: 15000 })`. Browser-domain events (`Browser.downloadWillBegin` after `Browser.setDownloadBehavior({ eventsEnabled: true })`) carry **no** `sessionId`; filter on method only.
- Always call the returned `off()` in a `finally`.
- A JavaScript dialog blocks `Runtime.evaluate` on its page. Check `page.signals().events` for `Page.javascriptDialogOpening` if the tool has to cope with one; do not add this to tools that did not before.

## 4. Reads: when to swap an evaluate for `page.info()` / `page.snapshot()`

**Default: keep the `Runtime.evaluate` expression verbatim through `page.cdp`.** Swap only when all of these hold:

1. The old read is exactly `({url: location.href, title: document.title, ...})` and the tool uses only the fields `page.info()` returns (`url`, `title` truncated to 512 chars, `width`, `height`, `scrollX`, `scrollY`).
2. The tab's origin is guaranteed to be in the allowlist (otherwise `info()` throws `origin_denied`), and the tool is fine with `{ dialog }` being returned while a dialog is open.
3. The result shape the tool returns to its caller does not change.

`page.snapshot()` is never an equivalent of a hand-rolled DOM read (different shape, refs, redaction). Do not swap any DOM-scraping evaluate for it in a port. If a tool would benefit, note it in the learning's notes as a follow-up, do not do it here.

## 5. A tool that drives a different browser

A tool that deliberately avoids the daemon's browser (`localhost-dev-page`) opens its own `Browser`, which owns its own `Session` and WebSocket, and disconnects in `finally`:

```js
import { Browser } from "../../../sdk/browser.ts";   // from learnings/<domain>/tools/
const own = new Browser();
try {
  await own.connect({ port, host });
  const page = await own.attach(targetId, { allowedOrigins: [origin] });
  ...
} finally { own.disconnect(); }
```

`own.disconnect()` closes only that Session, never the daemon's. The runner does not manage a `Browser` you construct.

## 6. What must NOT change

- CSS selectors, XPath, text matchers, in-page JS strings (`expression:` values), regexes, URLs.
- Timing: every `wait(ms)`, retry count, polling interval and deadline stays the same number. Do not add or remove waits.
- `manifest.json`: tool names, `path`, `callable`, `args`, `returns`, `description`. `targetId` is a runner-level arg and is never declared in a manifest.
- Exported function names and what they return or throw (error message text included, unless the old message named `session.use` or `listPageTargets`).
- Order of side effects, and which steps are guarded by a `confirm` flag or stop before an irreversible action.
- Secrets handling (nothing printed or stored that was not before).
- Notes text. The only allowed edit is one line appended to `notes/overview.md`:
  `Ported to the Page API (see ../PORTING.md). live: verified.` or `live: unverified (<reason>).`
  A learning with only `browserTools` has no node-tool and gets no edit.
- Do not edit anything under `skills/cdp/sdk/`, `SKILL.md`, `README.md`, `package.json`, or another learning's folder.

Existing `tools/*.test.mjs` (app-notion-com, chrome-extensions, corp-delaware-gov, dvc-cutru) fake `ctx.session`. Update the fakes to supply `ctx.page` (and `ctx.requirePage`, `ctx.findPage`, `ctx.attachPage` as the tool needs) so the same assertions pass. Keep every assertion; only the plumbing changes.

## 7. Verification each porter runs

1. **Residue and load.** `node skills/cdp/learnings/check-port.mjs <domain>` for every folder in your batch. Required: `OK` (exit 0). `FAIL` means a broken import or manifest; `RESIDUE` means a legacy call is left. An exception is allowed only with a one-line comment in the tool saying why (for example an extension target that cannot be attached as a Page).
2. **Unit tests.** `node --test skills/cdp/learnings/<domain>/tools/*.test.mjs` where tests exist, and `cd skills/cdp/sdk && node --test *.test.ts` (0 fail).
3. **Live call on the headless browser** for every learning marked `public` below. Use **your batch's own ports** (three workers run at once):

   | Batch | `CDP_REPL_PORT` | Helium `--remote-debugging-port` |
   |---|---|---|
   | A | 9911 | 9341 |
   | B | 9912 | 9342 |
   | C | 9913 | 9343 |

   ```bash
   export PATH=$HOME/.local/share/mise/installs/node/24.18.0/bin:$PATH
   d=$(mktemp -d /tmp/lp-port.XXXX)
   /Applications/Helium.app/Contents/MacOS/Helium --headless=new --remote-debugging-port=9341 --user-data-dir=$d --no-first-run about:blank &
   export CDP_REPL_PORT=9911 CDP_REPL_LOG=/tmp/lp-port-a.log CDP_REPL_PID_FILE=/tmp/lp-port-a.pid
   cd skills/cdp/sdk && ./browser-harness-js 'await browser.connect({port: 9341})'
   ```

   Create the tab with `session.Target.createTarget`, wait until its `location.href` starts with the expected origin, then call `learnings("<domain>", "<tool>", { targetId, ...args })`. Never use port 9222 or 9876, never Han's profile, never `browser.open` (see section 2). Kill only the PIDs you started. If a public site blocks headless (captcha, consent wall), do not loop: mark `live: unverified (blocked headless)`.
4. **Logged-in sites** (`logged-in` below): no live call. Append `live: unverified (logged-in)` to `notes/overview.md`. `annas-archive` is never driven through a browser at all.
5. Commit inside your batch's folders only, `refactor(cdp): port <batch> learnings to the Page API`. Do not push, do not bump `package.json`.

## 8. The 27 learnings in 3 batches

Weight = count of legacy touchpoints (`ctx.session`, `ctx.cdp`, `listPageTargets`, `attachTab`, `session.use` and friends) in the tool files. `example` and `localhost-dev-page` are already ported and not listed.

| Batch | Learning | Weight | Live class | Notes |
|---|---|---|---|---|
| A | mail-google-com | 86 | logged-in | one local `attachTab` shim + `ctx.cdp`; port the helper (section 2), keep Gmail's real `Input.dispatchMouse*` clicks |
| A | discord-com | 6 | logged-in | |
| A | google-com-travel-flights | 6 | public | |
| A | booking-com | 6 | public | |
| A | annas-archive | 6 | never live | load check only |
| A | meta-business-suite | 2 | logged-in | |
| A | kbtt-tam-tru | 0 | n/a | `browserTools` only: run `check-port.mjs`, no edits |
| A | memo-d-foundation | 0 | n/a | `browserTools` only: run `check-port.mjs`, no edits |
| B | studio-youtube-com | 24 | logged-in | |
| B | facebook-com | 22 | logged-in | `post.mjs`, `reels.mjs` |
| B | dash-cloudflare-com | 20 | logged-in | `dash.mjs`, `forms.mjs` |
| B | linkedin-com | 17 | logged-in | |
| B | github-com | 12 | logged-in | `pat.mjs`, `set-org-avatar.mjs` |
| B | drive-google-com | 7 | logged-in | download path uses `Browser.setDownloadBehavior`: stays on `ctx.session` |
| B | admin-google-com | 7 | logged-in | |
| C | dvc-cutru | 19 | logged-in | `createBrowserContext` + `Browser.setDownloadBehavior({ browserContextId })` stay on `ctx.session`; has `cutru.test.mjs` |
| C | x-com | 11 | logged-in | |
| C | discord-com-developers | 11 | logged-in | |
| C | accounts-delawareregisteredagent-com | 11 | logged-in | local `attachTab` use |
| C | app-notion-com | 10 | logged-in | `workspace.test.mjs` fakes `ctx.sent`; keep its assertions |
| C | retail-sc-com | 8 | logged-in | local `attachTab` use |
| C | figma-com | 8 | logged-in | |
| C | appstoreconnect-apple-com | 7 | logged-in | |
| C | corp-delaware-gov | 7 | logged-in | has `tax.test.mjs` |
| C | chrome-extensions | 7 | logged-in | has `extensions.test.mjs`; its `setActiveSession(undefined)` dance exists to run `Target` calls without a pointer, so it disappears with the port; keep the test's intent |
| C | mail-proton-me | 6 | logged-in | uses `ctx.session.closeTab(targetId, sessionId)`: keep, pass `page.scope.sessionId` |
| C | alchemy-dashboard | 6 | logged-in | `onEvent` capture, use the section 3 snippet |

Totals: A 112, B 109, C 111 (A has 8 folders, B 7, C 12).
