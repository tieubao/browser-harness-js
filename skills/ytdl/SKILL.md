---
name: ytdl
description: >-
  Download YouTube videos browser-natively — no `yt-dlp`, no client impersonation,
  no n-signature solver. The browser plays the video (auth, poToken, n-solving,
  SABR demux all done by the page itself); ytdl records the demuxed media the
  player feeds to MediaSource via a `SourceBuffer.appendBuffer` hook and muxes
  to MP4 with ffmpeg. If the user can watch the video, it's downloadable —
  made-for-kids, age-gated, and members-only work as long as a logged-in tab
  can play them. Use when the user wants to download, save, or fetch a YouTube
  video (audio or video) to disk.
setup: bash <skill-dir>/scripts/setup
compatibility: Requires `browser-harness-js` on PATH + a Chromium browser with remote debugging (see the `cdp` skill) and a logged-in YouTube tab for gated content. `ffmpeg` on PATH to mux video+audio into MP4.
---

# ytdl — browser-native YouTube downloader

> ⚠️ **Required before first use:** run `bash <skill-dir>/scripts/setup` to put the
> `ytdl` (and, if missing, `browser-harness-js`) CLI on PATH.

A thin `browser-harness-js` heredoc, exactly like `gsearch`/`xsearch`. There is
**no Bun program, no vendored solver, no HTTP client impersonation**. Every
hard thing YouTube does to play a video — cookies, poToken, the n-signature,
the SABR multiplex, adaptive-bitrate selection — the page already does for
playback. ytdl just records the result.

```bash
ytdl "https://www.youtube.com/watch?v=..."            # best quality → ~/Downloads
ytdl "https://www.youtube.com/watch?v=..." -q 360p    # 360p
ytdl "https://www.youtube.com/watch?v=..." -q 1080p   # 1080p (ffmpeg mux)
ytdl "https://www.youtube.com/watch?v=..." -q audio   # audio only
ytdl "https://www.youtube.com/watch?v=..." --info      # title / duration / qualities
ytdl "https://www.youtube.com/watch?v=..." -o Name -d ~/Videos
```

## Setup (once)

```bash
bash <skill-dir>/scripts/setup
```

Or symlink manually:

```bash
mkdir -p ~/.local/bin
ln -sf <skill-dir>/scripts/ytdl ~/.local/bin/ytdl
```

Verify (prints available qualities, no download):

```bash
ytdl "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --info
```

You must have a **logged-in YouTube tab** open in the browser for any video
that isn't fully public (made-for-kids, age-gated, members-only). ytdl opens
its own background tab but borrows the browser's cookie jar — if you can watch
it in the browser, ytdl can record it.

## Quality targets

| `-q`     | what happens | needs ffmpeg? |
|----------|--------------|---------------|
| `360p` / `480p` / `720p` / `1080p` / `1440p` / `2160p` | force that player quality, capture, mux | yes |
| `best`   | let the player pick (highest it offers) | yes |
| `audio`  | force the smallest video, keep only the audio buffer | no |

ffmpeg is a **muxer only** here — the player delivers video and audio as
separate ISO-BMFF (fragmented-MP4) streams, so they need combining into one
file. It never re-encodes (`-c copy`).

## How it works

All inside one `browser-harness-js <<EOF` heredoc, gsearch-style:

1. **Connect** to the browser's shared CDP session (or `session.connect()`).
2. **`Page.addScriptToEvaluateOnNewDocument`** — inject the MSE hook *before*
   any page JS runs:
   - Wrap `MediaSource.prototype.addSourceBuffer` (via `Object.defineProperty`)
     so each `SourceBuffer` is tagged with its mime (video/mp4 vs audio/mp4).
   - On each SourceBuffer, define an OWN `appendBuffer` property that records
     the bytes (the demuxed ISO-BMFF fragment) before calling the original.
     An own property is required — `SourceBuffer.prototype.appendBuffer` is a
     non-writable native method, so reassigning the prototype silently no-ops.
3. **`Target.createTarget` foreground** → `Page.navigate` to the watch URL →
   wait `networkIdle`, then poll for `#movie_player` + `<video>`. Foreground is
   required: background tabs have flaky autoplay, and if the player never
   starts, MediaSource is never fed and nothing is captured.
4. **Force quality** (`player.setPlaybackQualityRange(q,q)`, best-effort) and
   **play muted at 16×** so the player fetches+appends every segment fast. The
   player's own SABR client requests the whole timeline as it plays through.
5. **Drive coverage** — poll `video.currentTime` / `buffered.end` until the
   player has played through to the end, then pause it.
