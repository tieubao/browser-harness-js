# eservices-ica-gov-sg (SG Arrival Card)

Notes only, no tools. The Singapore Arrival Card (SGAC) form at `eservices.ica.gov.sg/sgarrivalcard`, which redirects to `/arrivalcard/sgac`. Angular Material.

STOP RULE: this is a government declaration. Never press the final submit on the user's behalf. Fill, review, and hand over.

Submission is allowed within 3 days before arrival.

## Input mechanics

- Plain text: native `HTMLInputElement` value setter plus `input`, `change`, `blur`.
- Like the other Angular travel sites, dropdowns and radios ignore `element.click()`: `scrollIntoView`, then a real CDP mouse click at the element centre (`browser-cdp click <x> <y>` on port 9222). The one-shot `browser-cdp eval` and `browser-cdp click` are the dependable path when the guarded Page API refuses a click as covered or not operable.
- If clicks do nothing in a background tab, activate it first: `GET http://127.0.0.1:9222/json/activate/<targetId>` (seen on vietnamairlines.com; not separately confirmed here).

## Start

For a visitor, click "Fill in Manually". There are two such buttons; the visitor one is the second.

## Field ids

Pattern `traveller-0-input-<name>`, names: `fullName` (given name, then surname), `passportNumber`, `emailAddress`, `mobileNumber`, `nationality`, `placeOfBirth`, `placeOfResidence`, `countryCode`, `lastCity`, `purposeOfTravel`, `nextCity`, `flightCode`, `flightNumber`.

## Date groups share ids

Three date groups reuse `traveller-0-input-day`, `-month` and `-year`. In document order they are: passport expiry, date of birth, departure. Index with `querySelectorAll` and pick by position, never `getElementById`.

## Comboboxes

- Set the value, dispatch an `input` event; the list filters and shows `mat-option`. Click the option.
- `countryCode` shows only digits after you type a digit: type `8`, then pick `84`. 

## Radios

Radios are `mat-radio-N-input` in page order. Read the question text next to each before clicking.

## Health questions

A yellow fever country question appears only after the first Next. Re-scan the page after each Next instead of assuming the first scan is complete.

## Page 2

- Mode of travel: AIR, then COMMERCIAL FLIGHT, then the airline (type like `SCOOT (TR)`, pick the option) plus the flight number.
- Accommodation type is also asked here.
- Review every value, then stop before final submit.
