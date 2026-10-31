# booking-com

Hotel search on Booking.com through the `searchresults.html` URL. Filters and sort ride in the
query string, so the tool never touches the page's filter UI. Built because a planning session
scraped the same page with shell scripts many times.

```js
await learnings("booking-com", "searchHotels", {
  city: "Osaka", checkin: "2026-12-20", checkout: "2026-12-24", children: [7],
})
// -> { url, hotels: [{ name, priceTotal: 534, priceText: "US$534", score: 9.4, reviews: 7028 }, ...],
//      summary: { count: 20, median: 351, cheapest: [{ name, priceTotal }, x3] } }
```

URL shape: `https://www.booking.com/searchresults.html?ss=<city>&checkin=..&checkout=..&group_adults=2&group_children=1&age=7&no_rooms=1&selected_currency=USD&lang=en-us&nflt=class%3D3%3Bclass%3D4%3Breview_score%3D80&order=popularity`.

## Gotchas

- `priceTotal` is the whole stay for the room(s) shown, taxes as Booking displays them. It is
  NOT per night: divide by nights yourself.
- Works logged out. No cookie banner blocks the cards.
- `nflt` is one `class=N` per wanted star rating plus `review_score=80` for 8.0 and up
  (the filter is score x 10). `minStars: [3,4]` means 3 and 4 stars only, not "3 or more".
- Each `age=` param is one child; `group_children` must equal the number of ages.
- Card hooks: `[data-testid=property-card]`, `title`, `price-and-discounted-price`,
  `review-score`. A discounted card shows struck and live prices in one node; the tool takes
  the last number. Read with `textContent`, which stays populated in a background tab.
- `order=popularity` is Booking's default ranking, not price. For cheapest use
  `summary.cheapest` over the returned page, or sort `hotels` yourself.
- The first page holds about 25 cards; `limit` above that returns what rendered. The tool
  does not scroll for more.
- Names can be in another script (`AYA Residence大阪城公園 ...`); keep them verbatim.
- A bot-check or consent page shows as `{stop:"no-results"}` with the url to open by hand.
