# google-com-travel-flights

One-way fare search on Google Flights, driven by the natural-language `q=` URL, with no form
interaction. Built because a planning session scraped the same page with shell scripts about 65
times.

```js
await learnings("google-com-travel-flights", "searchOneWay", { from: "KIX", to: "PVG", date: "2026-12-20" })
// -> { url, expanded, count, rows: [{ depart, arrive, plusDays, airline, durationMin, duration,
//      route: "KIX-PVG", stops: 0, layover: "", price: 226, priceText: "$226" }, ...] }
const r = await learnings("google-com-travel-flights", "searchOneWay", { from: "NRT", to: "PVG", date: "2026-12-21", nonstopOnly: true })
```

URL shape: `https://www.google.com/travel/flights?q=Flights%20from%20<FROM>%20to%20<TO>%20on%20<YYYY-MM-DD>%20one%20way%20economy&hl=en&curr=USD`.

## Gotchas

- Codes only. Natural-language city names in `q=` fail (no rows). Use IATA airport codes or
  city codes (TYO, OSA).
- `SHA` means Hongqiao airport only. For Shanghai Pudong use `PVG`.
- Each result `<li>` is in the DOM twice (a compact row and an expanded one, ~100 vs ~400
  chars). The tool dedupes on depart, arrive, plusDays, airline, route, stops, price.
- The top ~12 rows show first; the rest sit behind "View more flights". That control is a
  plain `<li><div><span>`, not a `<button>`, so `querySelector("button")` finds nothing.
  `expand: true` (default) clicks it; KIX to PVG goes from 12 rows to ~136.
- A background tab can return empty `innerText` for later rows. The tool falls back to the
  row's text nodes (`textContent` walk) when that happens.
- Prices are per adult, one way, in the `curr=` currency, taxes included as Google shows them.
  A row with "Price unavailable" comes back with `price: null`.
- Marketing and operating carrier text is glued together without a separator
  (`China EasternShanghai Airlines, JAL`); split it yourself if it matters.
- `plusDays` is the `+1` suffix on the arrival time. `layover` is Google's own text for the
  stop (`2 hr 20 min HKG`); multi-stop rows keep only the first layover line.
- The parser expects English labels (`Nonstop`, `1 stop`), so keep `lang: "en"`.
- Polling replaces a fixed sleep: it waits until the row count is above zero and unchanged for
  two 1s polls (first render usually 3 to 8 s).
