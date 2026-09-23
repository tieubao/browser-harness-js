# studio-youtube-com

YouTube Studio for the Dwarves Foundation channel (`UC_SyzGLf6wiqctQFsRI_frw`), managed under
han@d.foundation, which is `authuser=1` in the Helium browser. All verbs are node-tools over the
CDP session; clicks are `el.click()` through `Runtime.evaluate`, never simulated mouse events.

```js
await learnings("studio-youtube-com")
await learnings("studio-youtube-com", "status")
await learnings("studio-youtube-com", "list", { limit: 10 })
await learnings("studio-youtube-com", "probe", { id: "pw1V2tGZI9Q" })
await learnings("studio-youtube-com", "upload", { file: "/abs/path/video.mp4", title: "...", description: "...", playlist: "Dwarves Dispatch" })
await learnings("studio-youtube-com", "setLanguage", { id: "pw1V2tGZI9Q", language: "Vietnamese" })
await learnings("studio-youtube-com", "remove", { id: "...", expectDuration: "16:53", confirm: true })
```

## Verbs

### `upload({file, title, description, playlist, visibility, madeForKids, channelId, authuser, timeoutMs, allowSaveOnStall, confirmPublishAnyway})`

Opens `/channel/<channelId>/videos/upload?d=ud&authuser=<n>` in a foreground tab, sets the file
with `DOM.setFileInputFiles` on `input[type=file][name=Filedata]`, fills title and description,
sets audience, optionally sets a playlist, clicks Next three times, sets visibility, reads the
video id, polls processing, and saves. Returns `{id}` on success or `{stop:<reason>, ...}` the
moment any step cannot be verified. `visibility` defaults to `UNLISTED`, `madeForKids` to `false`.

### `setLanguage({id, language, authuser})`

Opens `/video/<id>/edit?authuser=<n>`, clicks the visible "Show more", and for each visible
`ytcp-form-language-input` (video language, then title/description language) opens its dropdown
and picks the matching `tp-yt-paper-item`, then clicks `ytcp-button#save`. Verifies by loading
`/video/<id>/translations` and matching `Video language: <language>` in the page text. `language`
defaults to `Vietnamese`.

### `list({limit, channelId, authuser})`

Reads `ytcp-video-row` rows off the channel content page. Returns `{rows: [{id, title,
visibility}]}`. `limit` defaults to 20.

### `remove({id, expectDuration, confirm, authuser})`

Destructive. Opens the video's edit page, clicks Options, clicks Delete, and REFUSES unless the
resulting dialog's text contains `expectDuration` (e.g. `16:53`) and the caller passed
`{confirm:true}`. Only then ticks the confirm checkbox and clicks "Delete forever".

### `probe({id})`

No browser needed, plain `fetch`. Checks the oembed endpoint (200 + title for public/unlisted,
never for private) and the watch page's `playabilityStatus` (`"status":"OK"`). Returns
`{id, oembed:{ok,status,title}, playable:{ok,status}}`.

## Gotchas

- **execCommand needs the foreground tab.** `document.execCommand('insertText', ...)` on the
  title/description contenteditable boxes silently returns `false` unless the tab is the one in
  front. `setTextbox` calls `Page.bringToFront()` before every attempt and verifies the box text
  actually matches, retrying up to 8 times rather than trusting the return value.
- **Read the video id from the href, never a screenshot.** The upload dialog's
  `a[href*="youtu.be/"]` href is the only reliable source; a screenshot misreads `l` as `I` (or
  the reverse) in the 11-character id and silently points every later call at the wrong video.
- **Playlist rows have empty innerText.** Match on `textContent`, walked up a few ancestors from
  the `ytcp-checkbox-lit`, not `innerText`.
- **The language listbox is picked by child count, not visibility.** The `tp-yt-paper-listbox`
  holding language options has 900+ children; its own visibility state is not a reliable signal,
  so `setLanguage` finds the listbox with `children.length > 900` and matches the item text inside
  it.
- **Processing state lives in the last `.progress-label`.** Poll it for "Checks complete"; treat
  "Video processing is taking longer than expected" as a stall the caller opts into saving through
  via `allowSaveOnStall`, never a silent default.
- **The "still checking your content" dialog needs an explicit opt-in.** `upload` stops with
  `{stop:"still-checking-content"}` unless the caller passes `confirmPublishAnyway:true`.
- **`remove` is destructive and refuses by default.** It requires `expectDuration` to match the
  delete dialog's own text and `{confirm:true}`; there is no other selector confirming which video
  the dialog is actually about.
- **Cold navigation to Studio is slow.** Every verb waits about 6 seconds after opening the tab
  before touching the DOM; a shorter wait returned `rows:[]` from `list` in testing even though the
  page had, in fact, loaded a moment later.

## Verification (2026-09-24, no upload/save/delete/language change performed)

```
probe({id: "pw1V2tGZI9Q"})
  -> {"id":"pw1V2tGZI9Q","oembed":{"ok":true,"status":200,"title":"Dwarves Dispatch #1: UI Kit workflow, bốn bước từ setup đến implement"},"playable":{"ok":true,"status":200}}

probe({id: "zzzzzzzzzzz"})  (bogus id)
  -> {"id":"zzzzzzzzzzz","oembed":{"ok":false,"status":400},"playable":{"ok":false,"status":200}}

list({limit: 3})
  -> {"rows":[
       {"id":"8w2bFnu41n0","title":"Dwarves Dispatch #2: Handoff pattern, từ ảnh chụp app đến Figma và video demo","visibility":"Unlisted"},
       {"id":"pw1V2tGZI9Q","title":"Dwarves Dispatch #1: UI Kit workflow, bốn bước từ setup đến implement","visibility":"Unlisted"},
       {"id":"2xPsj5TR_wA","title":"Dwarves Year End Party - YEP 2024","visibility":"Unlisted"}
     ]}
  both expected ids (8w2bFnu41n0, pw1V2tGZI9Q) present.

Upload dialog opened at /channel/UC_SyzGLf6wiqctQFsRI_frw/videos/upload?d=ud&authuser=1,
DOM.querySelector on input[type=file][name=Filedata] resolved a real nodeId, tab closed
without ever calling DOM.setFileInputFiles:
  -> {"nodeId":2065,"resolved":true}

A background tab was opened with Target.createTarget({url:"about:blank", background:true})
and closed at the end:
  -> {"opened":"6983302031E46DDD425CB8E2ED7A5B67","closed":true}
```

`upload`, `setLanguage`, and `remove` were not exercised end to end (would upload/save/delete/
change a live video, out of scope for this pass); their selectors were transcribed from the task
spec and the sibling learnings' file-upload and dropdown patterns (`github-com/set-org-avatar`,
`x-com/post`, `dvc-cutru`), not independently confirmed against a live upload flow.

## Provenance

2026-09-24, built for the Dwarves Dispatch publishing pipeline. Channel:
`UC_SyzGLf6wiqctQFsRI_frw`, account slot `authuser=1` (han@d.foundation).
