# domView vs axView benchmark

Date: 2026-11-08. Browser: Chrome/157.0.8103.38 (headless, /Applications/Helium.app/Contents/MacOS/Helium). Viewport 1280x800. 7 measured runs per method per page after 1 discarded warmup round (the warmup is the `cold` column). Runs are interleaved A, B, B+text, B-all on an already loaded, idle page. User agent overridden to a non-Headless Chrome string. Regenerate with `node skills/cdp/sdk/bench/domview-bench.ts`; raw data in `results.json`.

## Verdict

domView is much faster and smaller than `getFullAXTree + axView({interactive:true})` on every measured page, but it sees less.

- **Time:** 6x to 26x faster (median ms: wikipedia 82.8 vs 5.3, mdn 35.7 vs 2.1, python-docs 52.3 vs 2.0, hackernews 17.6 vs 1.8, google-flights 8.8 vs 1.5). axView cost grows with AX tree size (9 to 83 ms: tree build in the browser plus the node-side compress); domView stays at 1.5 to 5.3 ms because the browser only walks the selector matches. Taking the text too (`text:true`) costs 1.2x to 2.8x more than the table alone (the range-rect walk per text node), still 5x to 13x faster than A.
- **Size:** domView in viewport mode is 2.4x to 14.8x fewer chars. The fairer comparison is full-page `viewport:false`, which is still 1.4x to 2.7x smaller (wikipedia 20.3K vs 35.9K chars, mdn 9.9K vs 18.8K) because there is no `# refs -> backendDOMNodeId` map (axView without the map is 27.2K on wikipedia, so the map is roughly a quarter of A) and no landmark/structure lines.
- **Call count:** both are one CDP call per snapshot, so upstream's 1,092 to 101 call reduction does not apply to us. Only the speed and size gain does, and it is large mostly on big pages.

Where domView misses things axView finds (visible in the overlap table; some "A only" names are naming differences, not misses: wikipedia TOC entries carry a number prefix in the DOM name, google-flights names are cut at 120 chars):

- **Shadow DOM.** `querySelectorAll` does not cross open shadow roots. MDN's search button, Log in, theme switch and nav dropdown items live in custom elements and are absent from B and B-all (spot check "search": A yes, B no). This is the biggest real miss on modern component-library sites. axView sees through shadow roots.
- **`<select>` options.** domView lists a select as one `combobox ="current value"`. axView lists every option (python-docs: 41 A-only names, mostly language and version options).
- **Off-screen by default.** Viewport mode drops everything below the fold (hackernews footer search box: A yes, B no, B-all yes). Use `viewport:false` for exploration.
- **Unexplained wikipedia misses.** "Main menu" and the TOC toggle appear in A but not in B-all; the cause was not investigated (a visually hidden checkbox toggle is the likely suspect).
- **No structure.** No landmarks, headings or grouping, so a reader cannot tell the nav from the main content, and there is no table/list context.
- **No iframes**, same as axView's default main-frame tree.

The "domView only" counts are small and mostly naming differences (TOC number prefixes, untruncated whitespace variants); no class of control found only by domView was identified.

Click check passed: `domView()` then `domClick(n)` on a local fixture link navigated to the target page via trusted `Input.dispatchMouseEvent`. The suite also covers type, offscreen scroll-into-view, and stale refs (`domview.live.test.ts`).

Caveats: single machine, headless Helium, loopback CDP, pages already loaded and idle, one network day. On a relay or remote CDP link the byte difference matters more than these local times suggest. The in-page ported script drops upstream's stale-page guards (they read `innerText` per control), so this measures the lean variant.


Method A is `Accessibility.getFullAXTree` + `axView(nodes, {interactive:true})` (default, with the trailing refs map). Method B is `domView()`: one `Runtime.evaluate`, viewport controls only, no text. Tokens are chars / 4.

## Summary (median of 7)

