# facebook.com (Page composer)

Recipes for driving a logged-in Facebook session that manages a Page.

## Posting (`createPagePost` node-tool)

The whole flow: open the Page URL in a foreground tab -> DOM-click the
"What's on your mind?" button -> focus the textbox inside the `Create post`
dialog -> `Input.insertText` for the full body -> `DOM.setFileInputFiles` on
the dialog's `input[type=file]` -> DOM-click the `aria-label="Post"` button ->
reload the Page and confirm the text is in the feed.

Learned by hand-driving a real post on a managed Page:

- **Synthesized mouse events do not open the composer.** A
  `Input.dispatchMouseEvent` pair on the button's rect left the page as it was.
  `element.click()` through `Runtime.evaluate` opens the dialog. The same holds
  for the Post button. Use mouse events only for focusing the textbox before
  `insertText`.
- **Two `Create post` dialogs exist while composing.** Both carry the same
  `aria-label`; only one contains the `[role=textbox]`. Select by that child.
- **Four `input[type=file]` elements are on the page**; the one inside
  `[role=dialog]` is the composer's and it accepts images, gif, and video. Set
  files on it directly; it works while hidden.
- **A gif is accepted as media.** Preview shows within ~8s for a small file.
- **The feed is virtualized.** After the reload, `document.body.textContent`
  holds the post text, but `[role=article]` around it can be empty and the
  permalink is often absent. `createPagePost` returns `{posted: true, url: null}`
  in that case; the post is live, open the Page's Posts list to find it.
- **Session re-bind after navigation.** The legacy singleton session could
  answer for a different target after `Page.navigate` or `location.reload()`.
  The ported tool holds its own Page from `ctx.attachPage`, so it needs no re-bind.
- **Log-in check:** a logged-out session renders `input[name=email]` in place
  of the composer. The tool refuses with `{posted: false, reason: "logged out"}`.
- **Personal profile:** unverified. The same dialog shape appears on a profile
  URL, so the tool should work with `pageUrl` set to the profile; confirm by
  hand once before relying on it.

## Listing a Page's reels (`listPageReels` node-tool)

Open `https://www.facebook.com/<page-id>/reels/` and collect unique ids from
`a[href*="/reel/"]` (`/reel/(\d+)`). The grid lazy-loads, so the tool scrolls
until the count is unchanged for ~10 rounds (or a max-rounds bound).

- **Hidden-tab lazy-load trap.** A background tab (`Target.createTarget`
  with `background: true`, the right choice so the user's window never moves)
  is "hidden" to the page: Facebook's lazy loader never fires. Plain
  `window.scrollTo` stalled at 11 ids. Fix, all three needed: call
  `Emulation.setFocusEmulationEnabled({enabled: true})` and
  `Page.setWebLifecycleState({state: 'active'})` on the tab's Page (`page.cdp`),
  then scroll with real wheel events (`Input.dispatchMouseEvent`,
  `type: 'mouseWheel'`, `deltaY: 3000`) as well as `scrollBy`. That reached
  ~150 ids on a real Page. Never `Page.bringToFront`.
- **Scroll the last reel link into view each round**, then wheel, then wait
  ~2s; the next batch is keyed off the last anchor reaching the viewport.
- **Logged out:** `input[name=email]` is present; the tool returns
  `{ids: [], reason: "logged out"}`. Zero reels returns `{ids: [], reason}` too.
- **Close the tab** in `finally` so the user's tab count is unchanged.

Ported to the Page API (see ../PORTING.md). live: verified on listPageReels; createPagePost unverified.

## Reading a Page's feed (`listPageFeed` and `listPageReelViews` node-tools)

For competitor watching: counts per post without opening each one. Hand-proven on a 30-post Page.

- **A post card** is the smallest ancestor of `[aria-label^="Actions for this post"]` that holds exactly one such button and a `[aria-label^="Comment on"]` control. Class names are obfuscated; labels are not.
- **Counts live in aria-labels.** `Comment on X's post, 15 comments`, `Share X's post, 1 share`, and one `Like: 57 people` / `Love: 41 people` label per reaction type (sum them). Zero shows no number in the label. The sum can sit a few under the headline total (631 against 635 seen on one post).
- **Caption** is `[data-ad-rendering-role="story_message"]`; strip the trailing "See more".
- **Timestamps are scrambled.** The visible text is an SVG glyph plus decoy characters (`U+034F` runs), so `innerText` gives garbage. The date exists only as a hover tooltip (`[role=tooltip]`, "Saturday, November 14, 2026 at 7:31 PM") that opens centered just below the anchor `a[href^="?__cft__"][target=_blank]` holding an `svg use`. The tool hovers each such anchor in view (move to 5,5, then onto it) and accepts a tooltip only if its center is within 80 px of the anchor and its text is new in the run, because a tooltip can outlive its hover. Tag anchors with a globally increasing counter, never the per-call array index: reused indexes stamped the wrong card. The `aria-labelledby` target next to the glyph is not reliable (once read "a day ago").
- **The feed is virtualized**, so collect cards every 400 px of scrolling and merge (one 1000 px step per collect dropped three adjacent posts once). Merge video cards on a 40-char caption prefix: the reel link hydrates a round after the caption.
- **Scroll** in bursts of small wheel events (2 x 200 px, 120 ms apart); one big wheel event or `scrollBy` loads nothing in a background tab.
- **Post keys:** `reel:<id>` from `a[href*="/reel/"]`; `pcb:<id>` from `set=pcb.<id>` on photo links (multi-photo post); `photo:<fbid>` for a single photo (its `set=a.<id>` is the whole album, not the post). Some cards show no date or link on a given pass; keep a caption-based fallback key.
- **Messenger bar:** the card text holds "Send message" (also `aria-label="Send message"`). The page header's "Message" button is outside the card. A bar on a post usually means an ad objective or a boost, but is not proof.
- **Reels-tab tiles** (`a[href*="/reel/"]`, `aria-label="Reel tile preview"`) print the view count as the first line of their `innerText`; the feed card does not show views.
- **Runtime:** about 2 to 3 min for 30 posts. Run it from a plain `browser-harness-js` call; the REPL eval has no tight timeout. After editing `feed.mjs`, `browser-harness-js --restart` (the daemon caches the module); the restarted daemon is already attached through the extension relay, so a later `session.connect({wsUrl})` throws "already connected" and the caller should treat that as success.
- **Comments are never read.** The tool returns no commenter names.

