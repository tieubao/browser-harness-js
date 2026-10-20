# chrome-extensions

Loading and managing extensions in a Chromium browser (Helium, Chromium 155 verified) over CDP.
Call the tools by name: `await learnings("chrome-extensions", "loadUnpacked", {path: "/abs/dir"})`.

## Why these tools

- **Load unpacked opens a native file picker.** CDP cannot drive it. `Extensions.loadUnpacked`
  is a browser-level CDP method that takes the directory path and skips the picker. It works over
  the plain remote-debugging websocket. It must run with no page session attached, so the tool
  clears the active session first and restores the previous one afterward.
- **Everything else goes through `chrome.developerPrivate`.** The `chrome://extensions` page is
  nested shadow roots (`extensions-manager` > `extensions-item-list` > `extensions-item` ...), so
  DOM clicks are brittle. The page's own UI calls `chrome.developerPrivate.*`, and so can we via
  `Runtime.evaluate` with `awaitPromise: true, returnByValue: true`.

## developerPrivate calls that worked live

| Call | Use |
|---|---|
| `getExtensionInfo(id)` | version, state, runtimeErrors `[{id, message, source, severity, occurrences}]`, manifestErrors, prettifiedPath |
| `reload(id, {failQuietly: true})` | reload after editing files; returns a load error object instead of throwing |
| `deleteExtensionErrors({extensionId, errorIds})` | clear the error list |
| `updateProfileConfiguration({inDeveloperMode})` | Developer mode switch |

## Traps

1. **Developer mode must be on for unpacked extensions to stay enabled across restarts.** With it
   off, the browser disables them at next launch. Run `setDeveloperMode({enabled: true})` once.
2. **The REPL prints only one bare expression, and a thrown `Runtime.evaluate` shows nothing.**
   A page-side exception comes back as `exceptionDetails` on the result, not as a throw. The
   tools check it and throw an Error carrying the exception description. When hand-rolling,
   always destructure and return `exceptionDetails`.
3. **`extensionInfo` opens a background `chrome://extensions` tab if none is open** and closes it
   afterward. A tab you opened yourself is reused and left alone.
4. **Edits to the tool file need `browser-harness-js --restart`** (see `../README.md`).
