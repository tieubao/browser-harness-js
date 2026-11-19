# flyscoot-com (Scoot booking flow)

Notes only, no tools: the flow is a long Angular wizard, and each step needs a trusted click, so a recipe list beats a brittle tool. Hosts: `www.flyscoot.com` (home), `booking.flyscoot.com` (search to review), `payments.flyscoot.com` (payment).

STOP RULE: never submit a payment on the user's behalf. Drive up to the payment page (`payments.flyscoot.com/collect`) and hand over. Never type card data.

## Input mechanics (all three travel sites share this)

- The site is Angular. For a plain text field, set `input.value` through the native `HTMLInputElement.prototype.value` setter, then dispatch `input`, `change` and `blur`. Assigning `el.value = ...` directly is ignored by the form model.
- Dropdowns, autocompletes, radios and fare cards ignore `element.click()`. Do `scrollIntoView`, read the element centre, and send a real CDP mouse click at those coordinates.
- The guarded Page API refused several of these clicks (element covered, not operable). Re-attaching to the Scoot tab also failed with `Cannot access a chrome-extension:// URL of different extension`. The one-shot `browser-cdp eval` and `browser-cdp click <x> <y>` on port 9222 worked every time; use them when `page.*` refuses.

## Home page

- A KrisFlyer sign-up popup covers the search form. Close it by clicking `img[alt="kf close icon"]` by coordinates.
- Form inputs carry aria-labels: `origin-input`, `destination-input`, `departure-date-input`.
- `departure-date-input` is readonly and opens an ngb datepicker. Day cells: `.ngb-dp-day[aria-label="Friday, November 20, 2026"] .custom-day`, then click the Confirm button. The calendar's `no-flight-text` class is not reliable, so do not use it to decide whether a day has flights.

## Results URLs (skip the home form)

```
https://booking.flyscoot.com/book/flight/return/DAD/20%20Nov%202026/SIN/SIN/21%20Nov%202026/DAD?adult=1&child=0&infant=0&cur=VND&culture=en-sg
https://booking.flyscoot.com/book/flight/oneway/DAD/20%20Nov%202026/SIN?adult=1&child=0&infant=0&cur=VND&culture=en-sg
```

Dates are `DD%20Mon%20YYYY`. Return order is origin, depart date, destination, return origin, return date, return destination.

## Fare selection

- Each flight card has a `div.text-button` labelled "Select Fare". Click it to open the tiers Basic, Value, Flex.
- Each tier has a BUTTON with text "Select". Basic is index 0 of those buttons.
- The header total updates once a fare registers. Read it to confirm the click took before moving on.

## Passenger page (`/book/passenger`)

Input ids: `salutation0-passenger-0`, `firstName0-passenger-0`, `lastName0-passenger-0`, `dateOfBirth0` (format DD/MM/YYYY), `nationality0-passenger-0`, `residentCountry0-passenger-0`, `contactEmailAddress-passenger-0`, `contactMobileCountryCode-passenger-0`, `contactMobileNumber-passenger-0`, `contactPostalCode-passenger-0` (required, easy to miss).

- Text fields: native setter plus events.
- Dropdown fields (salutation, nationality, residence, country code): click the field, then click the option `span.label` found inside the field container five parents up from the input. The chosen value shows in `.dropdown-value`; read it to verify.
- "Go to Add-Ons" leads to `/book/addons`.

## Seats and review

- On add-ons, Seat Selection "Add" opens the map. Seats are `.seat-item[aria-label="Scoot NormalSeat Designator 2C"]`.
- Clicking a seat shows a price popup with an "Add Seat for <name>" button. Click it, then "Done", then "Review Booking" (`/book/review`).
- "Make Payment" on review goes to `payments.flyscoot.com/collect`. Stop there.
- A booking left idle on the review page resets to flight select. Redo the passenger form; do not leave a prepared booking sitting while waiting on the user.

## Verification habit

After every step read the header total and the current path (`/book/passenger`, `/book/addons`, `/book/review`) before the next click. Website prices can differ from Google Flights; quote the site's own total.
