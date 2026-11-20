# google-com-maps

Saved lists on Google Maps (web) for a signed-in user: put a searched place into a named list,
create the list when it is missing, read a list back. No API exists for a personal saved list, and
the Maps UI is the only door, so this registry holds the sequence that worked and the traps found on
the way. (`skills/gmaps` is the read-only search skill; this learning is about the user's own lists.)

```js
await learnings("google-com-maps", "listItems", { list: "Trips" })
// -> { list, visibility, count, itemCount, complete, items: [{ name, detail: ["4.6(1,161)", "Attraction"], note }] }
await learnings("google-com-maps", "createList", { name: "Trips" })
// -> { created: false, name, count } when it exists, else { created: true, name }
await learnings("google-com-maps", "saveToList", {
  query: "Temple of Heaven Beijing", list: "Trips", mustContain: "Beijing|北京",
  note: "go early morning", fallbacks: ["天坛公园"],
})
// -> { saved: true, alreadySaved, listCreated, list, name, address, usedQuery, note: "set" }
// -> { stop: "no-match", tried: [{ query, name, address, reason: "region"|"noise"|"name"|"no results" }] }
```

Every call opens one background tab in the default context (the Google login lives there), turns
on focus emulation so the hidden tab renders and takes input, and closes the tab in `finally`.
Nothing touches an existing tab. Sign-in is checked as a boolean only; a signed-out browser throws.

## The sequence

1. Saved panel by URL, no menu clicking: `https://www.google.com/maps/@0,0,3z/data=!4m2!10m1!1e1?hl=en`.
   List rows are `button`s whose text is `[icon]\nName\nPrivate · 17 places`.
2. Open a list by clicking its row. The panel shows the title line, then `Private · N places`.
   Each item holds one `textarea[aria-label="Note"]` (empty for no note); the highest ancestor with
   exactly one such textarea is the item root: first line is the name, the rest is rating, category or address.
3. Place search is a URL, not the search box: `/maps/search/<query>?hl=en`. Two shapes come back:
   a results feed (`[role=feed] a[href*="/maps/place/"]`, card in the nearest `[role=article]`), or a
   straight redirect to one place page. Handle both.
4. On a place page: `h1` is the name, `[data-item-id="address"]` the address, `[data-item-id="oloc"]`
   the plus code. The address alone often has no city ("Dongcheng, China"); the plus code row has it
   ("..., Beijing, China"). `mustContain` is checked against all three.
5. The Save button is `button[aria-label]` matching `Save`, `Saved` or `Saved (N)` (N = lists the place is in).
   It opens a chooser of `[role=menuitemradio]` rows, one per list, plus a `New list` button.
6. A chooser row is a TOGGLE: `aria-checked="true"` means the place is already in that list and a
   click removes it. The tool reads `aria-checked` first and never clicks a checked row.
7. Confirm by read-back, never by the click: the `Saved in <list> & ...` chip names the list, or the
   Save button count goes up. The chip also shows the item's note on its second line.
8. Notes go in through the list view: JS `click()` on the item's `Add note` button, focus the
   textarea, `Input.insertText`, Tab to commit, read the value back. A coordinate click on `Add note`
   misses after the list scrolls; the JS click does not.

## Gotchas

- Names carry an icon glyph from the Private Use Area (`` to ``) and NBSP. Strip them
  before comparing; `textContent === "Saved"` is false until you do. List names match exactly (case
  and spacing folded), never fuzzy: "Trips" must not resolve to "Trips 2026".
- Result picking is by name and region, not by position. Noise is dropped unless the query asks for
  it: ticket offices, hotels, shops, lodging, farm stays. English "Mutianyu" returns only its ticket
  office, so the tool rejects it and the Chinese fallback query (`fallbacks`) finds the real entry.
  A different place sharing one word is rejected too: "Tianmen Cave" has no entry on Maps, and the
  only hit is Tianmen Mountain, so `saveToList` returns `no-match` and saves nothing.
  A Chinese-only query skips the English-name guard (Maps shows English names for it).
- A place Maps renames: the saved item carries the place page `h1`, which may differ from the query
  (a Mutianyu search saves as "Great Wall of China"). The return value names what was saved.
- Typeahead in the list view's "Add a place" box is unreliable in a background tab (stale
  suggestions, a dropdown that never renders). That is why search goes through the results URL.
- Maps redirects some searches to one place page and others to a feed; a feed card carries only a
  plus code for many Chinese places, so the region check runs on the place page, not the card.
- Writes are confirmed by re-reading. `outcome-unknown` means "inspect before retrying"; the tool
  never replays a click.
- `createList` and the create-from-chooser path of `saveToList` type into a dialog named `New list`
  (an `input`, 40 character limit, prefilled `Untitled list`) and click `Create`. Escape does not
  close that dialog; navigating away discards it.

## Live status

live: listItems verified read-only against a signed-in browser (header count equals item count, notes read).
live: saveToList read half verified (search shapes, place page fields, Save chooser rows with `aria-checked`,
`New list` row, the dialog's fields). The click-a-row save and the note typing were driven by an
earlier agent run (16 places saved into one list with notes, read back); this module restates that
sequence as code and is covered offline by `tools/google-com-maps.test.mjs`, not re-driven live.
live: unverified for `createList` and the create-from-chooser path (the dialog was opened and read, never submitted).
