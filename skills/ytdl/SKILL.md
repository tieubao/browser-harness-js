---
name: ytdl
description: >-
  Download YouTube videos as a self-contained Bun CLI — no `yt-dlp` binary.
  Impersonates a SABR-free innerTube client (android_vr / web_embedded) over the
  player API, deciphers the n-signature / signatureCipher using the page's own
  player JS via a vendored AST solver (meriyah + astring + EJS), and downloads
  with multi-connection range requests to dodge the per-connection throttle.
  Public videos work standalone; made-for-kids / age-gated / members-only
  content is cracked via the `web_embedded` client, optionally reading the
  authed cookie jar + signature timestamp from a live YouTube tab through
  `browser-harness-js`. Use when the user wants to download, save, or fetch a
  YouTube video (audio or video) to disk.
setup: bash <skill-dir>/scripts/setup
compatibility: Requires `bun` on PATH (bundled with the cdp skill, or via https://bun.sh). `ffmpeg` on PATH for 720p+ HD (360p muxed needs no ffmpeg). Optional: `browser-harness-js` on PATH + a logged-in YouTube tab for made-for-kids / age-gated / members-only content.
---

# ytdl — self-contained YouTube downloader

> ⚠️ **Required before first use:** run `bash <skill-dir>/scripts/setup` to put the
> `ytdl` CLI on PATH. The script also symlinks `bun` (the engine) and, if the
> `cdp` skill is installed, `browser-harness-js` (optional, for gated content).

A standalone Bun CLI that downloads YouTube videos without any external
`yt-dlp` binary. The innerTube player-API call, client impersonation,
n-signature / signature decipher, and throttled multi-connection download are
all implemented in JS inside the skill. The engine is Bun; the browser is
optional and only consulted for cookies when a video needs auth.

```bash
ytdl "https://www.youtube.com/watch?v=..."            # best quality → ~/Downloads
ytdl "https://www.youtube.com/watch?v=..." -q 360p    # 360p muxed (no ffmpeg)
ytdl "https://www.youtube.com/watch?v=..." -q 1080p    # 1080p (ffmpeg mux)
ytdl "https://www.youtube.com/watch?v=..." -q audio    # audio only
ytdl "https://www.youtube.com/watch?v=..." --formats   # list itags, don't download
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

Verify:

```bash
ytdl "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --formats
```

## Quality targets

| `-q`     | what happens                                                | needs ffmpeg? |
|----------|-------------------------------------------------------------|---------------|
| `360p`   | muxed itag 18 — one file, audio+video, un-throttled         | no            |
| `720p`   | muxed itag 22 if present, else adaptive 136+140 muxed      | only if adaptive |
| `1080p`  | adaptive itag 137 (video) + 140 (audio), muxed             | yes           |
| `best`   | highest available (usually adaptive 1080p)                  | yes           |
| `audio`  | best audio-only (itag 140 m4a / 251 webm)                   | no            |

## How it works

| Step | What ytdl does | Why |
|------|----------------|-----|
| 1 | Scrape a fresh unauthed `visitor_data` from the watch HTML | The player API rejects unauthed `android_vr` with `LOGIN_REQUIRED` without it. Don't reuse the watch tab's — it's bound to your authed session. |
| 2 | `POST /youtubei/v1/player` as `android_vr` (`clientVersion: 1.65.10`) | This client is *jsless* and SABR-free at 1.65.10: format URLs come back direct, no `signatureCipher`, no `n` — nothing to solve. |
| 3 | If `UNPLAYABLE` (made-for-kids / age-gated / members-only), fall back to `web_embedded` | Needs an embedder identity (`thirdParty.embedUrl`) + `encryptedHostFlags` + `signatureTimestamp`; its URLs carry an `n` that must be transformed or YouTube 403s. |
| 4 | Fetch the player's `base.js` and run the EJS AST solver (vendored meriyah + astring) in-process | Solves the `n` and any `signatureCipher` by calling the page's own decipher functions — no transpilation, the real functions. Only when a client returns `n`/`signatureCipher` (web_embedded does; android_vr doesn't). |
| 5 | Download with N concurrent `Range:` requests | Adaptive URLs throttle to ~26 KB/s on one connection; each fresh range request gets its own full-speed burst. Single-stream → 26 KB/s; 16 connections → ~3 MB/s. |
| 6 | For HD, `ffmpeg -i video -i audio -c copy -movflags +faststart out.mp4` | DASH serves video-only + audio-only separately above 360p. |

## Gated content (made-for-kids / age-gated / members-only)

These return `UNPLAYABLE` on the unauthed `android_vr` client. ytdl falls back
automatically:

- It fetches the embed page with `Referer: <embedUrl>` so the server returns a
  valid `encryptedHostFlags` (no referrer → Error 153, "embedder identity
  missing"). The default `embedUrl` is `https://www.reddit.com/` (any non-YouTube
  URL works).
- It reads the `signatureTimestamp` (STS) from `base.js` or, if
  `browser-harness-js` is on PATH and a YouTube tab is open, from the tab's
  `ytcfg.STS`.
- If a logged-in YouTube tab is connected, it forwards the tab's cookies to the
  player API — that's what unlocks members-only / age-gated content.

To force the gated path or supply cookies explicitly:

```bash
ytdl <url> --client web_embedded
```

If `web_embedded` still returns `LOGIN_REQUIRED`, the missing piece is a
`poToken` (proof-of-origin, generated at runtime by the page's botguard). That's
not currently captured automatically — open the video in a logged-in browser
tab so ytdl can borrow its cookies, or fall back to a logged-in client.

## Files

All paths relative to `<skill-dir>` (the install path — see top of this doc).

- `scripts/ytdl` — the Bun CLI (`#!/usr/bin/env bun`)
- `scripts/setup` — symlink `ytdl` (+ `bun`, + optional `browser-harness-js`) onto PATH
- `lib/ytdl.ts` — client table, player API, n/sig solving, multi-connection download, ffmpeg mux
- `lib/solver/solver.ts` — EJS solver wrapper (preprocessing cache, n/sig solve)
- `lib/solver/core.js` — vendored EJS challenge solver (Unlicense, from yt-dlp/ejs)
- `lib/solver/meriyah.min.mjs` — vendored JS parser (ISC)
- `lib/solver/astring.mjs` — vendored AST code generator (MIT)
- `lib/solver/*.LICENSE` — upstream licenses

## Traps

- **Don't bump `android_vr` past `clientVersion: 1.65.10`.** Newer versions return SABR-only — no discrete itag URLs, just a server-chosen multiplex you can't capture. Pin it.
- **`visitor_data` must be fresh and unauthed** for `android_vr`. Reusing the watch tab's (bound to your authed session) → `LOGIN_REQUIRED`. ytdl scrapes it per run.
- **Adaptive URLs throttle to ~26 KB/s on one connection — with no `n` to solve on `android_vr`.** The un-throttle is multi-connection range download, not a header or `n` fix. Muxed itag 18 is exempt (single-stream is fine).
- **Signed URLs are IP- and time-bound.** `&expire=` is ~6h out; the `ip` param binds to the IP that made the player-API call. Download from the same machine/network within the window. Don't pass a URL solved on one host to another.
- **Live / Premiere uses HLS** (`playlist.m3u8` + `.ts`), not `videoplayback`. Not supported by this skill — use a tool with HLS remuxing.
- **`web_embedded` needs a `Referer` on the embed fetch** or the server bakes Error 153 into `encryptedHostFlags`. ytdl sets `Referer: <embedUrl>` automatically; override with `--embed-url`.
- **HD needs ffmpeg.** 360p muxed (itag 18) and audio-only don't.
