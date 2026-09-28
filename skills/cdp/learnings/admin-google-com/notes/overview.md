# admin-google-com

The Google Workspace admin console's domain-wide delegation page lists which OAuth client IDs
are allowed to impersonate users in the domain, and lets an admin revoke one. Unlike a normal
signed-in Google page, this page gates on a fresh passkey re-auth every time, so the usual
background-tab recipe does not apply here.

```js
await learnings("admin-google-com", "listDelegation", { authuser: 0 })
// -> { targetId, rows: [{ name, clientId, scopes }, ...] } once the reauth clears
// -> { stop: "reauth-required", hint: "..." } if it never does

// after a human decides which clientId to revoke:
await learnings("admin-google-com", "deleteDelegation", {
  targetId, clientId: "<21-digit-client-id>", confirm: true,
})
```

## Limits (learned 2026-09-28)

- **The page demands a fresh passkey re-auth before it loads.** Navigating to
  `/ac/owl/domainwidedelegation` redirects to an `accounts.google.com` challenge; only a human
  at the machine can approve a passkey prompt. A `?rapt=` parameter appears in the URL once the
  challenge clears. Because nothing scriptable can answer that prompt, `listDelegation` opens a
  **foreground** tab (never `background: true`, the challenge UI needs to be visible and
  interactive to the human) and polls the URL every 10 seconds for up to ~4 minutes, looking for
  `domainwidedelegation` in the URL with no `accounts.google.com` challenge host still present.
  No settle inside that window returns `{ stop: "reauth-required" }` rather than hanging or
  guessing.
- **A background tab never gets there.** The same navigation from a `background: true` target
  sits on the challenge screen indefinitely, since there is no human eye on it to pass the
  prompt. Always foreground this page.
- **The Delete link is visible without hover.** Unlike menus that only render on `:hover` or
  focus, each row's Delete action is a plain leaf element already in the DOM, matched by exact
  text `Delete`. No pre-click hover step is needed, only the real
  `Input.dispatchMouseEvent` sequence (`mouseMoved` -> `mousePressed` -> `mouseReleased`) at the
  leaf's own bounding-rect centre, the same technique `mail-google-com` uses for its hidden From
  selector.
- **Deletion needs the dialog confirm, not just the row click.** Clicking the row's Delete link
  opens a `[role=dialog]`/`[role=alertdialog]` confirm; the delegation is not revoked until the
  dialog's own visible `Delete` button is real-clicked too. `deleteDelegation` waits 2s after
  the row click for the dialog to render, then 4s after the dialog click for the revoke to land.
- **Verify by re-reading rows, never by trusting the click.** A dispatched click reporting
  "success" proves nothing on this console; `deleteDelegation` always re-reads the table after
  the wait and only returns `{ deleted: true }` when `clientId` is actually absent from the
  fresh row list. If it is still there, the caller gets `{ stop: "still-listed" }` instead of a
  false positive.
- **Reload and re-read to confirm persistence.** A row that disappears immediately after the
  in-page click can still reappear on reload if the delete only updated client-side state. Treat
  a same-page re-read as a first check, and reload the page for a second read before treating a
  deletion as durable.
- **Row parsing is best-effort.** Rows are matched by a 21-digit OAuth client ID
  (`/\b\d{21}\b/`) inside `tr`/`[role=row]` elements; `name` and `scopes` are split out of the
  remaining cell text, since the console does not label columns consistently across layouts. If
  a future layout changes the row shape, re-derive the split rather than trusting the current
  heuristic blindly.

No real client IDs, emails, or company names are used in this note; the examples above use
placeholders only.

## Provenance

2026-09-28, distilled from a live session against the domain-wide delegation page. Driven by
hand through `browser-harness-js` with an explicit `wsUrl`.

Tool status: the reauth-poll and row-read recipe for `listDelegation` was proven live.
`deleteDelegation` encodes the recipe observed for the Delete link and confirm dialog but has
not yet run end to end as a tool; the first real revoke is its proof.
