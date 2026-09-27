# mail-google-com

Sending a Gmail message as a send-as alias (a Google Group address, a shared team address) has
no clean API from a CDP session: it is the same signed-in web UI as any other Gmail send, with
one extra, hidden step. This registry exists because that step resists the usual click
techniques and is easy to get subtly wrong (right message, wrong sender).

```js
await learnings("mail-google-com")
await learnings("mail-google-com", "findAccountSlot", { email: "user@example.com" })
await learnings("mail-google-com", "prepareDraftAs", {
  authuser: 0, to: "someone@example.com", subject: "Subject",
  body: "Body text", alias: "alias@example.com",
})
// read back the {to, subject, from} above, get the human's go-ahead, then:
await learnings("mail-google-com", "sendPreparedDraft", { targetId, confirm: true })
await learnings("mail-google-com", "verifySent", { recipient: "someone@example.com" })
```

## Limits (learned 2026-09-27)

- **Account picking is by index, not email.** `https://mail.google.com/mail/u/<n>/` selects the
  signed-in account at slot `n`; `document.title` ends with `- <email> - ...`, so
  `findAccountSlot` walks `n=0..3` and matches the title instead of guessing the slot.
- **The compose URL prefills but does not send.** `?view=cm&fs=1&to=...&su=...&body=...` opens a
  full-page compose with To/Subject/Body already filled; Gmail auto-saves it as a draft, so a
  failed or abandoned run leaves a draft behind, not a queued send.
- **The From selector is hidden on this view.** `element.click()` and dispatched `MouseEvent`s on
  the option do nothing. What works is a real `Input.dispatchMouseEvent`
  (`mouseMoved` -> `mousePressed` -> `mouseReleased`) at the element's own bounding-rect centre,
  three times in sequence: click inside the To row to expand the collapsed header (the From line
  then renders as its own leaf), click that From line to open the picker, click the alias option
  (`[role=menuitem]`/`[role=option]`, filtered to non-zero bounding width; the DOM keeps closed
  copies of the same items at width 0). Pressing Enter on the highlighted option did not select
  it.
- **Verify the switch actually happened before trusting it.**
  `[...document.querySelectorAll('input[name=from]')].map(x => x.value)` must include the alias
  address. Do this before Send, not after.
- **Screenshots are 2x device pixel ratio.** A coordinate read off a screenshot is device px, not
  CSS px; divide by the capture scale (2) before using it in `Input.dispatchMouseEvent`. Guessing
  from a screenshot picked the wrong alias once. Element bounding rects are already in CSS px and
  don't need this conversion, so prefer them over screenshot coordinates entirely.
- **Send verification is a Sent-folder search, not a toast.** Real-click the visible
  `[role=button]` whose `innerText` is exactly `Send`, then confirm by navigating to
  `#search/in%3Asent+to%3A<recipient>+newer_than%3A1d` and counting `tr.zA` rows.
- **The thread Reply button was unreliable from a background tab.** In a conversation view it did
  not open a real editor, only an `Ask Gemini` contenteditable was present. Composing a fresh
  `Re: <subject>` through the compose URL (`prepareDraftAs`) was the working fallback for
  replying to an existing thread.
- **Sending is outward and irreversible.** `prepareDraftAs` stops at the alias switch and returns
  `{to, subject, from}` for a read-back. `sendPreparedDraft` refuses unless `confirm: true`, and
  that confirmation should come from the human having reviewed From, To, and Subject in that one
  read, not from the agent's own judgment.

## Provenance

2026-09-27, live session sending as a Google Group send-as alias. Driven by hand through
`browser-harness-js` with an explicit `wsUrl`, then distilled here.