| Page | Method | median ms | p95 ms | cold ms | chars | ~tokens | elements |
|---|---|---:|---:|---:|---:|---:|---:|
| wikipedia | A axView interactive | 82.8 | 88.4 | 110.1 | 35864 | 8966 | 790 |
| wikipedia | B domView (viewport) | 5.3 | 5.5 | 6.4 | 2424 | 606 | 92 |
| wikipedia | B+text domView({text:true}) | 12.6 | 13 | 15 | 4578 | 1145 | 92 |
| wikipedia | B-all domView({viewport:false}) | 7.5 | 8.1 | 9.7 | 20329 | 5082 | 762 |
| hackernews | A axView interactive | 17.6 | 20.1 | 39.6 | 10825 | 2706 | 230 |
| hackernews | B domView (viewport) | 1.8 | 1.9 | 3.5 | 4519 | 1130 | 160 |
| hackernews | B+text domView({text:true}) | 2.3 | 2.7 | 3.8 | 7448 | 1862 | 160 |
| hackernews | B-all domView({viewport:false}) | 1.6 | 1.9 | 2.6 | 6472 | 1618 | 230 |
| python-docs | A axView interactive | 52.3 | 53.6 | 83.3 | 12219 | 3055 | 254 |
| python-docs | B domView (viewport) | 2 | 2.6 | 2.7 | 1422 | 356 | 41 |
| python-docs | B+text domView({text:true}) | 5.5 | 5.8 | 6.2 | 3322 | 831 | 41 |
| python-docs | B-all domView({viewport:false}) | 2.1 | 2.4 | 2.4 | 4532 | 1133 | 174 |
| google-flights | A axView interactive | 8.8 | 10.6 | 25.6 | 4642 | 1161 | 71 |
| google-flights | B domView (viewport) | 1.5 | 2.4 | 3.3 | 922 | 231 | 25 |
| google-flights | B+text domView({text:true}) | 1.8 | 2.5 | 2.3 | 1327 | 332 | 25 |
| google-flights | B-all domView({viewport:false}) | 1.6 | 1.9 | 2 | 3413 | 853 | 70 |
| mdn | A axView interactive | 35.7 | 37.7 | 67.1 | 18814 | 4704 | 389 |
| mdn | B domView (viewport) | 2.1 | 3 | 2.9 | 1333 | 333 | 43 |
| mdn | B+text domView({text:true}) | 2.8 | 3.3 | 3.8 | 2446 | 612 | 43 |
| mdn | B-all domView({viewport:false}) | 2.7 | 3.3 | 3.7 | 9940 | 2485 | 343 |

`p95` of 7 runs is the nearest-rank value, effectively the slowest run. A chars without the refs map: wikipedia 27168, hackernews 8589, python-docs 9524, google-flights 3937, mdn 14572.

## Ratios (A divided by B)

| Page | time A/B | chars A/B | chars A/B-all | elements A | elements B (viewport) | elements B-all |
|---|---:|---:|---:|---:|---:|---:|
| wikipedia | 15.6x | 14.8x | 1.8x | 790 | 92 | 762 |
| hackernews | 9.8x | 2.4x | 1.7x | 230 | 160 | 230 |
| python-docs | 26.1x | 8.6x | 2.7x | 254 | 41 | 174 |
| google-flights | 5.9x | 5.0x | 1.4x | 71 | 25 | 70 |
| mdn | 17.0x | 14.1x | 1.9x | 389 | 43 | 343 |

## Correctness spot check

Targets found in each output (role and name pattern match). B = viewport mode, B-all = `viewport:false`.

| Page | Target | A | B | B-all |
|---|---|:-:|:-:|:-:|
| wikipedia | search box | yes | yes | yes |
| wikipedia | link Log in | yes | yes | yes |
| wikipedia | link Donate | yes | yes | yes |
| hackernews | link new | yes | yes | yes |
| hackernews | link login | yes | yes | yes |
| hackernews | footer search box | yes | no | yes |
| python-docs | search box | yes | yes | yes |
| python-docs | link Previous topic or Index | yes | yes | yes |
| python-docs | link Python | yes | yes | yes |
| google-flights | Where from | yes | yes | yes |
| google-flights | Where to | yes | yes | yes |
| google-flights | Search button | no | no | no |
| mdn | search | yes | no | no |
| mdn | link Reference | no | no | no |
| mdn | link Guides | yes | no | yes |

