# localhost-dev-page

Driving a click on a local dev page (a vite dev server, any `localhost:<port>` page) when the
running browser the human is looking at has no debugging listener and relaunching it would kill
their session. The fix is a throwaway second Chromium instance, driven over raw CDP because the
harness's own `Session` cannot discover it.

## Provenance

2026-09-13: a vite dev page at `http://localhost:5173/` needed one button clicked to start audio,
because browsers require a user gesture before an `AudioContext` can resume. macOS denied
synthetic input to the human's real browser window; a throwaway Chromium instance plus a raw CDP
`Runtime.evaluate({userGesture: true})` click closed it.

## Launch the throwaway instance

```bash
d=$(mktemp -d)
nohup "/Applications/Helium.app/Contents/MacOS/Helium" --user-data-dir="$d" \
  --remote-debugging-port=9333 --autoplay-policy=no-user-gesture-required \
  --no-first-run --no-default-browser-check "http://localhost:5173/" >/dev/null 2>&1 &
```

`--autoplay-policy=no-user-gesture-required` only helps a page that starts audio on its own load.
It does not remove the need for a click when the page builds its audio graph inside a click
handler, which is the common case: the click still has to be dispatched.

## Call it

```js
await learnings("localhost-dev-page", "clickAndVerify", {
  urlIncludes: "5173",
  selector: "#audio",
  before: 'JSON.stringify({label: document.querySelector("#audio").textContent, disabled: document.querySelector("#audio").disabled})',
  after: 'JSON.stringify({label: document.querySelector("#audio").textContent, disabled: document.querySelector("#audio").disabled})',
  delayMs: 2500,
})
```

## Four traps, each cost a round trip

1. **Two listeners can hold the same debugging port, one on IPv4 and one on IPv6.** A dead
   earlier instance kept `127.0.0.1:9333` while the live one listened on `[::1]:9333`, so
   `curl http://127.0.0.1:9333/json/version` answered from the dead one and every target list
   came back empty or stale. `lsof -nP -iTCP:9333 -sTCP:LISTEN` shows both rows with their pids.
   Probe the `[::1]` form as well as `127.0.0.1`, or resolve the pid first. `clickAndVerify`
   checks both.
2. **The harness's own `listPageTargets()` / `session.connect({wsUrl})` cannot see a second,
   independently launched instance.** Connecting against the browser-level websocket URL of the
   throwaway instance reports `connected: true` (`--status` shows it) yet discovers no targets
   from it: the harness's `Session` is bound to whichever browser it originally attached to.
   There is no `--ws-url` flag on the harness CLI either; passing one shifts the snippet argument
   and throws `ReferenceError: ws is not defined`. This is why `clickAndVerify` does not take
   `ctx.session` at all: it opens its own raw `WebSocket` to the page's own
   `webSocketDebuggerUrl` from `/json/list`, which is the fallback path for any instance the
   harness did not attach to.
3. **`userGesture: true` on `Runtime.evaluate` is what makes a gated click work.** Without it, a
   click handler that requires activation (resuming an `AudioContext`, some autoplay/permission
   gates) silently no-ops. `clickAndVerify` always passes it.
4. **A background window throttles `requestAnimationFrame` to a standstill.** After a successful
   click the page's own tick counter did not advance for seconds and read as a hung app.
   `osascript -e 'tell application "Helium" to activate'` (which needs no assistive access, unlike
   a click/keystroke through System Events) brought the window forward and the counter advanced
   immediately. Verify a running page by reading a counter (or any changing value) twice with a
   delay, never by one sample.

## Why macOS synthetic input didn't work

`osascript ... tell application "System Events" to click at {x, y}` failed with
`execution error: System Events got an error: osascript is not allowed assistive access.
(-25211)`. `key code` presses through System Events reached the window (no assistive-access
error) but never actuated the button; only the CDP-level click with `userGesture: true` did.
`activate` (bringing an app/window forward, not clicking or typing into it) needs no assistive
access and is safe to use for trap 4 above.

## The state-change proof, not the click return

A synthetic `.click()` returning without error proves only that the element was found and the
click handler ran without throwing; it does not prove the click had the intended effect. The
closing proof here was the button's own state changing from `{label: "start audio", disabled:
false}` to `{label: "sound 34, noise: worklet", disabled: true}`, plus the page's own tick counter
advancing (3702 → 3810 over 2.5s) confirming the page was actually live, not just painted. Always
read `before` and `after` and diff them; a same-before-and-after result means the click did not
land, whatever the click call itself returned.
