# vietnamairlines-com (Vietnam Airlines booking flow)

Notes only, no tools. Hosts: `www.vietnamairlines.com` (home search), `booking.vietnamairlines.com` (availability to payment). UI is Vietnamese.

STOP RULE: never submit a payment on the user's behalf. Drive up to `/booking/payment` and hand over. Never type card data.

## Input mechanics

- Angular (Material). Plain text: native `HTMLInputElement` value setter plus `input`, `change`, `blur`.
- Dropdowns, autocompletes, radios and fare cards ignore `element.click()`. Use `scrollIntoView` then a real CDP mouse click at the element centre (`browser-cdp click <x> <y>` on port 9222).
- The guarded Page API refused several of these as covered or not operable; one-shot `browser-cdp eval` and `browser-cdp click` worked.
- A background tab ignores clicks until activated: `GET http://127.0.0.1:9222/json/activate/<targetId>`.

## Home search

- Trip type buttons: "Khứ hồi" (return), "Một chiều" (one way).
- Origin button `aria-label="Chọn điểm đi"` opens a search input `#__search-in-choose-region-back-from-0`; destination is `#__search-in-choose-region-back-to-0`. Type into it (native setter plus `input`), then click the matching `div.location` row.
- Day buttons are plain BUTTONs whose text is the day number. Click by coordinates.
- Submit with `#btnSubmitBooking`; it opens `booking.vietnamairlines.com/booking/availability/0`.

## Availability and cart

- A flight's economy button reveals fare cards `refx-price-card.fare-family-EL2` (Economy Saver).
- "XÁC NHẬN VÀ TIẾP TỤC" then raises an upsell dialog. Choose "GIỮ PHỔ THÔNG TIẾT KIỆM" to keep Economy Saver.
- Cart is `/booking/shopping-cart`. Click "TIẾP TỤC" as a guest.

## Traveler page (`/booking/traveler`)

Input ids end with these suffixes (match with `[id$="..."]`):

| Field | Suffix | Kind |
| --- | --- | --- |
| Title | `PersonalInfotitle` | mat-select: Ông, Bà, Cô/chị |
| Given and middle name | `PersonalInfofirstName` | text |
| Surname | `PersonalInfolastName` | text |
| Date of birth | `PersonalInfodob` | text |
| Nationality | `documentType-0nationality` | mat-autocomplete |
| Issuing country | `documentType-0issuanceCountry` | mat-autocomplete |
| Phone country code | `phoneItem-0phoneCountryCode` | mat-autocomplete |
| Document number | `documentType-0documentNumber` | text |
| Document expiry | `documentType-0expiryDate` | text |
| Email | `emailItem-0email` | text |
| Phone | `phoneItem-0phone` | text, no leading 0 |

- mat-autocomplete: set the value, dispatch `input`, then click the `mat-option`. Setting the value alone does not select.
- Gender is a mat-button-toggle group: Nam (male) or Nữ (female). Click it.
- A data-consent checkbox is required before "XÁC NHẬN" works.
- "XÁC NHẬN" returns to the cart, which now shows "CHỌN CHỖ" (choose seats).

## Seats

- Seat map is `/booking/seatmap/ST1`. Seat buttons carry text like "Ghế 14C" and classes such as `seat-characteristic-front-aisle` and `chargeable-seat`.
- Price tiers by row: row 12 (`seat-characteristic-UP`) cost about twice row 14. Check the class before choosing.
- A seat dialog has "CHỌN CHỖ NGỒI", then "XÁC NHẬN". Back in the cart, "TIẾP TỤC" goes to `/booking/payment`. Stop there.

## Caveats

- Website prices can differ from Google Flights. Quote the site's own total.
- Re-check the path and the total before each step instead of batching blind clicks.
