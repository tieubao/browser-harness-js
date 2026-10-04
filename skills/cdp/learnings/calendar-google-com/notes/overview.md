# calendar-google-com

Read a Google Calendar "Secret address in iCal format" through the signed-in browser. There is no API for it: the Calendar API exposes the public address shape only, and the settings page fetches the private URL on demand.

**The value is a credential.** Anyone holding the URL reads every event on the calendar. The tool RETURNS it and prints nothing. Never print it, never paste it into chat, a log, or a commit. Capture it into a shell variable and pipe it to a secret store in the same command:

```bash
ICAL=$(browser-harness-js 'await learnings("calendar-google-com", "ical-secret", {calendarId: "you@example.com"})')
printf '%s' "$ICAL" | <secret-store-put-from-stdin>   # stdin only, never argv
unset ICAL
```

The REPL prints a string result raw (no JSON quotes), so `$(...)` captures the bare URL. Verify without printing: `[[ $ICAL == https://calendar.google.com/calendar/ical/*/basic.ics ]] && echo ok`.

```js
await learnings("calendar-google-com")
await learnings("calendar-google-com", "ical-secret", { calendarId: "you@example.com", authuser: 0 })
```

## Recipe (proven live 2026-09-26, Helium / Chromium 154)

1. Open a fresh tab per call: `Target.createTarget` + `Target.attachToTarget({flatten: true})`, route every call through `cdp(sessionId, ...)`, close the tab in `finally`.
2. Navigate to `https://calendar.google.com/calendar/u/<authuser>/r/settings/calendar/<base64 of the calendar id>`. For a primary calendar the id is the account email.
3. The secret field is an `<input>` holding 10 bullet characters. The real URL is fetched only after a reveal; it is never in the DOM before that.
4. Click the button with `aria-label="Toggle visibility"` with a real CDP mouse click (`Input.dispatchMouseEvent`).
5. The first click opens a "Security warning" dialog ("You should not give the secret address to other people", button OK). Click OK inside that dialog (`role=dialog` or `role=alertdialog`).
6. Click "Toggle visibility" AGAIN.
7. Read the input whose value matches `/https:\/\/calendar\.google\.com\/calendar\/ical\/[^\s"']*\/private-[^\s"'\/]+\/basic\.ics/`.
8. Re-mask: blank that input and drop any page variable that held the value (set it to `null`), then close the tab.

## Traps

- **Trap 1, off-viewport buttons.** At a narrow window (`innerWidth` 853) "Toggle visibility" and "Copy to clipboard" sit past the right edge of the viewport. A CDP click at the element centre lands outside the page and silently does nothing. Call `scrollIntoView({block: 'center', inline: 'nearest'})`, then click the centre of the part of the rect that is inside the viewport.
- **Trap 2, the Security warning dialog.** The first real click on "Toggle visibility" does not reveal anything; it opens the dialog. Click OK inside it, then click "Toggle visibility" a second time. Only then does an input carry the URL. The tool also handles the case where no dialog appears.
- **Clipboard is empty.** The page's "Copy to clipboard" button leaves the clipboard EMPTY under automation. Read the input value instead.
- **Never click "Reset".** It invalidates the address for every consumer of the feed. The tool refuses to click any element whose label or text mentions reset.

## Limits

- `authuser` is the account SLOT from `/calendar/u/<n>/`, not an email.
- Proven with an email calendar id only. The tool strips trailing `=` base64 padding; ids whose length needs padding (group calendars) are unverified live.
- The tool opens a background tab. The live proof drove the page by hand; a background tab under the tool itself has not been run against a real account yet.
- Errors never carry page text, so a failed run cannot leak the value into a log.

## Provenance

2026-09-26, driven by hand through `browser-harness-js` on Helium with an explicit `wsUrl`, then distilled here. Scaffolded via `browser-cdp learn new calendar-google-com --domains calendar.google.com`.
