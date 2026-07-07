# Compressed a11y snapshot

When you need to *see* the whole page at once — to explore an unfamiliar UI, pick from many options, or summarize layout — snapshot the accessibility tree, compressed. This is the **exploration** tool; for finding one named thing, [`Accessibility.queryAXTree`](accessibility-tree.md) is cheaper and more precise. Use the snapshot when you don't yet know what to ask for.

`Accessibility.getFullAXTree` returns every node verbatim — `sources`, `chromeRole`, ignored wrappers, `InlineTextBox` fragments. On a real page that's **hundreds of thousands of tokens** (a Wikipedia article: 886K). The raw dump is unusable in context. `axView` drops the ~96% that is structural noise and keeps interactive elements + text, assigning `[n]` refs you can act on. Measured on a live Wikipedia article: **886K → 22K tokens**; on an app page: **210K → 7K**. All interactive nodes and content preserved.

## `axView` is a shipped global

`axView(nodes, opts?)` is injected into the REPL alongside `listPageTargets` / `detectBrowsers` (source: `sdk/axview.ts`). It is a **pure projection** over an already-fetched AX result — it never calls CDP and never replaces the protocol call. You still fetch the nodes; `axView` just renders them compactly.

```js
axView(nodes)              // -> compressed tree string + trailing ref map
axView(nodes, { refs: false })  // -> same, without the trailing ref map (fewer tokens when you only read)
```

It's transparent, not a black box: the heuristics are below, and the full source is `sdk/axview.ts`. For power the heuristics don't cover — exact `properties`, table grid structure, custom role sets — drop to raw `session.Accessibility.getFullAXTree({})` and transform the nodes yourself. That fallback is the whole point of keeping `getFullAXTree` first-class.

## Snapshot the active tab

```js
if (!session.isConnected()) await session.connect()
const tabs = await listPageTargets()
if (!session.getActiveSession()) await session.use(tabs[0].targetId)
await session.Page.enable()
const { nodes } = await session.Accessibility.getFullAXTree({})
return axView(nodes)
```

Output is an indented tree with `[n]` refs on interactive + named nodes, a trailing `# refs -> backendDOMNodeId` map, and state flags (`<focused checked expanded disabled>`, `(h2)`, `="value"`):

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

## Acting on a ref

A ref maps to a `backendDOMNodeId`. Resolve it to coordinates with `DOM.getBoxModel`, then drive with `Input.*` — the same path as `queryAXTree` → coordinates (see [`accessibility-tree.md`](accessibility-tree.md)). This stays inline CDP on purpose; there is no `click(ref)` helper.

```js
// The snapshot ends with the ref map: a "# refs -> backendDOMNodeId" line,
// then "[1]=100 [2]=135 ...". Read the backendDOMNodeId for your ref off that line
// (e.g. ref [7] -> 245), then resolve to coordinates and click — same path as queryAXTree:
const { model } = await session.DOM.getBoxModel({ backendNodeId: 245 })
const [x, y] = model.content.slice(0, 2), w = model.width, h = model.height
await session.Input.dispatchMouseEvent({ type: 'mousePressed',  x: x + w/2, y: y + h/2, button: 'left', clickCount: 1 })
await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: x + w/2, y: y + h/2, button: 'left', clickCount: 1 })
```

For textboxes, `backendDOMNodeId` → `DOM.resolveNode` → `objectId` → `Input.insertText` after focusing by click.

## What it drops (and when to drop below it)

Dropped: `ignored` nodes (bubbled — their children survive at the parent's depth), `InlineTextBox`/`ListMarker`/`LineBreak` leaf fragments, and structural wrappers (`generic`, `none`, `paragraph`, `list`, `listitem`, `table`, `row`, `cell`, `section`, `div`) whose children bubble up. Redundant text is coalesced: a `link "Donate"` whose only child is `StaticText "Donate"` keeps just the link line.

Kept: every interactive role, headings (with level), landmarks (one line), images with names, and all surviving text.

Drop to raw `getFullAXTree` when:
- **Table grid structure matters** — `table`/`row`/`cell` are dropped, so tabular data flattens to a list. If row/column position is signal, snapshot raw or query the table subtree.
- **You need `sources` or exact `properties`** — the compression trims state to common flags. For `required`, `readonly`, `invalid`, `describedby`, read the raw node or `queryAXTree` that one element.
- **A named structural node is meaningful** — e.g. `<time>`/`relative-time` date labels (role `generic`) vanish with the wrapper; `queryAXTree({ accessibleName })` recovers them. Or edit the role sets in `sdk/axview.ts`.

## When to snapshot vs query

| Task | Tool | Cost |
|---|---|---|
| Find one named element ("the Log in link", "the Submit button") | `queryAXTree` (see [`accessibility-tree.md`](accessibility-tree.md)) | ~30 tokens |
| List all of one role (all headings, all links) | `queryAXTree` with just `role` | ~hundreds of tokens |
| Explore an unfamiliar page; pick from many options; summarize layout | `axView(getFullAXTree())` | 7–22K tokens |

A snapshot is **expensive in absolute terms** (7–22K tokens). For multi-step tasks, prefer `queryAXTree` per step and re-snapshot only when the page meaningfully changes — don't re-snapshot after every action.

## Traps

- **`getFullAXTree` is the most common trigger of the WS payload limit.** A giant page's full tree can exceed the CDP WebSocket's per-message size and close the socket (`CDP socket closed`), killing every call after — this is a property of the *connection*, not axTree; any large CDP response can do it (see [`connection.md`](connection.md)). For a known-large page, scope with `Accessibility.getPartialAXTree({ backendNodeId })` or `queryAXTree` the region instead of the whole-page dump; reconnect with `await session.connect()` if it closes. This is the main case to fall back from `axView(getFullAXTree())` toward scoped `queryAXTree`.
- **A near-empty snapshot with a tell like *'Making sure you're not a bot!'* is a bot/consent wall.** axView faithfully renders the wall, not the page — screenshot to confirm, then handle the wall (wait/retry) or fall back to coordinates.
- **Ignored wrappers carry the real content.** `getFullAXTree` nests the page under `ignored: true` `none`/`generic` nodes; a naive "skip ignored" walk discards the whole subtree. `axView` bubbles their children up — if you write your own over raw `getFullAXTree`, recurse through ignored nodes at the same depth.
- **Duplicate nodeIds.** `getFullAXTree` can emit some virtual nodeIds twice; keep the first occurrence (`axView` does this in `sdk/axview.ts`).
- **Refs are stable only within one `getFullAXTree` call.** After any navigation, mutation, or even some async updates, refs shift. Re-snapshot before acting on stale refs; never cache a ref across a page change.
- **`opts.refs === false`** omits the trailing ref map (the model can still *see* `[n]` labels; the harness resolves them by re-querying). The map is the bulk of the "overhead" tokens — drop it when the model only reads, doesn't act.
