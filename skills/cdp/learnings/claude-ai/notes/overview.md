# Claude (claude.ai)

Claude Code on the web, Projects beta UI. No API for the settings screens, so the DOM is the path.

```js
const { targetId } = await learnings("claude-ai", "openCode")
await learnings("claude-ai", "clickByText", { targetId, scope: "body", text: "Projects Beta" })
await learnings("claude-ai", "rect", { targetId, expr: "document.querySelector('[role=dialog]')" })
await learnings("claude-ai", "shot", { targetId, out: "/tmp/dialog.png", clip: { x: 400, y: 200, width: 480, height: 360 } })
```

## Open the tab

- `browser.open('https://claude.ai/code', {allowedOrigins:['https://claude.ai'], timeoutMs: 45000})`.
- The default 10 s deadline fails because the SPA never settles. On that failure the tab is closed.
- `openCode` wraps this and returns the `targetId`. Close the tab when done.

## Where things are

- Projects list: `/code/projects/browse`. Sidebar link: "Projects Beta".
- New project: button "New project". Dialog textboxes "Name" and "What do you want to work on? (optional)". Button "Create project".
- Creating a project with a goal makes the coordinator run one greeting turn.
- Project settings: main header button "View options", then menu entry "Settings".
  - The entry is not `role=menuitem`. Find it by exact `innerText` inside `[role=menu]`.
  - Tabs: General, Memory, Environment, Usage, Debug access.
- Memory tab: "Project instructions". Textarea with placeholder starting "Think step". Limit 16,000 chars.
- Environment tab: project repos, cloud environment, "Let Claude use your device", "Pre-approved folders", "Use worktrees".
- General tab: coordinator model, thread model, thread effort, auto-continue, Pause, Restart, Archive, Delete.
- Archive opens a confirm dialog "Archive project?" with its own "Archive" button.

## Clicking

- The guarded click refuses several of these controls: `blocked: not_interactable_or_unsupported: observation truncated`.
- Radix menus also ignore a bare `mousePressed` and `mouseReleased`.
- What works: get the rect with `Runtime.evaluate`. Send `Input.dispatchMouseEvent` `mouseMoved`. Wait about 150 ms. Then `mousePressed` and `mouseReleased` at the centre. That is `hoverClick`.
- Match button text with `innerText.includes(...)`. Button `innerText` carries a leading newline from the icon.
- `clickByText` tries an exact trimmed match first (menu entries), then a button `includes` match.

## Screenshots

- `Emulation.setDeviceMetricsOverride {width:1280,height:820,deviceScaleFactor:2}`, then `Page.captureScreenshot` with a `clip`. It works on a background tab without bringing it forward.
- Clear the override and close the tab after. `shot` clears the override. You close the tab.
- The sidebar lists private session and project names. Crop at x >= 232 (the sidebar width), or clip to a `[role=dialog]` rect.
- Privacy: never screenshot the sidebar or the Projects list of a real account for publication.

## Limits

- Archive and Delete are real. `clickByText` does not confirm anything for you.
- Selectors drift with UI deploys. Visible text has been the stable anchor.
- Not verified here: the helpers were written up from a proven live session, then checked offline with a fake page (`tools/claude-ai.test.mjs`). Re-verify live after a UI change.