6. **Pull each kept source buffer to disk** in 4 MB (byte-count divisible by 3,
   so each base64 slice is independently decodable) chunks: page-side
   `__pullBuffer(i,offset,len)` returns base64; the REPL decodes with
   `Buffer.from(b64,'base64')` and `fs.appendFileSync`s it.
7. **ffmpeg** `-i video -i audio -c copy -movflags +faststart out.mp4` (bash,
   after the heredoc returns the temp-file paths).
8. **`closeTab`** in `try/finally`, fire-and-forget — exact gsearch/xsearch
   teardown.

## Why capture at MediaSource, not googlevideo

The logged-in web client now plays everything via **SABR**
(`application/vnd.yt-ump`), a protobuf multiplex — not discrete itag URLs with
HTTP ranges. Adding `&range=` to a SABR URL returns a 31-byte
`sabr.malformed_config` error; there's no media-bytes URL to range-download at
the playback layer. (yt-dlp sidesteps this by impersonating a SABR-*free*
`android_vr` client — which is the client-impersonation scaffolding this skill
deliberately drops.)

The one place the demuxed media exists in the clear is
`SourceBuffer.appendBuffer` — the ISO-BMFF fragments the player hands to
`<video>` for playback. Capturing there is SABR-agnostic, auth-agnostic, and
gating-agnostic: the page did all of it; we record the output. This is
literally "watch it → record it."

## Files

All paths relative to `<skill-dir>`.

- `scripts/ytdl` — the bash CLI (a `browser-harness-js` heredoc, no `#!bun`)
- `scripts/setup` — symlink `ytdl` + `browser-harness-js` onto PATH
- (no `lib/` — the whole solver/client-table/download scaffolding is gone)

## Traps

- **The MSE hook must inject via `Page.addScriptToEvaluateOnNewDocument`, not a post-load `Runtime.evaluate`.** The player grabs `MediaSource`/`addSourceBuffer` references while it boots; injecting before any page JS runs is the only way to patch them in time. The hook runs in the main world (no `worldName`), where the player lives.
- **Patch `appendBuffer` as an OWN property on each `SourceBuffer` instance, never on the prototype.** `SourceBuffer.prototype.appendBuffer` is a non-writable native method — `sb.appendBuffer = fn` on the prototype silently no-ops; `Object.defineProperty(SourceBuffer.prototype, 'appendBuffer', …)` fails to take effect. Defining an own property on the instance shadows the prototype method correctly. (`addSourceBuffer` *can* be patched on the prototype via `defineProperty` — it's writable.)
- **Use a foreground tab.** Background-tab autoplay is unreliable; if the player doesn't start, MediaSource is never fed and capture is empty. `createTarget({ url: 'about:blank' })` (no `background: true`).
- **Coverage is driven by playback, not by range requests.** The player only appends segments it plays, so ytdl plays through at 16× and waits for `currentTime ≈ duration`. Don't try to harvest a URL and range-fetch — see "Why capture at MediaSource." For very long videos this is bounded by real-time/16; a 1h video takes ~4 min of 16× playback.
- **Quality forcing is best-effort.** `player.setPlaybackQualityRange(q,q)` is honored on most content, but SABR manages bitrate server-side and may ignore it. `--info` shows `getAvailableQualityLevels()`; the returned JSON includes `actualQuality` so you can see what was really played. If the forced quality wasn't honored, the capture is whatever the player chose.
- **`--info` opens the watch page** (one page load) to read title/duration/qualities — it's not free, but it's a normal watch-page hit, not a probe storm.
- **Bytes cross the CDP boundary as base64** in 4 MB (3-aligned) slices via `Runtime.evaluate` `returnByValue`, decoded with `Buffer.from(b64,'base64')` and appended. The slice size is divisible by 3 so each slice's base64 is independently decodable (no interior `=` padding). Don't slice at a non-multiple-of-3 offset or the concatenation decodes to garbage.
- **Output container follows the video mime.** `video/mp4` → `.mp4`; `video/webm` → `.webm`. ffmpeg is invoked with `-c copy`, so a webm video is muxed to `.webm`. If codecs mismatch the container, ffmpeg copy will fail — that's a codec/container issue, not a capture issue.
- **Gated content needs a logged-in tab.** ytdl opens its own tab but shares the browser session. If a video is unplayable in your browser (sign-in wall, members-only), ytdl can't record it either — by design.
- **Live / Premiere uses HLS**, not MediaSource segments — not supported by this skill.
