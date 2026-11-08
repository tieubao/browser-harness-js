# Scoped accessibility snapshots

Use `page.snapshot()` for page reading. It owns native AX collection, projection,
refs and diff state; callers do not assemble or parse a separate ref map.

For a faster first look at an unfamiliar page, `domView()` (a single `Runtime.evaluate`) is still available; see [Compatibility layer](#compatibility-layer-domview-and-axview) at the end of this file.

```js
const shot = await page.snapshot();
return { tree: shot.tree, diff: shot.diff, truncated: shot.truncated, omissions: shot.omissions };
```

Typical tree:

```text
url: "https://example.com/"
- RootWebArea "Fares" [ref=sAb3dEf6hJk9m_2e1]
  - textbox "Destination" [ref=sAb3dEf6hJk9m_2e2] value="Paris"
  - group "Outbound" [ref=sAb3dEf6hJk9m_2e3]
    - button "Select" [ref=sAb3dEf6hJk9m_2e4]
  - table "Prices" [ref=sAb3dEf6hJk9m_2e5]
    - row [ref=sAb3dEf6hJk9m_2e6]
      - cell "100" [ref=sAb3dEf6hJk9m_2e7]
```

## Options

| Option | Default | Contract |
|---|---|---|
| `interactive` | `false` | Keep controls and their meaningful ancestors; omit reading text |
| `maxDepth` | `50` | 0–100 emitted levels; truncation is explicit |
| `maxChars` | `50000` | 1–1000000 characters; overflow throws and publishes no new refs |
| `selector` | none | Exactly one standard CSS subtree in the main frame, or specified `frameId` |
| `ref` | none | Subtree rooted at a ref from the immediately preceding snapshot |
| `frameId` | all permitted | One frame; also available as `page.frame(frameId).snapshot(options)` |

`ref` and `selector` are mutually exclusive. `timeoutMs` and `signal` bound
operations. A scoped snapshot replaces the previous snapshot/ref generation,
just like a full snapshot. The URL header remains the top-level page's URL.

Projection is **CDP-native**, not a second DOM accessibility implementation. It
reads `AXNode.value` (including numbers and false/empty values), keeps named
structure and table relations, traverses ignored wrappers, and handles forests
without dropping query-result siblings. Redundant text is suppressed only when
the equivalent parent name is actually emitted. Protected/password-like values
and their descendants are redacted; labels remain. This is conservative
redaction, not a promise to detect all secrets in page content.

## Frame scope

`page.frames()` returns permitted frames with IDs and attachment metadata.
Snapshots include same-process frames and OOPIFs (cross-process iframes).
OOPIF attachment requires a frame owner in an already-authorized renderer;
unrelated iframe targets elsewhere in the browser are not attached. Each
frame's origin is checked separately. Denied/unavailable frames appear in
`omissions` and set `truncated:true`, rather than silently disappearing.

Limits include 64 readable frames, 128 iframe targets examined during
discovery, 50,000 AX nodes per frame and 512 source nesting levels. These are
deliberate bounds. Denied frames (cross-origin ads, trackers) are listed in
`omissions` but never read, so they do not count toward the frame limit.
Current subtree/interactive options reduce rendered output, **not the initial
full-frame AX transfer**. Huge native responses can still hit transport limits;
use explicit scoped raw AX queries when wire size is the problem.

## Refs are evidence, not authority

```js
return await page.locator('sAb3dEf6hJk9m_2e4').click({
  verify: next => next.tree.includes('Selected')
});
```

Refs include a snapshot generation and optional frame prefix. Their backend node
IDs stay private. Another snapshot, action, raw call or lifecycle invalidation
expires them. Before any effect, the locator checks the current document and
semantic identity, then the guard creates and revalidates a separate one-use
action handle. A replaced, disabled, private, occluded or unsupported target
does not become a coordinate click; the blocked reason says which it was and
the next move. Frame refs currently support reading only;
actions return `frame_actions_unsupported`.

Use `page.getByRole('button', {name:'Select', context:'group: Outbound'})`
when the intended semantics should be resolved anew. Role matching is exact by
default and requires exactly one match across the requested, complete scope;
it never selects the first candidate. Resolution reads that scope up to the
1,000,000-character maximum, so role locators work on pages larger than the
50,000-character snapshot default. Frames nothing can read or act in (denied
cross-origin ads and trackers, frames not yet committed) cannot hold a match, so
they do not make the scope incomplete; a depth-cut render or an allowed frame
that could not be read still refuses as incomplete. CSS is strict within one frame and does
not pierce shadow roots; native AX role lookup can see through them.

## Managed diffs

The first snapshot (or a changed scope) returns the full tree as `diff`. Later
matching scopes produce added/removed lines; printed ref churn is ignored using
private frame/node identity. Duplicate counts and reorder-only changes remain
visible. An unchanged snapshot returns `(no changes)`. Diffs are not patches and
are not evidence that an action achieved its goal.

A snapshot cannot expose a canvas editor's internal document or decide whether
a consent wall is the intended page. Use an explicit screenshot/read-back for
those cases; see [rich-editors.md](rich-editors.md).

## Compatibility layer: domView and axView

Deprecated but working. These globals predate the Page API and stay registered so existing skills and learnings keep running. New work should use `page.snapshot()`. Name collisions with the Page API: none (the old names are free-standing globals; the new ones live on `browser` / `page`).

| Old global | Page API equivalent |
|---|---|
| `axView(nodes, opts)` over `getFullAXTree` | `page.snapshot(options)` |
| `axDiff(prev, next)` | `snapshot.diff` (managed per scope) |
| `axClick(ref, refs)` / `axType(ref, refs, text)` | `page.locator(ref).click()` / `.fill(text)` |
| `parseAxRefs`, `parseAxLocators`, `resolveLocator` | `page.getByRole(role, {name})` |
| `pageInfo()` / `drainSignals()` | `page.info()` / `page.signals()` |

The old docs follow, unchanged apart from heading levels and the domView section adapted to sit beside `page.snapshot()`.

### domView: the fast first read

`domView(opts?)` is the fast first read for exploring an unfamiliar page. It sits beside `page.snapshot()`, it does not replace it: `domView` reads, `page.snapshot()` plus `page.locator()` / `page.getByRole()` is the guarded way to act with verification. One `Runtime.evaluate` reads the visible, enabled controls (role, accessible name, value, state) straight from the DOM and returns a `[n] role "name" ="value"` table. The live nodes stay in `window.__domView` inside the page, so `domClick(n)` / `domType(n, text)` resolve the ref in-page, scroll it into view, hit-test its center, and click with trusted `Input.dispatchMouseEvent`. No `getFullAXTree`, no trailing refs map. Ported from browser-use/jev-ultrafast (MIT); source `sdk/domview.ts`.

```js
await domView()                          // viewport controls only
await domView({ viewport: false })       // whole page
await domView({ text: true })            // + visible text (viewport, light DOM, 6000 chars max)
await domView({ options: true })         // + <select> option labels (first 20, then "+N more")
await domClick(3); await domType(2, 'query')
```

Options: `viewport` (default true), `text` (default false), `max` (default 250 controls), `options` (default false), `redactSensitive` (default true, password values print `="[redacted]"`). Open shadow roots are walked, including nested ones, and names resolve inside them; closed roots are unreachable from page script, so use `axView` there. Refs are valid for the latest `domView()` only; a navigation or removed node gives a clear `unknown ref` / `stale ref` error. Unlike axView, repeated calls overwrite the ref map.

Measured on five public pages, headless Helium, 7 runs each (full table in `sdk/bench/RESULTS.md`):

| | axView interactive | domView | domView `viewport:false` |
|---|---|---|---|
| Time (median) | 8 to 80 ms | 1.5 to 6.2 ms | 1.5 to 8.2 ms |
| Output | 4.6K to 35.9K chars | 0.9K to 4.5K chars | 3.4K to 20.3K chars |

domView is 5x to 22x faster and, like for like (whole page), 1.4x to 2.7x smaller. The shadow walk costs under 1 ms on these pages and made MDN's search, Log in and theme switch appear. Pick by these rules:

| Situation | Pick |
|---|---|
| Explore a page fast, find a field/link/button, repeated reads on a big page | `domView()` |
| Need the whole page's controls, not just the viewport | `domView({ viewport: false })` |
| Need a `<select>`'s choices | `domView({ options: true })` |
| Act with origin guard, strict single-target resolution and a verified receipt | `page.snapshot()` + `page.getByRole()` / `page.locator()` |
| Need landmarks, headings, tables, named context, scoped diffs, or frames | `page.snapshot()` |
| Closed shadow roots, canvas | `page.snapshot()`, then a screenshot |
| Legacy flows that already use `[n]` refs, `axDiff` or `loc=` locators | `axView` (below) |
| `domView` found nothing or misses a control | `page.snapshot()`, then a screenshot |

`domClick` / `domType` act through unguarded trusted input: they do not check origins or actionability and return no receipt. Use them for reading-adjacent exploration or on pages you already trust; use the Page API for anything that must be guarded.

Both are one CDP call, so call count is not the difference; speed and tokens on large pages are.

### axView: compressed a11y snapshot (legacy)

When you need to *see* the whole page at once (to explore an unfamiliar UI, pick from many options, or summarize layout), snapshot the accessibility tree, compressed. This is the **structure** tool (for plain explore-and-act, start with [`domView`](#domview-the-fast-first-read)); for finding one named thing, [`Accessibility.queryAXTree`](accessibility-tree.md) is cheaper and more precise. Use the snapshot when you don't yet know what to ask for.

`Accessibility.getFullAXTree` returns every node verbatim — `sources`, `chromeRole`, ignored wrappers, `InlineTextBox` fragments. On a real page that's **hundreds of thousands of tokens** (a Wikipedia article: 886K). The raw dump is unusable in context. `axView` drops the ~96% that is structural noise and keeps interactive elements + text, assigning `[n]` refs you can act on. Measured on a live Wikipedia article: **886K → 22K tokens**; on an app page: **210K → 7K**. All interactive nodes and content preserved.

This stays **CDP-native**: pure projection over already-fetched AX nodes. No page injection. Refs map to `backendDOMNodeId` for `DOM.*` / `Input.*`.

### Globals

| Global | Role |
|---|---|
| `axView(nodes, opts?)` | Compress AX nodes → tree string (+ optional ref map) |
| `axDiff(prev, next)` | Structural diff of two `axView` strings (refs stripped for compare) |
| `parseAxRefs(view)` | `Map<refNumber, backendDOMNodeId>` from a view string |
| `axClick(ref, refs)` | Click center of a ref (`refs` = Map or the view string) |
| `axType(ref, refs, text)` | Click-focus then `Input.insertText` |
| `domView(opts?)` / `domClick(ref)` / `domType(ref, text)` | One-call DOM snapshot and its click/type (see [domView](#domview-the-fast-first-read)) |

Source: `sdk/axview.ts` + thin helpers in `sdk/repl.ts`. Heuristics are transparent; for power they don't cover — exact `properties`, table grids, custom roles — drop to raw `getFullAXTree` and transform yourself.

### Options

```js
axView(nodes)
axView(nodes, { interactive: true })   // actionable structure only — start here
axView(nodes, { refs: false })         // omit trailing ref map when only reading
axView(nodes, { maxDepth: 4 })         // cap emit depth
axView(nodes, { redactSensitive: false }) // keep password-ish values (default: redact)
axView(nodes, { locators: true })     // emit loc=role:R["N"] per ref — survive refMap rebuilds
```

| Option | Default | Meaning |
|---|---|---|
| `refs` | `true` | Trailing `# refs -> backendDOMNodeId` map |
| `interactive` | `false` | Keep interactive roles + landmarks only (drop bulk StaticText / named content) |
| `maxDepth` | unlimited | Max emit depth from root |
| `redactSensitive` | `true` | Password-ish / protected textbox values → `="[redacted]"` (labels stay) |
| `locators` | `false` | Append a stable `loc=role:R["N"]` per ref so it survives snapshot rebuilds (the `[n]` ref map is one-snapshot only). Costs ~5 tokens per kept element; opt in for multi-step loops whose refs go stale. Resolve via `parseAxLocators(view)` → `axClick(loc)` / `resolveLocator(loc)`. |

### Reading escalation (legacy flow)

Don't dump the full tree first. `domView()` is the fast first read; escalate only as needed (or switch to `page.snapshot()` above):

1. **`domView()`**: to explore and act. One call, 5x to 22x faster than the AX route on the benchmark pages, walks open shadow roots. `domClick` / `domType` act on its refs.
2. **`axView(nodes, { interactive: true })`**: when the page needs structure (landmarks, headings, tables), has closed shadow roots, cross-origin iframes or canvas, or `domView` found nothing.
3. **`axView(nodes)`**: full compressed tree when you need surrounding text / headings / content.
4. **Wait briefly and re-fetch** only if the page is still changing (SPA hydration, live lists).
5. **Visual check**: `Page.captureScreenshot` when every read is empty, contradictory, or canvas/non-semantic.

After an action in a multi-step loop, prefer **`axDiff(prev, next)`** over re-reading the whole next tree in the model context. Keep `prev`/`next` as strings in the REPL; print only the diff.

```js
const { nodes: a } = await session.Accessibility.getFullAXTree({})
const prev = axView(a, { interactive: true })
// ... act ...
const { nodes: b } = await session.Accessibility.getFullAXTree({})
const next = axView(b, { interactive: true })
return axDiff(prev, next)
```

Never guess refs. Never truncate a snapshot with `slice` / `substring` and pretend it's complete — if it's too big, use `{ interactive: true }`, `{ maxDepth }`, or scope with `getPartialAXTree` / `queryAXTree`.

### Snapshot the active tab

```js
if (!session.isConnected()) await session.connect()
const tabs = await listPageTargets()
if (!session.getActiveSession()) await session.use(tabs[0].targetId)
await session.Page.enable()
const { nodes } = await session.Accessibility.getFullAXTree({})
return axView(nodes, { interactive: true })
```

Output is an indented tree with `[n]` refs on interactive + named nodes, a trailing `# refs -> backendDOMNodeId` map, and state flags (`<focused checked selected pressed expanded disabled scrollable>`, plus `<mixed>` for tri-state checkboxes, `(h2)`, `="value"`):

```
[1] RootWebArea "Chromium (web browser) - Wikipedia"
  [2] link "Jump to content"
  banner
    [3] navigation "Site"
      [4] button "Main menu"
    search
      [8] searchbox "Search Wikipedia"
      [9] button "Search"
    [13] link "Log in"
  [14] navigation "Contents"
    [15] heading "Contents" (h2)
    [17] link "(Top)"
    [18] link "Licensing"
```

### Acting on a ref

Prefer the helpers (same geometry path as manual CDP):

```js
const { nodes } = await session.Accessibility.getFullAXTree({})
const view = axView(nodes, { interactive: true })
const refs = parseAxRefs(view)
await axClick(9, refs)            // or axClick(9, view)
await axType(8, refs, 'query')    // focus searchbox + insertText
```

Manual path (identical mechanics, useful when you already have `backendNodeId`):

```js
const backendNodeId = parseAxRefs(view).get(7)
const { model } = await session.DOM.getBoxModel({ backendNodeId })
const [x, y] = model.content.slice(0, 2), w = model.width, h = model.height
await session.Input.dispatchMouseEvent({ type: 'mousePressed',  x: x + w/2, y: y + h/2, button: 'left', clickCount: 1 })
await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: x + w/2, y: y + h/2, button: 'left', clickCount: 1 })
```

For textboxes without `axType`: click to focus, then `Input.insertText`.

**Refs are only valid for the `getFullAXTree` call that produced them.** After navigation, mutation, or many async updates, re-snapshot before acting. Never cache a ref across a page change.

### What it drops (and when to drop below it)

Dropped: `ignored` nodes (bubbled — their children survive at the parent's depth), `InlineTextBox`/`ListMarker`/`LineBreak` leaf fragments, and structural wrappers (`generic`, `none`, `paragraph`, `list`, `listitem`, `table`, `row`, `cell`, `section`, `div`) whose children bubble up. Redundant text is coalesced: a `link "Donate"` whose only child is `StaticText "Donate"` keeps just the link line.

Kept (full mode): every interactive role (incl. `canvas`), headings (with level), landmarks, images with names, and surviving text.

Kept (`interactive: true`): interactive roles + landmarks only (plus ancestors needed to keep structure).

Sensitive values: password-ish / protected textbox values render as `="[redacted]"` by default.

Drop to raw `getFullAXTree` when:
- **Table grid structure matters** — `table`/`row`/`cell` are dropped, so tabular data flattens to a list. If row/column position is signal, snapshot raw or query the table subtree.
- **You need `sources` or exact `properties`** — the compression trims state to common flags. For `required`, `readonly`, `invalid`, `describedby`, read the raw node or `queryAXTree` that one element.
- **A named structural node is meaningful** — e.g. `<time>`/`relative-time` date labels (role `generic`) vanish with the wrapper; `queryAXTree({ accessibleName })` recovers them. Or edit the role sets in `sdk/axview.ts`.

### When to snapshot vs query

| Task | Tool | Cost |
|---|---|---|
| Find one named element ("the Log in link", "the Submit button") | `queryAXTree` (see [`accessibility-tree.md`](accessibility-tree.md)) | ~30 tokens |
| List all of one role (all headings, all links) | `queryAXTree` with just `role` | ~hundreds of tokens |
| Explore actionable UI first | `axView(nodes, { interactive: true })` | smaller than full |
| Explore full layout / content | `axView(nodes)` | 7–22K tokens |
| Multi-step: what changed? | `axDiff(prev, next)` | only deltas |

A full snapshot is **expensive in absolute terms** (7–22K tokens). For multi-step tasks: interactive first, `queryAXTree` when you know the name, re-snapshot only when the page meaningfully changes, and prefer `axDiff` over re-feeding the whole tree.

### Traps

- **`getFullAXTree` is the most common trigger of the WS payload limit.** A giant page's full tree can exceed the CDP WebSocket's per-message size and close the socket (`CDP socket closed`) — this is a property of the *connection*, not axTree; any large CDP response can do it (see [`connection.md`](connection.md)). For a known-large page, scope with `Accessibility.getPartialAXTree({ backendNodeId })` or `queryAXTree` the region instead of the whole-page dump. The next call **auto-heals** the transport, but the flat session is gone (browser tears it down on drop) — the stale `sessionId` rejects with `CDP -32001`; re-`attachToTarget` to the still-existing target and continue. Prefer `{ interactive: true }` before a full dump.
- **A near-empty snapshot with a tell like *'Making sure you're not a bot!'* is a bot/consent wall.** axView faithfully renders the wall, not the page — screenshot to confirm, then handle the wall (wait/retry) or fall back to coordinates.
- **Ignored wrappers carry the real content.** `getFullAXTree` nests the page under `ignored: true` `none`/`generic` nodes; a naive "skip ignored" walk discards the whole subtree. `axView` bubbles their children up — if you write your own over raw `getFullAXTree`, recurse through ignored nodes at the same depth.
- **Duplicate nodeIds.** `getFullAXTree` can emit some virtual nodeIds twice; keep the first occurrence (`axView` does this in `sdk/axview.ts`).
- **Refs are stable only within one `getFullAXTree` call.** After any navigation, mutation, or even some async updates, refs shift. Re-snapshot before acting on stale refs; never cache a ref across a page change.
- **`opts.refs === false`** omits the trailing ref map (the model can still *see* `[n]` labels). The map is the bulk of the "overhead" tokens — drop it when the model only reads, doesn't act. `axClick`/`parseAxRefs` need the map present (or a Map you kept).
- **`axDiff` strips refs before compare** — it reports role/name/flag changes, not renumbered `[n]` churn. Unchanged lines are omitted; identical trees return `(no changes)`.
