# drive-google-com

Google Drive file a CLI cannot fetch but the signed-in browser can. The Drive MCP returns base64
(useless past a few MB), `curl` on `uc?export=download` gets a sign-in page, `yt-dlp
--cookies-from-browser` (Helium, Chrome, Edge, Safari) and `rclone personal:` all returned 403,
because the file was shared under the SECOND Google account in the browser (`/drive/u/1/`). The
browser session already holds that account, so the recipe is the download URL with the right
`authuser` slot plus the virus-scan interstitial's form submit.

```js
await learnings("drive-google-com")
await learnings("drive-google-com", "status")
await learnings("drive-google-com", "download", { fileId: "1znmq…", authuser: 1 })
```

Then watch `~/Downloads/<name>.crdownload` become `<name>`; a 668 MB file took under a minute.

## Limits (learned 2026-09-23)

- `authuser` is the account SLOT, not an email; the folder URL's `/u/<n>/` tells you which.
- `Browser.setDownloadBehavior` with a custom `downloadPath` was ignored by Helium; the file goes to the browser's own download directory.
- Files over about 100 MB get the "Google Drive can't scan this file for viruses" page; `confirm=t` alone does not skip it, submitting its form does.
- Never `rm` the downloaded file from a hook-guarded shell; move it with `mv`.

## Provenance

2026-09-23, the first Dwarves Dispatch recording (one 33-minute .mkv in a shared Drive folder).
Driven by hand through `browser-harness-js` with an explicit `wsUrl` from `127.0.0.1:9222`, then
distilled here. Pipeline that consumed the file: `foundation-ops/cli/dispatch`.
