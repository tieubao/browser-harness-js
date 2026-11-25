---
name: linkedin
description: >-
  Post updates, comment on and like posts or comments, list notifications,
  and read/reply to messages on LinkedIn through the user's browser via CDP.
  Use when the user asks to post to LinkedIn, reply to a tagged/mentioned
  post, like a post or comment, check LinkedIn notifications or messages, or
  answer a LinkedIn DM. Requires
  browser-harness-js on PATH, a Chromium browser with remote debugging, and a
  logged-in LinkedIn session.
setup: bash <skill-dir>/scripts/setup
compatibility: >-
  Requires browser-harness-js on PATH, a running Chromium browser with remote
  debugging (chrome://inspect or --remote-debugging-port), and an active
  LinkedIn login in the browser. UI labels are matched in English.
---

# LinkedIn

> ⚠️ **You must be logged in to LinkedIn in the browser.** Logged out, pages render a login form or authwall; write verbs refuse with a `logged out` reason instead of typing into it.

LinkedIn via CDP: post updates, comment under posts, list notifications, and read/reply to message threads. Posts whatever text it is given, verbatim; it does not draft or review content. No API key, no `jq`. One tab per call, safe to run in parallel.

## Usage

```bash
linkedin post "text" [--image /abs/p.png] [--dry-run]   # share an update
linkedin notifs [N]                                   # N recent notifications (default 10)
linkedin comment <post-url> "text" [--dry-run]        # comment under a post
linkedin inbox [N]                                    # N recent message threads (default 10)
linkedin reply <thread|index> "text" [--dry-run]      # reply inside a thread
linkedin like [--check] <post-or-comment-url>         # like (never toggles off)
linkedin --json <verb> ...                            # JSON output for every verb
```

`--dry-run` on `post`/`comment`/`reply` runs the full flow (navigate, hydrate, open the composer/box, insert text, attach image) and stops before the final Post/Comment/Send click, printing `DRY_RUN_OK` plus readiness state. `NOT_READY <reason>` means it never became submittable. Write verbs without `--dry-run` click the real button.

| Flag | Meaning |
|------|---------|
| `--image <file>` | `post` only; attach one image, relative paths made absolute |
| `--dry-run` | `post`/`comment`/`reply`; everything except the final click |
| `--json` | Emit the result as JSON (works on every verb) |
| `--check` | `like` only; read the reaction state, never click |
| `LINKEDIN_PORT` / `BH_PORT` | Env vars: pin the CDP port (e.g. `9222`) instead of auto-detect |

`reply`'s first argument is a case-insensitive substring of the thread name (`linkedin reply "chuyen" "…"`) or a 0-based index into the `inbox` list (`linkedin reply 1 "…"`). `notifs` is how you find the post URL for `comment`: tagged/mentioned posts arrive as notifications with a `feed/?highlightedUpdateUrn=…` link.

## Result shapes

| Verb | Pretty | `--json` |
|------|--------|----------|
| `post` | `POSTED` / `DRY_RUN_OK verb=post button_enabled=true chars=N` / `NOT_READY` / `NOT_POSTED <reason>` | `{ok, verb:"post", url:null, landed_on}` or `{ok:false, verb, reason}` |
| `comment` | `COMMENTED` / `DRY_RUN_OK verb=comment …` / `NOT_COMMENTED <reason>` | `{ok, verb:"comment", url}` |
| `reply` | `SENT thread="…"` / `DRY_RUN_OK verb=reply thread="…" …` / `NOT_SENT <reason>` | `{ok, verb:"reply", thread, thread_url}` |
| `notifs` | one entry per line-group: `[type] actor · time`, text, url | array of `{type, actor, text, url, time}` |
| `inbox` | `index. name · time [unread]`, snippet | array of `{index, name, snippet, time, unread, url}` |
| `like` | `LIKED <target> <url>` / `ALREADY_LIKED …` / `LIKE_STATE liked=<bool> …` / `NOT_LIKED <reason>` | `{ok:true, verb:"like", url, target, liked:true, already}`; `--check`: `{ok:true, verb:"like", url, target, liked}`; failure `{ok:false, verb:"like", url, target, reason}` |

- `notifs` `type` is parsed from the card text: `posted`, `commented-on`, `reposted`, `mentioned-you`, `tagged-you`, `suggested`, or `other`. `time` is the relative badge (`10m`, `2h`), `null` when absent.
- `inbox` `url` is always `null`: thread rows are not anchors, the thread URL only resolves by opening the row (which `reply` does; it reports `thread_url`). Select threads by `index` or name substring.
- Dry-run JSON carries `{ok, dry_run:true, verb, text, button_enabled, …}`.
- `like` reads the reaction state BEFORE any click (a click on a reacted target unreacts it), so a retry never toggles; `already:true` means no click happened. After the click it re-reads and reports success only when the state flipped. Exit code is non-zero whenever `ok` is false. `target` is `post` or `comment`.
- `like` URLs: `feed/update/urn:li:(activity|ugcPost|share):N`, `/posts/…-activity-N-…`, the `feed/?highlightedUpdateUrn=…` links `notifs` returns, and `feed/update/urn:li:comment:(activity:N,C)`. A `commentUrn` (or `replyUrn`) query, LinkedIn's "copy link to comment" shape, likes that comment instead of the post. Every form is normalized to `https://www.linkedin.com/feed/update/<urn>/`. DMs (`/messaging/`) and anything else are refused before the browser opens.

## Traps

- **Obfuscated DOM.** LinkedIn generates class names (`_155affd2`, `b75a3dd8`); every selector is role / aria-label / visible text / stable `msg-*`/`ql-editor`/`ProseMirror`/`share-box` fragments. Never match a generated hash class.
- **The feed composer is TipTap, not Quill and not a dialog.** "Start a post" expands an inline `.ProseMirror[contenteditable=true]` editor; there is no `[role=dialog]`. Comment boxes under posts are Quill `.ql-editor`, a different editor. The Post button sits outside the editor; scope by climbing ancestors until a container has a `Post`-labeled button.
- **The "Start a post" click is flaky.** A trusted `Input.dispatchMouseEvent` press lands on the right element (`elementFromPoint` confirms) yet opens the composer only some of the time; bare `element.click()` and synthetic `dispatchEvent` pointer sequences do not work at all. `post` loops press → poll → DOM click → poll up to 4 rounds.
- **`/messaging/` never reaches `networkIdle`** (persistent socket). Wait on `load` plus a fixed ~6s settle, and note it auto-opens the most recent thread, which can be a sponsored one with **no reply box** (`msg-form__contenteditable` never mounts).
- **Thread rows are not anchors and their body does not take clicks.** The working click target is the inner `.msg-conversation-listitem__link` div (`tabindex=0`); clicking the `li` or its text elements does nothing, and there is no `href` to read, the thread URL is only knowable after the click (`location.href` becomes `/messaging/thread/<urn>`).
- **Notification cards have an overlay anchor.** `a[href*=highlightedUpdateUrn]` has empty text and zero height; the readable card is its parent, and the time badge (`1h`) is a span one level further up. The list lazy-renders: scroll to load more than ~6.
- **Two "Comment" buttons on a post page.** The action-bar `aria-label="Comment"` button only focuses/scrolls to the box; the submit is `button[class*=comments-comment-box__submit]` inside the comment box's container. Scope to the editor's ancestor before matching `Post`/`Comment` labels.
- **CSS attribute selectors can't hold slashes or colons through the JS string layers** (`a[href*=/posts/]` and `img[src^=blob:]` are both invalid by the time the page sees them). Use slash-free fragments (`a[href*=posts]`, `img[src^=blob]`) and filter the href with a JS regex (`/feed\/update|\/posts\//` is fine inside a regex literal).
- **Image attach is two-stage.** The composer's `aria-label="Media"` button mounts a hidden `input[type=file]` (poll for it, it can lag); `DOM.setFileInputFiles` fills it without the OS picker. The preview then renders as `img[src^=blob]` **outside** the composer container (the media editor is its own overlay), so attachment is verified by counting new blob images document-wide.
- **Success detection has no permalink.** Posting collapses the composer (editable empties); comments clear the box and the text appears in the comments list; replies empty `.msg-form__contenteditable`. No toast or redirect is reliable.
- **Reactions have no `aria-pressed`.** The state is `aria-label="Reaction button state: <state>"`: on the post's `<button>`, and on an `svg[role=img]` inside the comment's `div[role=button]`. `no reaction` means not liked; any other state (Like, Celebrate, …) counts as liked, so `like` never clicks it. Comments sit in `div[id="replaceableComment_urn:li:comment:(activity:A,C)"]` (the comment URN's activity can differ from the page's); `like` matches on the comment id `C` and takes the control whose innermost such ancestor is that comment, so a nested reply's control is never picked for its parent.
- **`session.connect()` fallback.** Auto-detect has missed a browser listening on `--remote-debugging-port=9222`; on failure the CLI retries `connect({ port: 9222 })`. Set `LINKEDIN_PORT`/`BH_PORT` to pin a port directly.