Name overlap of interactive elements (lowercased names, duplicates collapsed), A against domView:

| Page | both (B-all) | A only (B-all) | domView only (B-all) | both (B) | A only (B) | domView only (B) |
|---|---:|---:|---:|---:|---:|---:|
| wikipedia | 360 | 129 | 120 | 57 | 432 | 29 |
| hackernews | 150 | 0 | 1 | 106 | 44 | 1 |
| python-docs | 85 | 41 | 3 | 38 | 88 | 2 |
| google-flights | 64 | 7 | 6 | 25 | 46 | 0 |
| mdn | 299 | 59 | 25 | 37 | 321 | 2 |

## Click check

Local fixture page, `domView()` then `domClick(2)` on link "Known link": navigated = **true** (landed on title "Target reached").

## Dropped pages

- github: did not load in 3 attempts (last HTTP status 504). Target was https://github.com/browser-use/jev-ultrafast; every github.com URL returned 504 from this network that day (curl and the browser agree). Replaced by python-docs (https://docs.python.org/3/library/json.html) so five pages were measured.

## Raw per-run wall ms

| Page | Method | runs 1..7 |
|---|---|---|
| wikipedia | A axView interactive | 88.4, 85.4, 82.9, 80.6, 82.8, 81.6, 80.6 |
| wikipedia | B domView (viewport) | 5.4, 5.5, 5.5, 5.1, 5.3, 5.3, 5.1 |
| wikipedia | B+text domView({text:true}) | 12.9, 13, 12.6, 12.4, 12.2, 12, 12.7 |
| wikipedia | B-all domView({viewport:false}) | 7.8, 7.3, 8.1, 7.5, 7.2, 8, 7.3 |
| hackernews | A axView interactive | 20.1, 18.1, 17.3, 17, 17.6, 18.1, 17.5 |
| hackernews | B domView (viewport) | 1.9, 1.7, 1.8, 1.6, 1.8, 1.9, 1.9 |
| hackernews | B+text domView({text:true}) | 2.7, 2.3, 2.3, 2.2, 2.3, 2.5, 2.5 |
| hackernews | B-all domView({viewport:false}) | 1.8, 1.5, 1.5, 1.5, 1.6, 1.9, 1.6 |
| python-docs | A axView interactive | 51.9, 51.8, 52.8, 52.3, 51.9, 52.3, 53.6 |
| python-docs | B domView (viewport) | 1.8, 2.4, 2.6, 2, 1.8, 2, 2 |
| python-docs | B+text domView({text:true}) | 5.5, 5.5, 5.6, 5.6, 5.8, 5.4, 5.3 |
| python-docs | B-all domView({viewport:false}) | 2.3, 2.1, 1.9, 1.9, 2.4, 2.1, 1.8 |
| google-flights | A axView interactive | 9.1, 8.8, 10.6, 8.9, 8.7, 8.7, 8.4 |
| google-flights | B domView (viewport) | 1.5, 1.6, 2.4, 1.4, 1.5, 1.4, 1.5 |
| google-flights | B+text domView({text:true}) | 1.8, 2.5, 2.3, 1.8, 1.7, 1.7, 1.9 |
| google-flights | B-all domView({viewport:false}) | 1.6, 1.9, 1.6, 1.6, 1.3, 1.4, 1.4 |
| mdn | A axView interactive | 37.7, 34.9, 36.2, 35.7, 35.1, 35.4, 36 |
| mdn | B domView (viewport) | 2.2, 1.9, 3, 2.3, 1.9, 2.1, 2.1 |
| mdn | B+text domView({text:true}) | 2.7, 3.3, 2.8, 2.8, 2.6, 2.7, 3.2 |
| mdn | B-all domView({viewport:false}) | 2.7, 3, 2.6, 2.7, 3.3, 2.7, 3 |
