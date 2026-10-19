# corp-delaware-gov (icis.corp.delaware.gov)

Delaware Division of Corporations franchise / LLC tax lookup: enter a file number, read what
is due for the entity. ASP.NET WebForms, no login, one CAPTCHA per lookup. Entry:
`https://icis.corp.delaware.gov/ecorp/logintax.aspx?FilingType=FranchiseTax`.

```js
const p = await learnings("corp-delaware-gov", "prepare", { fileNumber: "1234567" })
// show p.captchaPng to the human, get the characters back
await learnings("corp-delaware-gov", "submit", { targetId: p.targetId, captcha: "AB12X" })
```

## The CAPTCHA is always typed by a human

The page states that automated tools are prohibited, and the CAPTCHA is the gate. These tools
never solve, OCR, guess, or replay it. `prepare()` only exports the image so the agent can show
it; `submit()` only types the characters the human supplies. If the human is not there, stop
and ask; do not reach for an OCR model, a solver service, or a cached answer.

## The page

- Inputs: file number `#ctl00_ContentPlaceHolder1_txtPrimaryFileNo`, optional saved session
  `#ctl00_ContentPlaceHolder1_txtSessionNo`, CAPTCHA text
  `#ctl00_ContentPlaceHolder1_ecorpCaptcha1_txtCaptcha`, submit
  `#ctl00_ContentPlaceHolder1_btnContinue`.
- The CAPTCHA is an `<img>` whose id or src contains "captcha"
  (`CaptchaHandler.ashx?type=image&key=...`), a 200x50 PNG. It is same origin, so
  `canvas.toDataURL` exports it.
- A correct submit lands an LLC on `/ecorp/FranchiseTax/LlcFiling.aspx?eId=...`. The body text
  has `File Number:`, `Name:`, `Tax Year:` lines and a table
  `Tax Year | LP/LLC/GP Tax | Penalty | 1.5% Monthly Interest | Previous Credit/Balance | Amount Due`
  with rows like `2025 | $300.00 | $0.00 | $0.00 | ($300.00) | $0.00` and a `Total | $0.00` row.
  Parentheses mean a credit (negative).
- `parseTaxPage(text)` turns that into `{fileNumber, name, taxYear, rows, total}` with numbers
  parsed and credits negative. Any other page returns `{stop, text}`.

## Tax facts

- LLC annual tax is a flat $300, due June 1 for the prior tax year.
- Late: $200 penalty plus 1.5% interest per month on the unpaid balance.
- A row with `Amount Due` of $0.00 and a negative `Previous Credit/Balance` equal to the tax
  means the year is paid.
- Corporations use a different franchise tax page and formula; this learning was verified on an
  LLC only.

## Limits

- **The CAPTCHA key is per page load.** Do not reload or navigate between `prepare()` and
  `submit()`. A wrong answer returns the login page with a fresh image and may clear the file
  number: `submit()` returns `{stop: "captcha-rejected"}`, then call `prepare()` again and
  show the new image.
- **Reload is detected with a window marker.** `submit()` sets `window.__taxMarker` before the
  click and polls for it to vanish, since the postback destroys the execution context.
- **Result-page text is the contract.** If Delaware changes the table headers, `parseTaxPage`
  returns `unknown-page` rather than wrong numbers; update `tools/tax.test.mjs` first.

## Test

`node --test skills/cdp/learnings/corp-delaware-gov/tools/tax.test.mjs` (pure parser, no browser).

## Provenance

2026-10-19 LLC franchise tax lookup, driven live on the real page, then frozen here.
