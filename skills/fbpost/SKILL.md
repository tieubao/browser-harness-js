---
name: fbpost
description: >-
  Post to the user's own Facebook timeline through their browser via CDP.
  Use when the user asks to post to Facebook, share on FB, "đăng facebook/lên
  fb", or publish a status update. Requires browser-harness-js on PATH, a
  Chromium browser with remote debugging, and a logged-in Facebook session.
setup: bash <skill-dir>/scripts/setup
compatibility: >-
  Requires browser-harness-js on PATH, a running Chromium browser with remote
  debugging (chrome://inspect or --remote-debugging-port), and an active
  Facebook login in the browser. The composer UI may render in English or
  Vietnamese; both are handled.
---

# Facebook Post

> ⚠️ **You must be logged in to Facebook in the browser.** Logged out, the feed renders a login form instead of the composer; `fbpost` refuses with `logged out` instead of typing into a login form.

Post to the user's own Facebook timeline via CDP. The tool posts whatever text it is given, verbatim; it does not draft, edit, or review content. No Graph API key, no `jq`. Each call opens its own foreground tab and WebSocket session.

## Usage

```bash
fbpost "text"                        # compose + post to the timeline
fbpost "text" --image /abs/path.png  # attach one image
fbpost "text" --dry-run              # everything EXCEPT the Post click
fbpost --json "text"                 # JSON result
```

`--dry-run` runs the full flow (navigate, hydrate, open the composer, insert text, attach image, advance the preview step) and stops before the publish click, printing `DRY_RUN_OK` plus the readiness state. Use it to verify a session before a real post; `NOT_READY <reason>` means the composer never became publishable.

| Flag | Meaning |
|------|---------|
| `--image <file>` | Attach one image; relative paths are made absolute, the file must exist |
| `--dry-run` | Do everything except the final Post click |
| `--json` | Emit the result as a JSON object |
| `FBPOST_PORT` / `BH_PORT` | Env vars: pin the CDP port (e.g. `9222`) instead of auto-detect |

## Result shape

Pretty mode prints one line (`POSTED` / `DRY_RUN_OK …` / `NOT_READY <reason>` / `NOT_POSTED <reason>`); `--json` prints the object:

```json
{ "ok": true, "mode": "post", "url": null, "landed_on": "https://www.facebook.com/", "seen_in_feed": true }
```

- `ok: true` means the composer closed after the publish click. `url` is `null`: Facebook does not expose the new post's permalink reliably (the feed is virtualized). `seen_in_feed` is a best-effort check that the post text appears on the page afterwards; `false` does not mean the post failed.
- `ok: false` carries a `reason` (`logged out`, `no composer trigger`, `composer dialog did not open`, `text did not land in the composer`, `image preview never appeared`, `no enabled Post button`, `composer still open after the Post click`, …).
- Dry-run returns `{ ok, dry_run: true, mode, text, image, button_enabled, image_attached }`.

## How it works

| Step | CDP call | What it does |
|------|----------|--------------|
| 1 | `session.connect()`, fallback `session.connect({ port: 9222 })` | Auto-detect the browser; explicit-port retry because auto-detect has missed a browser on `--remote-debugging-port=9222` |
| 2 | `Target.createTarget({ background: false })` + `attachToTarget` | Foreground tab (the composer dialog is flaky in a throttled background tab) + per-call `sessionId` |
| 3 | `Page.enable` + `Page.setLifecycleEventsEnabled` | Both required; without the latter no `Page.lifecycleEvent` fires |
| 4 | `waitFor('Page.lifecycleEvent' networkIdle)` armed BEFORE `Page.navigate` | Go to `facebook.com` |
| 5 | `setTimeout(4500)` | React hydration; networkIdle fires before the composer mounts |
| 6 | `Input.dispatchMouseEvent` (move/press/release) on the trigger rect | Open the composer; a bare DOM `.click()` opens it only intermittently, a DOM click is retried as fallback |
| 7 | `Runtime.evaluate` focus + mouse click into the editable, then `Input.insertText` | Type the body atomically (newlines included) |
| 8 | DOM click the `Photo/video` (`Ảnh/video`) control, then `DOM.setFileInputFiles` on `[role=dialog] input[type="file"]` | Attach the image without opening the OS picker (`--image` only) |
| 9 | Poll up to 30×1s | Ready = editable holds the text AND (with `--image`) a `blob:`/`data:` preview exists AND an enabled `Post`/`Đăng` or `Next`/`Tiếp` button |
| 10 | DOM click `Next`/`Tiếp` when present | The current composer is two-step: Next reveals a preview pane carrying the publish button; advancing never publishes |
| 11 | DOM click the enabled `Post`/`Đăng` button | Publish; skipped by `--dry-run` |
| 12 | `Runtime.evaluate` | Success = composer dialog closed; feed-text check is best-effort |
| 13 | `closeTab` in `finally` | Fire-and-forget teardown, never blocks the return |

## Traps

- **Obfuscated DOM.** Facebook generates class names; every selector is role / aria-label / visible text. Never match on `class`.
- **UI language.** The composer renders in the account's language (English or Vietnamese observed). Labels are detected at runtime: trigger `/what's on your mind|bạn đang nghĩ/i`, publish `Post`/`Đăng`, advance `Next`/`Tiếp`, media `Photo/video`/`Ảnh/video`.
- **Two dialogs coexist.** An empty `aria-label="Create post"` shell sits next to the real composer; `fbpost` selects the `[role=dialog]` that contains an editable (`[contenteditable]` / `[role=textbox]` / `textarea`).
- **Trigger click is flaky.** `element.click()` opened the composer only sometimes in testing; a synthesized mouse press on the trigger's rect is reliable. Both are attempted.
- **Two-step composer.** With text present the footer button is `Next`, not `Post`; clicking it reveals a preview pane with `aria-label="Post"` plus a `Post settings` side sheet. Only the `Post`/`Đăng`/`Share`-class button publishes; `--dry-run` may click `Next` (advance only) but never the publish button.
- **Editable mounts lazily.** The contenteditable appears ~1s after the dialog shell; `fbpost` polls up to 12s for it.
- **Image upload takes seconds.** Readiness also requires a `blob:`/`data:` preview inside the dialog, polled up to 30s.
- **No permalink.** Timeline posts do not redirect or toast; success is composer-closed plus a best-effort feed-text check.
- **`session.connect()` fallback.** Auto-detect has missed a running Helium listening on `--remote-debugging-port=9222`; on failure `fbpost` retries `connect({ port: 9222 })`. Set `FBPOST_PORT`/`BH_PORT` to pin a port directly (then only that port is tried).
