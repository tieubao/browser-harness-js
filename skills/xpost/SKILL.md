---
name: xpost
description: >-
  Post a tweet or reply on X (Twitter) through the user's own browser via CDP.
  Use when the user asks to post to X, tweet this, post on Twitter, reply to a
  tweet or post, or "đăng twitter/X". Requires browser-harness-js on PATH, a
  Chromium browser with remote debugging, and a logged-in X session.
setup: bash <skill-dir>/scripts/setup
compatibility: >-
  Requires browser-harness-js on PATH, a running Chromium browser with remote
  debugging (chrome://inspect or --remote-debugging-port), and an active X
  (Twitter) login in the browser.
---

# X Post

> ⚠️ **You must be logged in to X in the browser.** Logged out, the composer URL redirects to a login wall and `tweetTextarea_0` never appears; `xpost` refuses with `no composer` instead of typing into a login form.

Post a tweet or reply on X (Twitter) via CDP. The tool posts whatever text it is given, verbatim; it does not draft, edit, or review content. No X API key, no `jq`. Each call opens its own foreground tab and WebSocket session.

## Usage

```bash
xpost "text"                                        # compose + post a tweet
xpost "text" --image /abs/path.png                  # attach one image
xpost "text" --reply-to https://x.com/u/status/ID   # reply under a post
xpost "text" --dry-run                              # everything EXCEPT the Post click
xpost --json "text"                                 # JSON result
```

`--dry-run` runs the full flow (navigate, hydrate, insert text, attach image, wait for the button) and stops before the click, printing `DRY_RUN_OK` plus the readiness state. Use it to verify a session before a real post; `DRY_RUN_NOT_READY` means the Post button never enabled.

| Flag | Meaning |
|------|---------|
| `--image <file>` | Attach one image; relative paths are made absolute, the file must exist |
| `--reply-to <url>` | Reply under a post via an `x.com`/`twitter.com` permalink; uses the inline reply composer on that page |
| `--dry-run` | Do everything except the final Post click |
| `--json` | Emit the result as a JSON object |
| `XPOST_PORT` / `BH_PORT` | Env vars: pin the CDP port (e.g. `9222`) instead of auto-detect |

## Result shape

Pretty mode prints one line (`POSTED [url]` / `DRY_RUN_OK …` / `NOT_POSTED <reason>`); `--json` prints the object:

```json
{ "ok": true, "mode": "post", "url": "https://x.com/<you>/status/<id>", "landed_on": "https://x.com/home" }
```

- `ok: true` means the post toast was seen. `url` is the new post's permalink **only if** the toast's "View" link was caught in time; X never redirects to the post, so `url` is often `null` even on success.
- `ok: false` carries a `reason` (`no composer`, `no focus tweet`, `post button never enabled`, `post toast not detected`, …).
- Dry-run returns `{ ok, dry_run: true, mode, text, image, reply_to, button_enabled, image_attached }`.

## How it works

| Step | CDP call | What it does |
|------|----------|--------------|
| 1 | `session.connect()`, fallback `session.connect({ port: 9222 })` | Auto-detect the browser; explicit-port retry because auto-detect has missed a browser on `--remote-debugging-port=9222` |
| 2 | `Target.createTarget({ background: false })` + `attachToTarget` | Foreground tab (proven for the composer) + per-call `sessionId` |
| 3 | `Page.enable` + `Page.setLifecycleEventsEnabled` | Both required; without the latter no `Page.lifecycleEvent` fires |
| 4 | `waitFor('Page.lifecycleEvent' networkIdle)` armed BEFORE `Page.navigate` | Go to `x.com/compose/post`, or the permalink in reply mode |
| 5 | `setTimeout(4000)` (4500 reply) | React hydration; networkIdle fires before the composer mounts |
| 6 | `Runtime.evaluate` focus+click `[data-testid="tweetTextarea_0"]`, then `Input.insertText` | Type the body atomically (newlines included; plain Enter does not submit) |
| 7 | `DOM.setFileInputFiles` on `input[data-testid="fileInput"]` | Attach the image without opening the OS picker (`--image` only) |
| 8 | Poll up to 30×1s | Ready = `[data-testid="attachments"] img` present (with `--image`) AND a `tweetButton`/`tweetButtonInline` that is visible, `aria-disabled !== 'true'`, not `.disabled` |
| 9 | `Runtime.evaluate` clicks the enabled button | Post; skipped by `--dry-run` |
| 10 | `Runtime.evaluate` on `document.body.innerText` | Toast check `/your post\|post was sent\|your reply\|reply was sent/i` → `ok` |
| 11 | `closeTab` in `finally` | Fire-and-forget teardown, never blocks the return |

## Traps

- **Login wall.** Logged out, `/compose/post` redirects and `tweetTextarea_0` never appears: `{ ok:false, reason:"no composer…" }`. A bad or deleted reply permalink gives `no focus tweet`.
- **React hydration delay.** `networkIdle` fires before React mounts the composer; the fixed 4s wait (4.5s on permalinks) is required before touching `tweetTextarea_0`.
- **Two Post buttons exist at once.** `tweetButtonInline` (inline composer/timeline) and `tweetButton` (compose dialog). While a dialog is open the inline one stays `aria-disabled=true`; `xpost` only clicks a button that is visible AND `aria-disabled !== 'true'` AND not `.disabled`.
- **Image upload takes seconds.** `DOM.setFileInputFiles` returns before processing finishes and the button can look enabled while the preview renders. With `--image`, readiness also requires `[data-testid="attachments"] img` to exist, polled up to 30s.
- **Over the character cap** (280 on the free tier) the Post button never enables; it surfaces as `post button never enabled`.
- **Verification is the toast, not the URL.** X does not redirect to the new post; success is the toast regex in `body.innerText` ~6s after the click. The post URL comes only from the toast's "View" link and is often missed; `url: null` does not mean the post failed.
- **Foreground tab.** The composer is flaky in a throttled background tab, so `xpost` opens a foreground tab; it briefly steals focus.
- **`session.connect()` fallback.** Auto-detect has missed a running Helium listening on `--remote-debugging-port=9222`; on failure `xpost` retries `connect({ port: 9222 })`. Set `XPOST_PORT`/`BH_PORT` to pin a port directly (then only that port is tried).
