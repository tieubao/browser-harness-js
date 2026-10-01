# Meta for Developers and Business Suite

Recipes for driving a logged-in session across `developers.facebook.com`,
`business.facebook.com`, and `www.facebook.com` (Messenger). Learned by hand
through one session, no automated tool beyond `status`.

```js
await learnings("meta-business-suite")
await learnings("meta-business-suite", "status")
```

## Limits (learned 2026-10-01)

- **Background-tab keyboard input needs focus emulation.** `Input.insertText`
  and synthesized Enter keys into a tab that is not the frontmost one land
  nowhere. Call `Page.bringToFront` on the target, then
  `Emulation.setFocusEmulationEnabled {enabled: true}`, before typing.
  Symptom without it: a password re-entry field stays empty no matter how
  many times `insertText` runs, with no error.

- **"Re-enter your password" dialog has several stale password inputs.**
  `document.querySelectorAll('input[type=password]')` returns more than one;
  the extra ones are hidden leftovers from earlier renders. Scope to the
  `[role=dialog]` whose text includes "re-enter your password", find the
  live `input[type=password]` inside that dialog only, clear the others, then
  `insertText` into the scoped one and click Confirm/Submit inside the same
  dialog element. Never print the password value in a tool's return or logs;
  pass it in through a process env var the caller sets, read it, use it,
  drop it.

- **Revealing the App Secret (Settings > Basic > Show).** Clicking Show
  triggers the same password prompt. After it clears, read the 32-hex-char
  value straight from the now-visible input and write it to a file created
  `0600`. The tool's return value is a boolean (wrote or not), never the
  secret itself.

- **File upload needs the Page.setInterceptFileChooserDialog flow, not a
  direct DOM.setFileInputFiles guess.** Call
  `Page.setInterceptFileChooserDialog {enabled: true}` on the session, click
  the upload control, wait for the `Page.fileChooserOpened` event on that same
  session, then `DOM.setFileInputFiles {files, backendNodeId}` using the
  backend node id the event carries. Business Suite path to the control:
  Home > Edit Facebook Page > Edit Profile Picture > "+ Upload photo". The
  crop dialog's zoom control has no range input to set a value on; drag or
  click the minus icon by its screen coordinates instead. Facebook
  auto-publishes an "updated their profile picture" post on Save; delete an
  unwanted one via Content > Posts & reels > row `...` menu > hover "Manage
  post" > Delete post (moves to trash, recoverable 30 days).

- **Many controls render as `role=listitem` or a bare `div`, not a real
  `button`.** `.click()` on the element JS resolves to a no-op on these.
  Find the leaf element whose text matches, then dispatch real
  `Input.dispatchMouseEvent` mouse-down/mouse-up at its center instead. The
  "Customize use case" dialog's Messenger tab only opens through a real
  click this way. An unrecognized `selected_tab` URL query param renders a
  blank pane rather than an error, so a bad guess at the param looks like a
  working navigation until you check the content.

- **Business Suite URLs redirect across assets.** `/latest/settings/page`
  with an `asset_id` query param can silently land on a different Page (a
  different asset the account also manages) if the param is missing or
  stale. Always pass both `asset_id` and `business_id`, and read the Page
  name on screen before editing anything. `/latest/inbox/automations` and
  `/latest/inbox/automated_responses` both rendered an empty pane under
  automation during this session; unresolved, treat as broken until proven
  otherwise.

- **Toggle state needs a screenshot to confirm, not a JS read.** Facebook
  Login for Business settings use custom switch components;
  `element.getAttribute('aria-checked')` or similar JS probes read the wrong
  state at least once this session. Confirm the actual state visually. The
  "Save Changes" footer button is permanently present regardless of whether
  there is a pending change, so its visibility proves nothing about whether
  a save is needed or happened; confirm a save persisted by reloading the
  page and re-checking the toggle.

- **Messenger thread URL and composer.** A Page's Messenger thread is at
  `https://www.facebook.com/messages/t/<page-id>`. The composer is
  `[contenteditable=true][role=textbox]`; its `aria-label` names the Page
  sending as, which is the reliable way to confirm you are typing as the
  right identity before sending.

- **Transport: the debugging port can die while the extension relay stays
  up.** Helium's `:9222` remote-debugging endpoint can vanish after a
  restart even though the browser-harness-js extension relay is still
  reachable and working. If an existing tab answers "Another debugger is
  already attached," do not retry the same target: open a new target with
  `Target.createTarget` and attach to that instead.

## Out of scope

No automation here clicks a publish, save, or money-moving control. The only
node-tool is `status` (finds the first open tab matching the domains above);
anything that changes a live Page, App, or setting stays a manual,
hand-driven step done by a human watching the screen.

## Provenance

2026-10-01 scaffolded via `browser-cdp learn new meta-business-suite --domains
developers.facebook.com,business.facebook.com,www.facebook.com`. Notes
captured from one session hand-driving the operator's logged-in browser across Meta for
Developers and Business Suite; no further automation built on top.
