---
name: ytdl
description: >-
  Download YouTube videos as a self-contained Bun CLI — no `yt-dlp` binary.
  Browser-native where it counts: for 360p the logged-in watch page renders the
  player data with full auth (cookies, poToken's effect), so ytdl reads the
  inlined `ytInitialPlayerResponse` directly — zero client impersonation. For HD
  it impersonates a SABR-free innerTube client (android_vr / web_embedded) over
  the player API, deciphers the n-signature using the page's own player JS via a
  vendored AST solver (meriyah + astring + EJS), and downloads with
  multi-connection range requests to dodge the per-connection throttle. The
  engine is Bun; the browser is optional for public content, primary for gated.
  Use when the user wants to download, save, or fetch a YouTube video (audio or
  video) to disk.
setup: bash <skill-dir>/scripts/setup
compatibility: Requires `bun` on PATH (bundled with the cdp skill, or via https://bun.sh). `ffmpeg` on PATH for 720p+ HD (360p muxed needs no ffmpeg). `browser-harness-js` on PATH + a logged-in YouTube tab for made-for-kids / age-gated / members-only content at 360p.
---

# ytdl — self-contained YouTube downloader

> ⚠️ **Required before first use:** run `bash <skill-dir>/scripts/setup` to put the
> `ytdl` CLI on PATH. The script also symlinks `bun` (the engine) and, if the
> `cdp` skill is installed, `browser-harness-js` (for the native 360p path).

A standalone Bun CLI that downloads YouTube videos without any external
`yt-dlp` binary. The browser does the auth (it already has cookies, poToken,
the real client context); Bun does the download + n-solve + mux. Public videos
work standalone; gated content leans on the logged-in browser page.

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

## How it works — two paths

The skill picks a client per quality and gatedness, not one path for everything:

### 360p — browser-native (`inlined`), gated content's primary

For 360p muxed (itag 18), the browser is the engine *for the auth*. A logged-in
watch page renders `ytInitialPlayerResponse` inlined in its initial HTML — the
player data the page got with full auth: cookies, poToken's effect, the real
client context. ytdl opens the watch page in a background tab via
`browser-harness-js`, polls for that inlined JSON (it's available before the
player boots, so no `networkIdle` wait), pauses the `<video>` immediately to
stop the page's own streaming, and reads it. **Zero client impersonation, zero
header spoofing, zero embedder-identity gymnastics** — the page *is* the client.

The inlined web response carries a discrete itag 18 URL with an unsolved `n`.
Bun solves that `n` against the page's `base.js` (main variant — see traps) and
downloads it single-stream (itag 18 is unthrottled, so no parallel ranges).

### HD / audio — player-API clients (`android_vr`, `web_embedded`)

Above 360p the logged-in web client is **SABR-based**: adaptive formats come
back with no discrete URL, only a server-chosen multiplex (`application/vnd.yt-ump`)
that isn't range-downloadable. To get discrete adaptive URLs (itag 136/137 video,
140 audio) ytdl calls the player API as a SABR-free client:

- **`android_vr`** (`clientVersion: 1.65.10`) — primary for public content. Jsless
  and SABR-free at this version: URLs come back direct, no `signatureCipher`, no
  `n` — nothing to solve. Needs a fresh unauthed `visitor_data` (scraped per run).
- **`web_embedded`** — fallback when `android_vr` returns `UNPLAYABLE`
  (made-for-kids / age-gated / members-only). Needs an embedder identity
  (`thirdParty.embedUrl`) + `encryptedHostFlags` + `signatureTimestamp`; its
  URLs carry an `n` that must be transformed or YouTube 403s. ytdl fetches the
  embed page with `Referer: <embedUrl>` (default `https://www.reddit.com/`) so
  the server returns a valid encrypted context, and forwards the logged-in tab's
  cookies (read in the same browser round-trip as the inlined path) to unlock
  gated content.

The `n` on these URLs is solved with the vendored EJS AST solver (meriyah +
astring) calling the page's own decipher functions. Adaptive streams throttle to
~26 KB/s on one connection, so Bun opens 16 concurrent `Range:` requests — each
gets its own full-speed burst. HD (video-only + audio-only) is muxed with ffmpeg.

### Client selection order

`ytdl` tries clients in order and uses the first that returns `playability: OK`
with a discrete URL for the requested quality:

| quality | order (auto) | why |
|---------|--------------|-----|
| `360p`  | `android_vr` → `inlined` → `web_embedded` | android_vr is fast + headless for public; inlined (native, full auth) cracks made-for-kids; web_embedded last |
| HD / `best` / `audio` | `android_vr` → `web_embedded` → `inlined` | inlined has no discrete adaptive URLs (SABR), so it's a 360p-only fallback here |
| `--client X` | `X` only | force a specific client |

## Gated content (made-for-kids / age-gated / members-only)

These return `UNPLAYABLE` on the unauthed `android_vr` client. For 360p the
`inlined` browser path cracks them automatically — open the video in a logged-in
browser and ytdl reads the authed inlined response, no impersonation. For HD,
`web_embedded` is the fallback (with the logged-in tab's cookies forwarded).

To force a client explicitly:

```bash
ytdl <url> --client web_embedded
```

If `web_embedded` still returns `LOGIN_REQUIRED`, the missing piece may be a
`poToken` (proof-of-origin, generated at runtime by the page's botguard). The
inlined 360p path sidesteps this entirely (the page already has poToken); the
HD `web_embedded` path does not, since it constructs the request outside the
page. If that bites, fall back to 360p (inlined) for that video.

## Files

All paths relative to `<skill-dir>` (the install path — see top of this doc).

- `scripts/ytdl` — the Bun CLI (`#!/usr/bin/env bun`)
- `scripts/setup` — symlink `ytdl` (+ `bun`, + optional `browser-harness-js`) onto PATH
- `lib/ytdl.ts` — client table, browser resolve, player API, n/sig solving, multi-connection download, ffmpeg mux
- `lib/solver/solver.ts` — EJS solver wrapper (preprocessing cache, n/sig solve)
- `lib/solver/core.js` — vendored EJS challenge solver (Unlicense, from yt-dlp/ejs)
- `lib/solver/meriyah.min.mjs` — vendored JS parser (ISC)
- `lib/solver/astring.mjs` — vendored AST code generator (MIT)
- `lib/solver/*.LICENSE` — upstream licenses

## Traps

- **Don't bump `android_vr` past `clientVersion: 1.65.10`.** Newer versions return SABR-only — no discrete itag URLs, just a server-chosen multiplex you can't capture. Pin it.
- **`visitor_data` must be fresh and unauthed** for `android_vr`. Reusing the watch tab's (bound to your authed session) → `LOGIN_REQUIRED`. ytdl scrapes it per run.
- **The solver needs the `main` player JS variant, not `es6`.** The watch page loads `player_es6.vflset/...base.js`, but the EJS solver produces *wrong* n-transforms for the es6 variant. ytdl extracts the player_id and fetches `player_ias.vflset/en_US/base.js` (the `main` variant yt-dlp forces) — never trust the tab's `PLAYER_JS_URL` variant directly. A wrong-but-changed n looks like a successful solve but 403s at download.
- **The inlined browser path is SABR for adaptive.** `ytInitialPlayerResponse` gives a discrete itag 18 (360p) but adaptive formats have no URL — that's why HD can't use the inlined path and falls back to `android_vr`/`web_embedded`. Don't try to harvest an HD URL from the inlined response.
- **Pause the watch page's `<video>` before downloading.** The inlined path opens a background watch tab; if the page's own player streams googlevideo concurrently with your download, the two collide on the same IP and rate-limit each other (transient 403s). ytdl pauses the video immediately after reading the inlined JSON. If you ever hand-edit the browser snippet, keep that pause.
- **Adaptive URLs throttle to ~26 KB/s on one connection — with no `n` to solve on `android_vr`.** The un-throttle is multi-connection range download, not a header or `n` fix. Muxed itag 18 is exempt (single-stream is fine).
- **Signed URLs are IP- and time-bound.** `&expire=` is ~6h out; the `ip` param binds to the IP that made the player-API call. Download from the same machine/network within the window. Don't pass a URL solved on one host to another.
- **Live / Premiere uses HLS** (`playlist.m3u8` + `.ts`), not `videoplayback`. Not supported by this skill — use a tool with HLS remuxing.
- **`web_embedded` needs a `Referer` on the embed fetch** or the server bakes Error 153 into `encryptedHostFlags`. ytdl sets `Referer: <embedUrl>` automatically; override with `--embed-url`.
- **HD needs ffmpeg.** 360p muxed (itag 18) and audio-only don't.
- **HD (`best`/`1080p`) occasionally 403s on a single range chunk — it's transient, not a wrong solve.** `fetchRetry` already retries 403/429 a few times with backoff, which covers most cases. If a download still fails mid-stream, just re-run. Don't probe harder — aggressive retry/re-probe of googlevideo risks an IP ban, and the solved URL is verifiably good (a clean probe of the same URL returns 206 15/15). This one rough edge is left as-is deliberately.
